/**
 * @fileoverview Multi-turn scenarios — the unit a suite is written in.
 *
 * A single golden trace tests one prompt. Real agents are conversations: the
 * user asks, the agent clarifies, the user answers, and the tools that matter
 * fire on turn three. Most orchestration bugs live in exactly that shape — an
 * agent that re-asks for something it already has, or acts before it clarified.
 *
 * A `Scenario` is a list of turns with per-turn expectations, plus whole-run
 * checks (accepted paths, a summary contract). `runScenario` executes it once;
 * `runScenarioRepeated` executes it k times and adds the stability read, because
 * for a long-horizon agent "did it pass" and "does it pass reliably" are
 * different questions and only the second one predicts production.
 *
 * The agent itself is injected. agent-vcr does not want to own your framework —
 * you bring something that answers a user message, it brings the discipline.
 */

import type { ToolCallRecord } from './types.js'
import type { AssertionFailure, TraceAssertion } from './assert.js'
import type { Judge, JudgeVerdict, OutputAssertion } from './judge.js'
import type { CompactionEvent } from './compaction.js'
import type { SummaryContract } from './contract.js'
import type { StabilityReport } from './stability.js'
import type { Variant, VariantMatch } from './variants.js'
import { assertTrace } from './assert.js'
import { assertOutput } from './judge.js'
import { verifyRunContract } from './contract.js'
import { matchVariants } from './variants.js'
import { analyzeStability } from './stability.js'

/** What the agent returns for one user message. */
export type TurnResult = {
  calls: ToolCallRecord[]
  finalContent: string | null
  /** Present when the agent compacted during this turn. */
  compactions?: CompactionEvent[]
}

/** A live agent, holding its own conversation state across turns. */
export type ScenarioAgent = {
  send: (userMessage: string) => Promise<TurnResult>
}

/** Built fresh for each run, so runs don't share state. */
export type ScenarioAgentFactory = () => ScenarioAgent | Promise<ScenarioAgent>

export type Turn = {
  user: string
  /** Deterministic checks on this turn's tool calls. */
  expect?: TraceAssertion
  /** Deterministic checks on this turn's final message. */
  output?: OutputAssertion
  /** Graded only when a judge is configured AND everything free has passed. */
  rubric?: string
}

export type Scenario = {
  name: string
  turns: Turn[]
  /**
   * Agent for this scenario, overriding the suite-level one. Real suites test
   * more than one agent — a support bot and a billing bot in the same run — so
   * the scenario owns its subject rather than the runner assuming one exists.
   */
  agent?: ScenarioAgentFactory
  /** Accepted whole-run tool paths. Checked against every call in the scenario. */
  variants?: Variant[]
  /** Facts every compaction summary in this scenario must preserve. */
  summaryContract?: SummaryContract
  /** Checks applied to the concatenation of every turn's calls. */
  expectOverall?: TraceAssertion
  /** Runs for the stability read. Default 1. */
  runs?: number
}

/** The deepest tier a run reached before failing, or completed. */
export type Tier = 'structural' | 'output' | 'variants' | 'contract' | 'judge'

export type TurnOutcome = {
  index: number
  user: string
  calls: ToolCallRecord[]
  finalContent: string | null
  traceFailures: AssertionFailure[]
  outputFailures: string[]
  judge: JudgeVerdict | null
  ok: boolean
}

export type ScenarioRunResult = {
  scenario: string
  ok: boolean
  turns: TurnOutcome[]
  allCalls: ToolCallRecord[]
  compactions: CompactionEvent[]
  variantMatch: VariantMatch | null
  contract: { ok: boolean; message: string } | null
  overallFailures: AssertionFailure[]
  /** Deepest tier actually evaluated — everything past a failure is skipped. */
  reachedTier: Tier
  /** Judge calls made. Zero on a clean deterministic run with no judge. */
  judgeCalls: number
}

export type RunScenarioOptions = {
  /** Default agent, used by any scenario that does not bring its own. */
  agent?: ScenarioAgentFactory
  judge?: Judge
  /** Grade rubrics even when a cheaper tier already failed. Default false. */
  alwaysJudge?: boolean
  estimateTokens?: (text: string) => number
}

