/**
 * @fileoverview Render a check report as markdown (job summary, PR comment) and
 * as a self-contained HTML page.
 *
 * Tool names, arguments, file paths and scenario names come from repository
 * files and recorded runs. In markdown they are rendered as single-line code;
 * in HTML every value is escaped. Nothing from a trace is emitted as markup.
 */

import type { CheckReport, CheckScenarioResult, CheckStatus } from './check.js'
import type { ToolCallRecord } from './types.js'
import { stableStringify } from './normalize.js'

/** Hidden marker so a workflow can find and update its own comment. */
export const CHECK_COMMENT_MARKER = '<!-- agent-vcr:check -->'

const ICON: Record<CheckStatus, string> = { pass: '✅', review: '⚠️', fail: '❌', error: '❔' }
const HEADLINE = { pass: '✅ Agent checks passed', review: '⚠️ Agent checks passed; new paths need review', fail: '❌ Agent checks failed' }

function code(text: string, max = 400): string {
  // Backslashes before a pipe are dropped first: "\|" would otherwise become "\\|", which some
  // markdown renderers read as an escaped backslash followed by a live cell separator.
  const flat = text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/`/g, "'").replace(/\\+(?=\|)/g, '').replace(/\|/g, '\\|')
  return `\`${flat.length > max ? `${flat.slice(0, max - 3)}...` : flat}\``
}

function showCall(call: ToolCallRecord | null): string {
  if (call === null) return '(trace ended)'
  const args = stableStringify(call.args)
  return `${call.name}(${args.length > 100 ? `${args.slice(0, 97)}...` : args})`
}

function path(calls: ToolCallRecord[]): string {
  return calls.length === 0 ? '(no tool calls)' : calls.map((c) => c.name).join(' → ')
}

function tally(report: CheckReport): string {
  const c = report.counts
  const parts = [`${c.pass} passed`]
  if (c.review > 0) parts.push(`${c.review} to review`)
  if (c.fail > 0) parts.push(`${c.fail} failed`)
  if (c.error > 0) parts.push(`${c.error} could not be evaluated`)
  return parts.join(', ')
}

