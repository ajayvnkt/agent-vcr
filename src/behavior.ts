/**
 * @fileoverview Live behaviour checks: what a real model does now, sorted against
 * what the suite already knows.
 *
 * Replay with `ScriptedLlm` proves the orchestration around a model. By design it
 * cannot say whether a new prompt, model or tool schema would make a different
 * decision in the first place. This module is the optional second layer: run the
 * agent live a few times, then put every run into one of five buckets.
 *
 * - `golden`      matches the golden trace
 * - `accepted`    matches an approved alternative path
 * - `unreviewed`  a path nobody has seen before that breaks no stated policy
 * - `regression`  breaks a stated policy
 * - `error`       the run did not finish, so it says nothing about behaviour
 *
 * `unreviewed` is deliberately not called "harmless". Passing policy shows only
 * that no written rule was broken; whether the new path is acceptable is a
 * person's call, made explicitly with `addVariant`. With no policy at all, every
 * unknown path lands here and the report says that nothing was checked.
 *
 * Policy is checked first and always wins. A run that matches the golden trace
 * but violates policy is a regression: the policy was tightened after the trace
 * was recorded, and the stale trace must not vouch for it.
 *
 * "Matches" follows `mode`. In the default `exact` mode it means identical. In
 * `subsequence` mode a run matches when it contains the known path in order, so
 * extra calls are allowed and only policy stands between them and a pass.
 */

import { createHash } from 'node:crypto'
import type { CompareMode, ToolCallRecord } from './types.js'
import type { AssertionFailure, TraceAssertion } from './assert.js'
import { assertTrace } from './assert.js'
import { compareTraces } from './diff.js'
import { stableStringify } from './normalize.js'
import { firstDivergence } from './stability.js'
import { matchVariants } from './variants.js'
import type { Variant } from './variants.js'

export type BehaviorClass = 'golden' | 'accepted' | 'unreviewed' | 'regression' | 'error'

export type BehaviorVerdict = 'unchanged' | 'review' | 'regression' | 'inconclusive'

/** Everything the suite already knows about one scenario. */
export type BehaviorBaseline = {
  golden: ToolCallRecord[]
  /** Approved alternative paths. */
  variants?: Variant[]
  /** Rules that hold on every path. Without one, nothing can be called a regression. */
  policy?: TraceAssertion
  /** How a run is matched against golden and variants. Default `exact`. */
  mode?: CompareMode
}

/** Where a run first left the golden trace. `null` on a side means that trace had ended. */
export type BehaviorDivergence = {
  index: number
  expected: ToolCallRecord | null
  actual: ToolCallRecord | null
}

export type RunClassification = {
  runIndex: number
  class: BehaviorClass
  calls: ToolCallRecord[]
  /** Name of the approved path that matched, when one did. */
  variant: string | null
  /** First difference from the golden trace, or null when there is none. */
  divergence: BehaviorDivergence | null
  /** Policy failures. Non-empty exactly when `class` is `regression`. */
  failures: AssertionFailure[]
  /** Why the run did not finish. Set exactly when `class` is `error`. */
  error?: string
  reason: string
}

/** Runs that took the same path, grouped. */
export type BehaviorPath = {
  /** Stable short id for the path, derived from its calls. */
  id: string
  calls: ToolCallRecord[]
  count: number
  share: number
  runIndexes: number[]
  divergence: BehaviorDivergence | null
  failures: AssertionFailure[]
}

export type BehaviorReport = {
  verdict: BehaviorVerdict
  runs: number
  counts: Record<BehaviorClass, number>
  classifications: RunClassification[]
  /** Distinct unreviewed paths, most frequent first. Candidates to approve or reject. */
  newPaths: BehaviorPath[]
  /** Distinct policy-breaking paths, most frequent first. */
  regressions: BehaviorPath[]
  /** Distinct tool-call sequences among the runs that finished. */
  distinctTraces: number
  hasPolicy: boolean
  /** Problems with the baseline itself, e.g. a golden trace that breaks current policy. */
  baselineIssues: string[]
  summary: string
}

function traceKey(calls: ToolCallRecord[]): string {
  return stableStringify(calls.map((c) => ({ name: c.name, args: c.args })))
}

/** Short stable id for a path, so a PR comment and an `accept` command can name the same thing. */
export function pathId(calls: ToolCallRecord[]): string {
  return createHash('sha256').update(traceKey(calls)).digest('hex').slice(0, 8)
}

function divergenceFrom(golden: ToolCallRecord[], actual: ToolCallRecord[]): BehaviorDivergence | null {
  const index = firstDivergence(golden, actual)
  if (index === null) return null
  return { index, expected: golden[index] ?? null, actual: actual[index] ?? null }
}

/**
 * Does a policy contain at least one rule? `{}` and `{ forbid: [] }` enforce
 * nothing, and a report must not say "no policy was broken" on their strength.
 */
