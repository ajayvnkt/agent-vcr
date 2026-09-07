/**
 * @fileoverview Reporters — console, GitHub PR comment, JSON.
 *
 * A failing suite has to answer three questions in the order a reader asks them:
 * did it pass, what broke, and where do I look. Most agent tooling answers the
 * first, dumps a trace for the second, and leaves the third to the reader.
 *
 * So every failure line here carries the scenario, the turn, and the specific
 * rule that broke — and the summary leads with the *reason* the gate failed,
 * which for a long-horizon agent is often "it passed but not consistently"
 * rather than a red test.
 */

import type { SuiteResult, SuiteScenarioOutcome } from './suite.js'
import type { ScenarioRunResult } from './scenario.js'

const TICK = '✓'
const CROSS = '✗'
const WARN = '~'

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function mark(o: SuiteScenarioOutcome): string {
  if (o.gated) return CROSS
  if (o.stability.verdict !== 'stable') return WARN
  return TICK
}

/** Collect every failure in a run as one flat, readable list. */
export function runFailures(result: ScenarioRunResult): string[] {
  const out: string[] = []
  for (const t of result.turns) {
    for (const f of t.traceFailures) out.push(`turn ${t.index + 1}: ${f.message}`)
    for (const f of t.outputFailures) out.push(`turn ${t.index + 1}: ${f}`)
    if (t.judge && !t.judge.pass) {
      out.push(`turn ${t.index + 1}: judge scored ${t.judge.score.toFixed(2)} — ${t.judge.reason}`)
    }
  }
  for (const f of result.overallFailures) out.push(`overall: ${f.message}`)
  if (result.variantMatch && !result.variantMatch.matched) {
    out.push(`paths: ${result.variantMatch.message}`)
  }
  if (result.contract && !result.contract.ok) {
    out.push(`contract: ${result.contract.message}`)
  }
  return out
}

/** Plain-text report for a terminal. */
export function formatConsole(suite: SuiteResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push('agent-vcr reliability suite')
  lines.push('─'.repeat(52))

  for (const o of suite.scenarios) {
    const stability =
      o.runs > 1 ? `  [${o.stability.verdict}, modal ${pct(o.stability.modalShare)}]` : ''
    lines.push(`${mark(o)} ${o.scenario}  ${o.passed}/${o.runs} runs${stability}`)

    const seen = new Set<string>()
    for (const r of o.results) {
      for (const f of runFailures(r)) {
        if (seen.has(f)) continue
        seen.add(f)
        lines.push(`    ${f}`)
      }
    }
    for (const reason of o.gateReasons) lines.push(`    gate: ${reason}`)
  }

  lines.push('─'.repeat(52))
  const t = suite.totals
  lines.push(
    `${suite.ok ? TICK : CROSS} ${suite.message}` +
      (t.unstableScenarios > 0 ? `  ·  ${t.unstableScenarios} unstable` : '') +
      (t.contractViolations > 0 ? `  ·  ${t.contractViolations} contract violations` : '') +
      (t.judgeCalls > 0 ? `  ·  ${t.judgeCalls} judge calls` : '  ·  0 judge calls'),
  )
  lines.push('')
  return lines.join('\n')
}

/**
 * Markdown for a GitHub PR comment.
 *
 * Detail goes inside `<details>`: a reviewer wants the verdict in the timeline
 * and the trace only when they choose to look. A comment that pastes forty tool
 * calls into the conversation gets collapsed by the reader instead, permanently.
 */
export function formatMarkdown(
  suite: SuiteResult,
  options?: { title?: string; commit?: string },
): string {
  const title = options?.title ?? 'agent-vcr reliability suite'
  const t = suite.totals
  const lines: string[] = []

  lines.push(`### ${suite.ok ? '✅' : '❌'} ${title}`)
  lines.push('')
  lines.push(suite.message + (options?.commit ? ` · \`${options.commit.slice(0, 7)}\`` : ''))
  lines.push('')
  lines.push('| | Scenario | Runs | Behaviour | Notes |')
  lines.push('|---|---|---|---|---|')

  for (const o of suite.scenarios) {
    const icon = o.gated ? '❌' : o.stability.verdict !== 'stable' ? '⚠️' : '✅'
    const behaviour =
      o.runs > 1
        ? `${o.stability.verdict} (${o.stability.distinctTraces} path${o.stability.distinctTraces === 1 ? '' : 's'})`
        : '—'
    const notes = o.gateReasons.length > 0 ? o.gateReasons.join('; ') : ''
    lines.push(`| ${icon} | \`${o.scenario}\` | ${o.passed}/${o.runs} | ${behaviour} | ${notes} |`)
  }

  const failing = suite.scenarios.filter((o) => o.gated)
  if (failing.length > 0) {
    lines.push('')
    lines.push('<details><summary>What broke</summary>')
    lines.push('')
    for (const o of failing) {
      lines.push(`**${o.scenario}**`)
      lines.push('')
      const seen = new Set<string>()
      for (const r of o.results) {
        for (const f of runFailures(r)) {
          if (seen.has(f)) continue
          seen.add(f)
          lines.push(`- ${f}`)
        }
      }
      // A scenario can fail the gate with no failing run at all — every run
      // passed, they just disagreed. Without this the section renders empty and
      // reads like a reporter bug rather than the finding it is.
      if (seen.size === 0) {
        for (const reason of o.gateReasons) lines.push(`- ${reason}`)
        if (o.stability.verdict !== 'stable') lines.push(`- ${o.stability.summary}`)
      }
      lines.push('')
    }
    lines.push('</details>')
  }

  const unstable = suite.scenarios.filter((o) => !o.gated && o.stability.verdict !== 'stable')
  if (unstable.length > 0) {
    lines.push('')
    lines.push('<details><summary>Passing, but not consistently</summary>')
    lines.push('')
    lines.push(
      'These scenarios passed every run but did not behave the same way twice. A pass rate cannot see this.',
    )
    lines.push('')
    for (const o of unstable) {
      lines.push(`- \`${o.scenario}\` — ${o.stability.summary}`)
    }
    lines.push('')
    lines.push('</details>')
  }

  lines.push('')
  lines.push(
    `<sub>${t.runs} runs · ${t.judgeCalls} judge call${t.judgeCalls === 1 ? '' : 's'} · ${t.unstableScenarios} unstable · ${t.contractViolations} contract violation${t.contractViolations === 1 ? '' : 's'}</sub>`,
  )
  return lines.join('\n')
}

/** Machine-readable result for dashboards and trend tracking. */
export function formatJson(suite: SuiteResult): string {
  return JSON.stringify(
    {
      ok: suite.ok,
      message: suite.message,
      totals: suite.totals,
      scenarios: suite.scenarios.map((o) => ({
        scenario: o.scenario,
        ok: !o.gated,
        runs: o.runs,
        passed: o.passed,
        passRate: o.passRate,
        gateReasons: o.gateReasons,
        stability: {
          verdict: o.stability.verdict,
          distinctTraces: o.stability.distinctTraces,
          modalShare: o.stability.modalShare,
          compactionAttributableShare: o.stability.compactionAttributableShare,
        },
        failures: [...new Set(o.results.flatMap((r) => runFailures(r)))],
      })),
    },
    null,
    2,
  )
}