/** Markdown for a job summary or pull-request comment. */
export function formatCheckMarkdown(report: CheckReport): string {
  const lines: string[] = [CHECK_COMMENT_MARKER, `### ${HEADLINE[report.verdict]}`, '']
  lines.push(`${code(report.suite.name)}: ${tally(report)}.`)
  lines.push('')
  lines.push('| | Scenario | Result | Path |')
  lines.push('|---|---|---|---|')
  for (const s of report.scenarios) {
    lines.push(`| ${ICON[s.status]} | ${code(s.name, 80)} | ${s.status} | ${code(path(s.calls), 200)} |`)
  }

  const notable = report.scenarios.filter((s) => s.status !== 'pass')
  for (const s of notable) {
    lines.push('')
    lines.push(`**${ICON[s.status]} ${code(s.name, 80)}**`)
    lines.push('')
    if (s.status === 'error') {
      lines.push(`- Could not be evaluated: ${code(s.reason)}`)
      continue
    }
    for (const f of s.failures) lines.push(`- Violated: ${code(f.message)}`)
    if (s.status === 'review') lines.push('- New path that breaks no policy rule. Approve it with `agent-vcr accept` only if it is behaviour you want.')
    if (s.divergence) {
      lines.push(`- First divergence from golden at call ${s.divergence.index}`)
      lines.push(`  - expected: ${code(showCall(s.divergence.expected))}`)
      lines.push(`  - actual: ${code(showCall(s.divergence.actual))}`)
    }
  }

  lines.push('')
  lines.push(`<sub>${report.scenarios.length} scenario${report.scenarios.length === 1 ? '' : 's'} · suite sha256 ${code(report.suite.sha256.slice(0, 12))} · no model calls were made</sub>`)
  return lines.join('\n')
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function scenarioHtml(s: CheckScenarioResult): string {
  const rows: string[] = []
  rows.push(`<section class="s ${s.status}"><h2><span class="badge">${s.status}</span> ${esc(s.name)}</h2>`)
  rows.push(`<p>${esc(s.reason)}</p>`)
  if (s.failures.length > 0) {
    rows.push('<h3>Policy rules broken</h3><ul>')
    for (const f of s.failures) rows.push(`<li>${esc(f.message)}</li>`)
    rows.push('</ul>')
  }
  if (s.divergence) {
    rows.push(`<h3>First divergence from golden, at call ${s.divergence.index}</h3>`)
    rows.push(`<table><tr><th>Expected</th><td><code>${esc(showCall(s.divergence.expected))}</code></td></tr>`)
    rows.push(`<tr><th>Actual</th><td><code>${esc(showCall(s.divergence.actual))}</code></td></tr></table>`)
  }
  if (s.calls.length > 0) {
    rows.push('<h3>Tool calls</h3><ol start="0">')
    for (const c of s.calls) rows.push(`<li><code>${esc(c.name)}(${esc(stableStringify(c.args))})</code></li>`)
    rows.push('</ol>')
  }
  if (s.inputs.length > 0) {
    rows.push('<h3>Inputs</h3><table>')
    for (const i of s.inputs) rows.push(`<tr><th>${esc(i.role)}</th><td>${esc(i.path)}</td><td><code>${esc(i.sha256)}</code></td></tr>`)
    rows.push('</table>')
  }
  rows.push('</section>')
  return rows.join('\n')
}

const CSS = `
:root{--bg:#fff;--fg:#1c1c1e;--mute:#62646a;--line:#dcdde1;--card:#f6f7f9;--pass:#1a7f4b;--review:#9a6400;--fail:#b3261e;--error:#5d5fa8}
@media (prefers-color-scheme:dark){:root{--bg:#131416;--fg:#e9e9ec;--mute:#a1a3aa;--line:#33353b;--card:#1c1e22;--pass:#5fd396;--review:#f0b54a;--fail:#ff8a80;--error:#aeb0f5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 8px}
h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mute);margin:16px 0 6px}
.meta{color:var(--mute);font-size:.9rem;margin:0 0 24px;overflow-wrap:anywhere}
.s{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:16px;margin:0 0 16px}
.s.pass{border-left-color:var(--pass)}.s.review{border-left-color:var(--review)}.s.fail{border-left-color:var(--fail)}.s.error{border-left-color:var(--error)}
.badge{display:inline-block;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:999px;border:1px solid currentColor;vertical-align:middle}
.pass .badge{color:var(--pass)}.review .badge{color:var(--review)}.fail .badge{color:var(--fail)}.error .badge{color:var(--error)}
code{font:.85rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:4px 8px 4px 0;vertical-align:top;border-bottom:1px solid var(--line)}th{white-space:nowrap;color:var(--mute);font-weight:500}
ol,ul{margin:0;padding-left:24px}p{margin:0 0 8px}
`

/** A self-contained HTML page: no scripts, no external resources. */
export function formatCheckHtml(report: CheckReport): string {
  const title = { pass: 'Agent checks passed', review: 'Agent checks passed; new paths need review', fail: 'Agent checks failed' }[report.verdict]
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(report.suite.name)}: ${esc(title)}</title><style>${CSS}</style></head><body><main>`,
    `<h1>${esc(title)}</h1>`,
    `<p class="meta">${esc(report.suite.name)} · ${esc(tally(report))} · generated ${esc(report.generatedAt)} by ${esc(report.tool)} · ` +
      `suite <code>${esc(report.suite.sha256)}</code> · no model calls were made</p>`,
    ...report.scenarios.map(scenarioHtml),
    '<p class="meta">The sha256 values identify the exact files that were evaluated. They are not a signature and do not show who ran the check.</p>',
    '</main></body></html>',
    '',
  ].join('\n')
}