export function policyHasRules(policy: TraceAssertion | undefined): boolean {
  if (!policy) return false
  const lists = [policy.sequence, policy.includes, policy.forbid, policy.ordering, policy.requires]
  return (
    lists.some((l) => Array.isArray(l) && l.length > 0) ||
    policy.maxCalls !== undefined ||
    policy.maxCallsPerTool !== undefined ||
    policy.grounding !== undefined ||
    policy.survival !== undefined
  )
}

/** Classify one finished run against the baseline. */
export function classifyRun(
  calls: ToolCallRecord[],
  baseline: BehaviorBaseline,
  runIndex = 0,
): RunClassification {
  const mode: CompareMode = baseline.mode ?? 'exact'
  if (mode === 'subsequence' && baseline.golden.length === 0) {
    // An empty trace is a subsequence of everything, so every run would "match".
    throw new Error('classifyRun: an empty golden trace cannot be used in subsequence mode')
  }
  const exact = mode === 'exact'
  const failures = baseline.policy ? assertTrace(calls, baseline.policy) : []
  const base = { runIndex, calls, divergence: divergenceFrom(baseline.golden, calls) }
  // A run that matched a known path has not diverged in the sense the report means.
  const known = { runIndex, calls, divergence: null }

  if (failures.length > 0) {
    return {
      ...base,
      class: 'regression',
      variant: null,
      failures,
      reason: failures.map((f) => f.message).join('; '),
    }
  }

  if (compareTraces(baseline.golden, calls, { mode }).ok) {
    return {
      ...known,
      class: 'golden',
      variant: null,
      failures: [],
      reason: exact ? 'matches the golden trace' : 'contains the golden trace in order (subsequence mode; extra calls allowed)',
    }
  }

  const variants = baseline.variants ?? []
  if (variants.length > 0) {
    const match = matchVariants(calls, variants, { mode })
    if (match.matched) {
      return {
        ...known,
        class: 'accepted',
        variant: match.variant,
        failures: [],
        reason: exact
          ? `matches approved path "${match.variant}"`
          : `contains approved path "${match.variant}" in order (subsequence mode; extra calls allowed)`,
      }
    }
  }

  return {
    ...base,
    class: 'unreviewed',
    variant: null,
    failures: [],
    reason: policyHasRules(baseline.policy)
      ? 'new path that breaks no stated policy; needs a person to approve or reject it'
      : 'new path; no policy rules were supplied, so nothing was checked',
  }
}

function groupPaths(items: RunClassification[], total: number): BehaviorPath[] {
  const groups = new Map<string, BehaviorPath>()
  for (const item of items) {
    const key = traceKey(item.calls)
    const hit = groups.get(key)
    if (hit) {
      hit.count++
      hit.runIndexes.push(item.runIndex)
    } else {
      groups.set(key, {
        id: pathId(item.calls),
        calls: item.calls,
        count: 1,
        share: 0,
        runIndexes: [item.runIndex],
        divergence: item.divergence,
        failures: item.failures,
      })
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, share: g.count / total }))
    .sort((a, b) => b.count - a.count)
}

/** Does the baseline itself still satisfy the policy it is being used to enforce? */
function checkBaseline(baseline: BehaviorBaseline): string[] {
  if (!baseline.policy) return []
  const issues: string[] = []
  const golden = assertTrace(baseline.golden, baseline.policy)
  if (golden.length > 0) {
    issues.push(`the golden trace breaks current policy: ${golden.map((f) => f.message).join('; ')}`)
  }
  for (const v of baseline.variants ?? []) {
    const bad = assertTrace(v.calls, baseline.policy)
    if (bad.length > 0) {
      issues.push(`approved path "${v.name}" breaks current policy: ${bad.map((f) => f.message).join('; ')}`)
    }
  }
  return issues
}

/** A run result as handed to `classifyBehavior`: the calls it made, or why it did not finish. */
export type BehaviorRun = { calls: ToolCallRecord[] } | { error: string }

/**
 * Classify a batch of runs of one scenario and reduce them to a verdict.
 *
 * Verdict order is fixed: any policy break is `regression`; otherwise any run
 * that did not finish makes the whole check `inconclusive`, because a batch with
 * holes in it cannot support "unchanged"; otherwise any unseen path is `review`;
 * otherwise `unchanged`.
 */
export function classifyBehavior(runs: BehaviorRun[], baseline: BehaviorBaseline): BehaviorReport {
  if (runs.length === 0) throw new Error('classifyBehavior: need at least one run')

  const classifications: RunClassification[] = runs.map((run, runIndex) => {
    if ('error' in run) {
      return {
        runIndex,
        class: 'error' as const,
        calls: [],
        variant: null,
        divergence: null,
        failures: [],
        error: run.error,
        reason: `run did not finish: ${run.error}`,
      }
    }
    return classifyRun(run.calls, baseline, runIndex)
  })

  const counts: Record<BehaviorClass, number> = { golden: 0, accepted: 0, unreviewed: 0, regression: 0, error: 0 }
  for (const c of classifications) counts[c.class]++

  const finished = classifications.filter((c) => c.class !== 'error')
  const verdict: BehaviorVerdict =
    counts.regression > 0 ? 'regression' : counts.error > 0 ? 'inconclusive' : counts.unreviewed > 0 ? 'review' : 'unchanged'

  const report: BehaviorReport = {
    verdict,
    runs: runs.length,
    counts,
    classifications,
    newPaths: groupPaths(classifications.filter((c) => c.class === 'unreviewed'), runs.length),
    regressions: groupPaths(classifications.filter((c) => c.class === 'regression'), runs.length),
    distinctTraces: new Set(finished.map((c) => traceKey(c.calls))).size,
    hasPolicy: policyHasRules(baseline.policy),
    baselineIssues: checkBaseline(baseline),
    summary: '',
  }
  report.summary = describeBehavior(report)
  return report
}

