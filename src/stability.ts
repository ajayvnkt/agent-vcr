/**
 * @fileoverview Run-to-run stability, and how much of the instability sits after a cut.
 *
 * A pass rate is a mean, and means hide the failure that actually matters in
 * long-horizon agents: the same task from the same starting state producing
 * different trajectories on different runs. Degradation there is bimodal — a run
 * either holds together or derails — so 66% can mean "reliably mediocre" or
 * "excellent two runs in three and catastrophic on the third", and the mean
 * cannot tell you which.
 *
 * `analyzeStability` takes k runs of one scenario and reports the distribution:
 * where trajectories first diverge, and what share of those divergences follow a
 * compaction closely enough to be attributable to it.
 */

import type { ToolCallRecord } from './types.js'
import type { CompactedRun } from './compaction.js'
import { callsEqual, stableStringify } from './normalize.js'

export type RunVerdict = 'stable' | 'drifting' | 'bimodal'

export type RunDivergence = {
  runIndex: number
  /** Index of the first call that differs from the modal trace, or null if identical. */
  firstDivergenceCall: number | null
  /** `atCall` of the nearest compaction at or before the divergence, if any. */
  nearestPriorCompaction: number | null
  /** Calls between that compaction and the divergence. */
  callsSinceCompaction: number | null
  /** True when the divergence falls inside `attributionWindow` calls of a cut. */
  attributable: boolean
}

export type StabilityReport = {
  runs: number
  /** Number of distinct call sequences observed. */
  distinctTraces: number
  /** The most common trace, and how often it occurred. */
  modalTrace: ToolCallRecord[]
  modalCount: number
  modalShare: number
  verdict: RunVerdict
  divergences: RunDivergence[]
  /** Of the runs that diverged, the share attributable to a compaction. */
  compactionAttributableShare: number
  /** Compactions per run. */
  compactionCounts: number[]
  /** Histogram of first-divergence call indices. */
  divergenceHistogram: Record<number, number>
  /** One-paragraph plain-English read of the numbers above. */
  summary: string
}

export type StabilityOptions = {
  /** Calls after a cut within which a divergence counts as caused by it. Default 5. */
  attributionWindow?: number
}

/** First index at which two call sequences differ, or null when one is a prefix-equal match. */
export function firstDivergence(a: ToolCallRecord[], b: ToolCallRecord[]): number | null {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (!callsEqual(a[i]!, b[i]!)) return i
  }
  if (a.length !== b.length) return n
  return null
}

function traceKey(calls: ToolCallRecord[]): string {
  return stableStringify(calls.map((c) => ({ name: c.name, args: c.args })))
}

function nearestPriorCut(run: CompactedRun, atCall: number): number | null {
  let best: number | null = null
  for (const c of run.compactions) {
    if (c.atCall <= atCall && (best === null || c.atCall > best)) best = c.atCall
  }
  return best
}

/**
 * Compare k runs of the same scenario against their modal trace.
 *
 * Runs are compared to the mode rather than to a golden trace on purpose: this
 * measures self-consistency, which is a separate question from correctness. A
 * scenario can be perfectly consistent and consistently wrong.
 */
export function analyzeStability(
  runs: CompactedRun[],
  options?: StabilityOptions,
): StabilityReport {
  if (runs.length === 0) throw new Error('analyzeStability: need at least one run')
  const window = options?.attributionWindow ?? 5

  const counts = new Map<string, { n: number; calls: ToolCallRecord[] }>()
  for (const r of runs) {
    const k = traceKey(r.calls)
    const hit = counts.get(k)
    if (hit) hit.n++
    else counts.set(k, { n: 1, calls: r.calls })
  }

  let modal = { n: 0, calls: runs[0]!.calls }
  for (const v of counts.values()) if (v.n > modal.n) modal = v

  const divergences: RunDivergence[] = runs.map((r, runIndex) => {
    const at = firstDivergence(modal.calls, r.calls)
    if (at === null) {
      return {
        runIndex,
        firstDivergenceCall: null,
        nearestPriorCompaction: null,
        callsSinceCompaction: null,
        attributable: false,
      }
    }
    const cut = nearestPriorCut(r, at)
    const since = cut === null ? null : at - cut
    return {
      runIndex,
      firstDivergenceCall: at,
      nearestPriorCompaction: cut,
      callsSinceCompaction: since,
      attributable: since !== null && since <= window,
    }
  })

  const diverged = divergences.filter((d) => d.firstDivergenceCall !== null)
  const attributable = diverged.filter((d) => d.attributable)
  const modalShare = modal.n / runs.length

  const histogram: Record<number, number> = {}
  for (const d of diverged) {
    const i = d.firstDivergenceCall!
    histogram[i] = (histogram[i] ?? 0) + 1
  }

  const verdict: RunVerdict =
    counts.size === 1 ? 'stable' : modalShare >= 0.85 ? 'drifting' : 'bimodal'

  const attributableShare = diverged.length === 0 ? 0 : attributable.length / diverged.length

  const report: StabilityReport = {
    runs: runs.length,
    distinctTraces: counts.size,
    modalTrace: modal.calls,
    modalCount: modal.n,
    modalShare,
    verdict,
    divergences,
    compactionAttributableShare: attributableShare,
    compactionCounts: runs.map((r) => r.compactions.length),
    divergenceHistogram: histogram,
    summary: '',
  }
  report.summary = describeStability(report, window)
  return report
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** Plain-English read of a stability report. */
export function describeStability(r: StabilityReport, window: number): string {
  const cuts = r.compactionCounts.reduce((a, b) => a + b, 0)
  const lines: string[] = []

  if (r.verdict === 'stable') {
    lines.push(
      `All ${r.runs} runs produced an identical ${r.modalTrace.length}-call trace. No run-to-run instability to explain.`,
    )
  } else if (r.verdict === 'drifting') {
    lines.push(
      `${r.modalCount} of ${r.runs} runs (${pct(r.modalShare)}) agree; ${r.distinctTraces} distinct traces overall. Low-level drift rather than collapse.`,
    )
  } else {
    lines.push(
      `Only ${r.modalCount} of ${r.runs} runs (${pct(r.modalShare)}) agree, across ${r.distinctTraces} distinct traces. This is the bimodal pattern: a mean pass rate will not describe this agent's behaviour.`,
    )
  }

  if (cuts === 0) {
    lines.push('No compactions occurred, so none of the variance is attributable to a context cut.')
  } else {
    const diverged = r.divergences.filter((d) => d.firstDivergenceCall !== null).length
    lines.push(
      `${cuts} compaction${cuts === 1 ? '' : 's'} across ${r.runs} runs. Of the ${diverged} diverging run${diverged === 1 ? '' : 's'}, ${pct(r.compactionAttributableShare)} first diverged within ${window} calls of a cut.`,
    )
    if (r.compactionAttributableShare >= 0.5 && diverged > 0) {
      lines.push(
        'Compaction is the leading suspect. Run an ablation on the summary at that cut to find which facts are load-bearing.',
      )
    }
  }

  return lines.join(' ')
}
