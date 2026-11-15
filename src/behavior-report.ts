/**
 * @fileoverview Render a behaviour report for a terminal or a pull request.
 *
 * The pull-request comment answers the reviewer's questions in the order they
 * ask them: did behaviour change, where did it first leave the golden trace,
 * which rule did it break, and what do I do about it. Full traces sit inside
 * `<details>` so the verdict stays readable in the timeline.
 */

import type { ToolCallRecord } from './types.js'
import type { BehaviorDivergence, BehaviorPath, BehaviorReport, BehaviorVerdict } from './behavior.js'
import { describeBehavior, rateInterval } from './behavior.js'
import { stableStringify } from './normalize.js'

/** Hidden marker so a workflow can find and update its own comment instead of posting a new one. */
export const BEHAVIOR_COMMENT_MARKER = '<!-- agent-vcr:behavior -->'

const HEADLINE: Record<BehaviorVerdict, string> = {
  unchanged: '✅ Agent behaviour unchanged',
  review: '⚠️ Agent behaviour changed: review needed',
  regression: '❌ Agent behaviour regressed',
  inconclusive: '❔ Agent behaviour check inconclusive',
}

function showCall(call: ToolCallRecord | null): string {
  if (call === null) return '(trace ended)'
  const args = stableStringify(call.args)
  return `${call.name}(${args.length > 100 ? `${args.slice(0, 97)}...` : args})`
}

/**
 * Make text safe to place inside an inline code span or a fenced block.
 *
 * Tool arguments and error text come from a live model or a remote API, and this
 * output is posted to a pull request. Everything of that kind is rendered as
 * code, with backticks removed so it cannot close the span and inject markdown,
 * mentions or HTML into the comment.
 */
function cell(text: string, max = 600): string {
  // Every line terminator CommonMark or a browser recognises, including a lone CR.
  const flat = text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/`/g, "'").replace(/\\+(?=\|)/g, '').replace(/\|/g, '\\|')
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function arrows(calls: ToolCallRecord[]): string {
  return calls.length === 0 ? '(no tool calls)' : calls.map((c) => c.name).join(' → ')
}

function divergenceLines(d: BehaviorDivergence | null): string[] {
  if (d === null) return []
  return [
    `- First divergence from golden at call ${d.index}`,
    `  - expected: \`${cell(showCall(d.expected))}\``,
    `  - actual: \`${cell(showCall(d.actual))}\``,
  ]
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

export type BehaviorMarkdownOptions = {
  title?: string
  /** Scenario name shown under the headline. */
  scenario?: string
  /** Fingerprint components that changed and triggered this check, e.g. `['system', 'tools']`. */
  changed?: string[]
  commit?: string
  /**
   * Builds the command a reviewer runs to approve a new path. Receives the path
   * and its 1-based position. Omit to leave the command out.
   */
  acceptCommand?: (path: BehaviorPath, position: number) => string
}