/**
 * An approximate 95% interval for the true rate behind `k` events in `n` independent runs.
 *
 * Five clean runs do not show that an agent never misbehaves. They are
 * consistent with it misbehaving in up to 45% of runs. Reporting the interval
 * next to the count keeps a small batch from being read as proof.
 *
 * At the edges (k = 0 or k = n) it returns the exact one-sided 95% bound, so one
 * end is 0 or 1 and the other is a bound, not half of a two-sided interval. In
 * between it returns the two-sided Wilson score interval, which is approximate:
 * for small n and rates near 0 or 1 its true coverage can fall to roughly 85%.
 * Report it as approximate.
 *
 * It assumes the runs are independent and alike. Repeated runs of one scenario
 * usually are, but a shared cache, a rate limit or a provider incident that
 * touches several runs at once breaks that, and the interval is then too narrow.
 */
export function rateInterval(k: number, n: number): { low: number; high: number } {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) {
    throw new Error('rateInterval: need integers with 0 <= k <= n and n >= 1')
  }
  if (k === 0) return { low: 0, high: 1 - Math.pow(0.05, 1 / n) }
  if (k === n) return { low: Math.pow(0.05, 1 / n), high: 1 }
  const z = 1.959963984540054
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One-paragraph plain-English read of a behaviour report. */
export function describeBehavior(r: BehaviorReport): string {
  const parts: string[] = []
  const known = r.counts.golden + r.counts.accepted

  if (r.verdict === 'regression') {
    parts.push(
      `${r.counts.regression} of ${plural(r.runs, 'run')} broke policy, across ${plural(r.regressions.length, 'distinct path')}.`,
    )
  } else if (r.verdict === 'inconclusive') {
    parts.push(
      `${r.counts.error} of ${plural(r.runs, 'run')} did not finish, so this check cannot say the behaviour is unchanged.`,
    )
  } else if (r.verdict === 'review') {
    parts.push(
      `${r.counts.unreviewed} of ${plural(r.runs, 'run')} took ${plural(r.newPaths.length, 'path')} nobody has approved.${r.hasPolicy ? ' No stated policy was broken.' : ''}`,
    )
  } else {
    parts.push(`All ${plural(r.runs, 'run')} matched the golden trace or an approved path.`)
  }

  if (r.verdict !== 'unchanged' && known > 0) {
    parts.push(`${known} matched a known path.`)
  }
  if (r.verdict === 'regression' && r.counts.unreviewed > 0) {
    parts.push(`${r.counts.unreviewed} more took an unapproved path without breaking policy.`)
  }
  if (!r.hasPolicy) {
    parts.push('No policy rules were supplied, so no run could be checked for a regression.')
  }
  if (r.baselineIssues.length > 0) {
    parts.push(`The baseline needs attention: ${r.baselineIssues.join(' ')}`)
  }
  return parts.join(' ')
}

export type BehaviorCheckOptions = {
  /** How many live runs to make. Default 5. */
  runs?: number
  /** Run the agent once, live, and return the tool calls it made. */
  collect: (runIndex: number) => Promise<ToolCallRecord[]>
  baseline: BehaviorBaseline
  /** Called after each run is classified. */
  onRun?: (result: RunClassification) => void
}

/**
 * Run the agent live `runs` times and classify the results.
 *
 * Runs are sequential on purpose: local models serve one request at a time, and
 * hosted ones rate-limit bursts. A run that throws is recorded as `error`, not
 * dropped, so a flaky endpoint cannot turn into a quiet pass.
 */
export async function runBehaviorCheck(options: BehaviorCheckOptions): Promise<BehaviorReport> {
  const n = options.runs ?? 5
  if (!Number.isInteger(n) || n < 1) throw new Error('runBehaviorCheck: runs must be a positive integer')

  const results: BehaviorRun[] = []
  for (let i = 0; i < n; i++) {
    let run: BehaviorRun
    try {
      run = { calls: await options.collect(i) }
    } catch (e) {
      run = { error: e instanceof Error ? e.message : String(e) }
    }
    results.push(run)
    if (options.onRun) {
      options.onRun(
        'error' in run
          ? {
              runIndex: i,
              class: 'error',
              calls: [],
              variant: null,
              divergence: null,
              failures: [],
              error: run.error,
              reason: `run did not finish: ${run.error}`,
            }
          : classifyRun(run.calls, options.baseline, i),
      )
    }
  }
  return classifyBehavior(results, options.baseline)
}