/**
 * Run a scenario once, tier by tier.
 *
 * Turns always all execute — you cannot skip turn 3 because turn 1 failed, the
 * conversation has to happen. What the tiers gate is *grading*: the judge is
 * only asked about a run that already passed everything free.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions,
): Promise<ScenarioRunResult> {
  if (scenario.turns.length === 0) {
    throw new Error(`runScenario: scenario "${scenario.name}" has no turns`)
  }
  const factory = scenario.agent ?? options.agent
  if (!factory) {
    throw new Error(
      `runScenario: scenario "${scenario.name}" has no agent — set scenario.agent or pass options.agent`,
    )
  }

  const agent = await factory()
  const turns: TurnOutcome[] = []
  const allCalls: ToolCallRecord[] = []
  const compactions: CompactionEvent[] = []

  // ── Tiers 1 and 2: execute and check, free ────────────────────────────────
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]!
    const result = await agent.send(turn.user)

    allCalls.push(...result.calls)
    if (result.compactions?.length) compactions.push(...result.compactions)

    const traceFailures = turn.expect ? assertTrace(result.calls, turn.expect) : []
    const outputFailures = turn.output ? assertOutput(result.finalContent, turn.output) : []

    turns.push({
      index: i,
      user: turn.user,
      calls: result.calls,
      finalContent: result.finalContent,
      traceFailures,
      outputFailures,
      judge: null,
      ok: traceFailures.length === 0 && outputFailures.length === 0,
    })
  }

  const overallFailures = scenario.expectOverall
    ? assertTrace(allCalls, scenario.expectOverall)
    : []

  let reachedTier: Tier = turns.some((t) => t.traceFailures.length > 0) || overallFailures.length > 0
    ? 'structural'
    : 'output'

  let ok = turns.every((t) => t.ok) && overallFailures.length === 0

  // ── Tier 3: accepted paths ────────────────────────────────────────────────
  let variantMatch: VariantMatch | null = null
  if (ok && scenario.variants?.length) {
    reachedTier = 'variants'
    variantMatch = matchVariants(allCalls, scenario.variants)
    if (!variantMatch.matched) ok = false
  }

  // ── Tier 4: summary contract ──────────────────────────────────────────────
  let contract: { ok: boolean; message: string } | null = null
  if (ok && scenario.summaryContract) {
    reachedTier = 'contract'
    const r = verifyRunContract(compactions, scenario.summaryContract, {
      estimateTokens: options.estimateTokens,
    })
    contract = { ok: r.ok, message: r.message }
    if (!r.ok) ok = false
  }

  // ── Tier 5: the judge, only if everything free passed ─────────────────────
  let judgeCalls = 0
  const wantsJudge = scenario.turns.some((t) => t.rubric)
  if (options.judge && wantsJudge && (ok || options.alwaysJudge)) {
    reachedTier = 'judge'
    for (let i = 0; i < scenario.turns.length; i++) {
      const rubric = scenario.turns[i]!.rubric
      if (!rubric) continue
      const outcome = turns[i]!
      const verdict = await options.judge.evaluate({
        user: outcome.user,
        output: outcome.finalContent,
        calls: outcome.calls,
        rubric,
      })
      judgeCalls++
      outcome.judge = verdict
      if (!verdict.pass) {
        outcome.ok = false
        ok = false
      }
    }
  }

  return {
    scenario: scenario.name,
    ok,
    turns,
    allCalls,
    compactions,
    variantMatch,
    contract,
    overallFailures,
    reachedTier,
    judgeCalls,
  }
}

export type RepeatedScenarioResult = {
  scenario: string
  runs: number
  passed: number
  passRate: number
  /** The reliability read a pass rate cannot give you. */
  stability: StabilityReport
  results: ScenarioRunResult[]
  /** True when every run passed AND every run behaved the same way. */
  ok: boolean
  message: string
}

/**
 * Run a scenario k times and report correctness and consistency separately.
 *
 * These come apart in both directions, which is the whole reason to measure
 * both: an agent can pass every run by three different routes (consistent
 * outcome, unstable behaviour — one refactor from breaking), and it can fail
 * every run identically (stable, just wrong). A single pass rate reports the
 * two situations the same way.
 */
export async function runScenarioRepeated(
  scenario: Scenario,
  options: RunScenarioOptions & { runs?: number; attributionWindow?: number },
): Promise<RepeatedScenarioResult> {
  // The scenario wins: a long-horizon scenario that declares it needs 10 runs to
  // show its variance must not be quietly reduced to 1 by a suite-level default.
  const n = Math.max(1, scenario.runs ?? options.runs ?? 1)
  const results: ScenarioRunResult[] = []
  for (let i = 0; i < n; i++) results.push(await runScenario(scenario, options))

  const stability = analyzeStability(
    results.map((r) => ({
      calls: r.allCalls,
      compactions: r.compactions,
      steps: r.turns.length,
      finalContent: r.turns[r.turns.length - 1]?.finalContent ?? null,
    })),
    { attributionWindow: options.attributionWindow },
  )

  const passed = results.filter((r) => r.ok).length
  const passRate = passed / n
  const ok = passed === n && stability.verdict === 'stable'

  const parts = [`${passed}/${n} runs passed`]
  if (n > 1) {
    parts.push(
      stability.verdict === 'stable'
        ? 'behaviour identical across runs'
        : `behaviour ${stability.verdict} (${stability.distinctTraces} distinct traces, modal share ${Math.round(stability.modalShare * 100)}%)`,
    )
  }

  return {
    scenario: scenario.name,
    runs: n,
    passed,
    passRate,
    stability,
    results,
    ok,
    message: parts.join('; '),
  }
}
