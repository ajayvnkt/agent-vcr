/**
 * @fileoverview Summary ablation — find which facts in a compaction summary are load-bearing.
 *
 * The open question in long-horizon agents is what a summary must preserve. It
 * cannot be answered by reading the summary: a faithful summary and a useful one
 * are different things, and usefulness is only observable in what the agent does
 * afterwards. Training answers it statistically, over many runs, without anyone
 * naming the rule.
 *
 * Replay answers it causally, in a handful of runs. Hold the recorded trajectory
 * fixed, remove one fact from the summary, resume from the cut, and diff the calls
 * that follow. Facts whose removal changes downstream behaviour are load-bearing;
 * the rest are prose. The surviving set is a compaction schema you can hand-write
 * into a cheaper, deterministic compactor.
 */

import type { CompareMode, ToolCallRecord } from './types.js'
import { compareTraces } from './diff.js'
import { firstDivergence } from './stability.js'

export type FactVerdict = {
  fact: string
  /** Removing this fact changed the downstream trace. */
  loadBearing: boolean
  /** Index of the first downstream call that changed, when it did. */
  firstDivergenceCall: number | null
  /** How many of `repeats` replays diverged after removing this fact. */
  divergedReplays: number
  replays: number
  reason: string | null
}

export type AblationReport = {
  facts: FactVerdict[]
  loadBearing: string[]
  droppable: string[]
  /** The minimal summary: only the facts whose removal changed behaviour. */
  compactionSchema: string
  /** Fraction of the original summary that turned out to matter. */
  signalRatio: number
  summary: string
}

export type AblationOptions = {
  /** Baseline downstream calls, recorded with the full summary. */
  baseline: ToolCallRecord[]
  /** The summary written at the cut. */
  summary: string
  /**
   * Resume the run from the cut with a mutated summary and return the calls
   * that follow. This is the only step that needs a live model.
   */
  replay: (mutatedSummary: string) => Promise<ToolCallRecord[]>
  /** Split the summary into candidate facts. Default: non-empty lines. */
  splitFacts?: (summary: string) => string[]
  /** Replays per fact — raise it when the model is sampled rather than greedy. Default 1. */
  repeats?: number
  /** How baseline and replay traces are compared. Default 'exact'. */
  compareMode?: CompareMode
}

/** Default fact splitter: non-empty lines, bullet markers stripped. */
export function splitByLines(summary: string): string[] {
  return summary
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0)
}

function joinFacts(facts: string[]): string {
  return facts.map((f) => `- ${f}`).join('\n')
}

/**
 * Remove each fact in turn, replay, and record whether downstream behaviour moved.
 *
 * Cost is `facts.length * repeats` model runs of the tail only — not the whole
 * trajectory — because everything before the cut is replayed from the recording.
 */
export async function ablateSummary(options: AblationOptions): Promise<AblationReport> {
  const split = options.splitFacts ?? splitByLines
  const repeats = Math.max(1, options.repeats ?? 1)
  const mode: CompareMode = options.compareMode ?? 'exact'
  const facts = split(options.summary)

  if (facts.length === 0) {
    throw new Error('ablateSummary: summary produced no facts to ablate')
  }

  const verdicts: FactVerdict[] = []

  for (let i = 0; i < facts.length; i++) {
    const held = facts[i]!
    const mutated = joinFacts(facts.filter((_, j) => j !== i))

    let divergedReplays = 0
    let firstAt: number | null = null
    let reason: string | null = null

    for (let r = 0; r < repeats; r++) {
      const actual = await options.replay(mutated)
      const diff = compareTraces(options.baseline, actual, { mode })
      if (!diff.ok) {
        divergedReplays++
        if (reason === null) reason = diff.reason
        const at = firstDivergence(options.baseline, actual)
        if (at !== null && (firstAt === null || at < firstAt)) firstAt = at
      }
    }

    verdicts.push({
      fact: held,
      loadBearing: divergedReplays > 0,
      firstDivergenceCall: firstAt,
      divergedReplays,
      replays: repeats,
      reason,
    })
  }

  const loadBearing = verdicts.filter((v) => v.loadBearing).map((v) => v.fact)
  const droppable = verdicts.filter((v) => !v.loadBearing).map((v) => v.fact)
  const signalRatio = loadBearing.length / facts.length

  const report: AblationReport = {
    facts: verdicts,
    loadBearing,
    droppable,
    compactionSchema: joinFacts(loadBearing),
    signalRatio,
    summary: '',
  }
  report.summary = describeAblation(report, facts.length)
  return report
}

/** Plain-English read of an ablation report. */
export function describeAblation(r: AblationReport, totalFacts: number): string {
  if (r.loadBearing.length === 0) {
    return `None of the ${totalFacts} facts changed downstream behaviour when removed. Either the summary is entirely redundant at this cut, or the tail is too short to be sensitive — extend the replay window before concluding the summary does not matter.`
  }
  if (r.loadBearing.length === totalFacts) {
    return `All ${totalFacts} facts are load-bearing: removing any one changed the calls that followed. Nothing here is safe to drop, and a tighter token budget will cost behaviour.`
  }
  return `${r.loadBearing.length} of ${totalFacts} facts are load-bearing (${Math.round(r.signalRatio * 100)}% signal). The other ${r.droppable.length} can be removed without changing a single downstream call. Use \`compactionSchema\` as the summary contract for this scenario, and treat any future summary that omits one of those facts as a regression.`
}