/** Markdown for a GitHub pull-request comment. */
export function formatBehaviorMarkdown(report: BehaviorReport, options?: BehaviorMarkdownOptions): string {
  const lines: string[] = [BEHAVIOR_COMMENT_MARKER]
  lines.push(`### ${options?.title !== undefined ? cell(options.title).replace(/[<>\[\]@]/g, '') : HEADLINE[report.verdict]}`)
  lines.push('')

  const context: string[] = []
  if (options?.scenario) context.push(`scenario \`${cell(options.scenario)}\``)
  if (options?.changed?.length) context.push(`triggered by a change to ${options.changed.map((c) => `\`${cell(c)}\``).join(', ')}`)
  if (options?.commit) context.push(`\`${cell(options.commit.slice(0, 7))}\``)
  if (context.length > 0) {
    lines.push(context.join(' · '))
    lines.push('')
  }

  // The stored summary quotes baseline problems, which carry names from repository
  // files. Those go in their own section below, as code; the paragraph here is
  // rebuilt from counts alone so nothing unescaped reaches the comment.
  lines.push(describeBehavior({ ...report, baselineIssues: [] }))
  lines.push('')
  lines.push('| Outcome | Runs |')
  lines.push('|---|---|')
  lines.push(`| Matches golden trace | ${report.counts.golden} |`)
  lines.push(`| Matches an approved path | ${report.counts.accepted} |`)
  lines.push(`| New path, ${report.hasPolicy ? 'no policy broken' : 'not checked (no policy)'} | ${report.counts.unreviewed} |`)
  lines.push(`| Policy broken | ${report.counts.regression} |`)
  if (report.counts.error > 0) lines.push(`| Did not finish | ${report.counts.error} |`)

  if (report.regressions.length > 0) {
    lines.push('')
    lines.push('#### Policy regressions')
    for (const path of report.regressions) {
      lines.push('')
      lines.push(`**\`${path.id}\`** · ${path.count} of ${report.runs} runs (${pct(path.share)}): \`${cell(arrows(path.calls))}\``)
      lines.push('')
      for (const f of path.failures) lines.push(`- Violated: \`${cell(f.message)}\``)
      lines.push(...divergenceLines(path.divergence))
    }
  }

  if (report.newPaths.length > 0) {
    lines.push('')
    lines.push('#### New paths to approve or reject')
    report.newPaths.forEach((path, i) => {
      lines.push('')
      lines.push(`**\`${path.id}\`** · ${path.count} of ${report.runs} runs (${pct(path.share)}): \`${cell(arrows(path.calls))}\``)
      lines.push('')
      lines.push(...divergenceLines(path.divergence))
      const command = options?.acceptCommand?.(path, i + 1)
      if (command) {
        lines.push('- To approve this path:')
        lines.push('')
        lines.push('  ```sh')
        lines.push(`  ${command}`)
        lines.push('  ```')
      }
    })
    lines.push('')
    lines.push(
      report.hasPolicy
        ? 'These paths broke no stated policy. That does not make them correct: approve one only if it is behaviour you want.'
        : 'No policy was supplied, so these paths were not checked against anything. Read them before approving.',
    )
  }

  const errors = report.classifications.filter((c) => c.class === 'error')
  if (errors.length > 0) {
    lines.push('')
    lines.push('<details><summary>Runs that did not finish</summary>')
    lines.push('')
    for (const e of errors) lines.push(`- run ${e.runIndex}: \`${cell(e.error ?? 'unknown error', 300)}\``)
    lines.push('')
    lines.push('</details>')
  }

  if (report.baselineIssues.length > 0) {
    lines.push('')
    lines.push('#### Baseline needs attention')
    lines.push('')
    for (const issue of report.baselineIssues) lines.push(`- \`${cell(issue)}\``)
  }

  const detailed = [...report.regressions, ...report.newPaths]
  if (detailed.length > 0) {
    lines.push('')
    lines.push('<details><summary>Full traces</summary>')
    lines.push('')
    for (const path of detailed) {
      lines.push(`\`${path.id}\``)
      lines.push('')
      lines.push('```')
      path.calls.forEach((c, i) => lines.push(`${i}. ${cell(showCall(c))}`))
      if (path.calls.length === 0) lines.push('(no tool calls)')
      lines.push('```')
      lines.push('')
    }
    lines.push('</details>')
  }

  lines.push('')
  lines.push(`<sub>${report.runs} live run${report.runs === 1 ? '' : 's'} · ${report.distinctTraces} distinct path${report.distinctTraces === 1 ? '' : 's'}</sub>`)
  const finished = report.runs - report.counts.error
  if (report.hasPolicy && finished > 0) {
    const { low, high } = rateInterval(report.counts.regression, finished)
    const pc = (x: number): string => (x > 0 && x < 0.01 ? 'under 1%' : x > 0.99 && x < 1 ? 'over 99%' : `${Math.round(x * 100)}%`)
    const broke = report.counts.regression
    const runsWord = `finished run${finished === 1 ? '' : 's'}`
    lines.push('')
    lines.push(
      broke === 0
        ? `<sub>No policy break in ${finished} ${runsWord}. That is consistent with a true break rate anywhere up to ${pc(high)} (95% bound, assuming independent runs); more runs narrow it.</sub>`
        : broke === finished
          ? `<sub>Policy broken in ${broke} of ${finished} ${runsWord}. The true break rate is plausibly at least ${pc(low)} (95% bound, assuming independent runs).</sub>`
          : `<sub>Policy broken in ${broke} of ${finished} ${runsWord}. The true rate is plausibly between ${pc(low)} and ${pc(high)} (approximate 95% interval, assuming independent runs).</sub>`,
    )
  }
  return lines.join('\n')
}

/** Plain-text summary for a terminal. */
export function formatBehaviorConsole(report: BehaviorReport): string {
  const lines: string[] = [HEADLINE[report.verdict], report.summary, '']
  for (const c of report.classifications) {
    lines.push(`  run ${c.runIndex}: ${c.class.padEnd(10)} ${c.class === 'error' ? c.reason : arrows(c.calls)}`)
  }
  for (const path of report.regressions) {
    lines.push('', `  regression ${path.id} (${path.count}/${report.runs}):`)
    for (const f of path.failures) lines.push(`    violated: ${f.message}`)
    if (path.divergence) {
      lines.push(`    first divergence at call ${path.divergence.index}: expected ${showCall(path.divergence.expected)}, got ${showCall(path.divergence.actual)}`)
    }
  }
  for (const path of report.newPaths) {
    lines.push('', `  new path ${path.id} (${path.count}/${report.runs}): ${arrows(path.calls)}`)
    if (path.divergence) {
      lines.push(`    first divergence at call ${path.divergence.index}: expected ${showCall(path.divergence.expected)}, got ${showCall(path.divergence.actual)}`)
    }
  }
  for (const issue of report.baselineIssues) lines.push('', `  baseline: ${issue}`)
  return lines.join('\n')
}
