/**
 * @fileoverview Running many scenarios, and deciding whether the build should fail.
 *
 * The gate is a policy decision, not a fact, so it is configurable and explicit.
 * Two knobs matter and most tools only give you the first:
 *
 *   `minPassRate`  — how much correctness you require.
 *   `requireStable` — whether inconsistent-but-passing counts as green.
 *
 * The second is the one that catches long-horizon agents. A suite where every
 * scenario passes 10/10 by three different routes is one prompt tweak away from
 * an incident, and a pass-rate gate calls it green.
 */

import type { Scenario, RepeatedScenarioResult, RunScenarioOptions } from './scenario.js'
import { runScenarioRepeated } from './scenario.js'

export type SuiteGate = {
  /** Minimum share of runs that must pass, per scenario. Default 1. */
  minPassRate?: number
  /** Fail a scenario whose runs disagree with each other, even when all pass. Default false. */
  requireStable?: boolean
  /** Fail when any scenario's compaction summaries break their contract. Default true. */
  requireContracts?: boolean
}

export type SuiteScenarioOutcome = RepeatedScenarioResult & {
  gated: boolean
  gateReasons: string[]
}

export type SuiteResult = {
  ok: boolean
  scenarios: SuiteScenarioOutcome[]
  totals: {
    scenarios: number
    passedScenarios: number
    runs: number
    passedRuns: number
    judgeCalls: number
    unstableScenarios: number
    contractViolations: number
  }
  message: string
}

/**
 * Run every scenario and apply the gate.
 *
 * Scenarios run sequentially on purpose. These suites drive real agents against
 * real tools; running them in parallel produces rate limits and cross-talk
 * through shared fixtures, and the resulting flakiness gets blamed on the agent.
 */
export async function runSuite(
  scenarios: Scenario[],
  options: RunScenarioOptions & {
    runs?: number
    gate?: SuiteGate
    attributionWindow?: number
    /** Called after each scenario, for progress output on long suites. */
    onScenario?: (result: SuiteScenarioOutcome) => void
  },
): Promise<SuiteResult> {
  const gate: Required<SuiteGate> = {
    minPassRate: options.gate?.minPassRate ?? 1,
    requireStable: options.gate?.requireStable ?? false,
    requireContracts: options.gate?.requireContracts ?? true,
  }

  const outcomes: SuiteScenarioOutcome[] = []

  for (const scenario of scenarios) {
    const result = await runScenarioRepeated(scenario, options)
    const gateReasons: string[] = []

    if (result.passRate < gate.minPassRate) {
      gateReasons.push(
        `pass rate ${Math.round(result.passRate * 100)}% below required ${Math.round(gate.minPassRate * 100)}%`,
      )
    }
    if (gate.requireStable && result.stability.verdict !== 'stable') {
      gateReasons.push(
        `behaviour is ${result.stability.verdict} across ${result.runs} runs (${result.stability.distinctTraces} distinct traces)`,
      )
    }
    if (gate.requireContracts) {
      const broken = result.results.filter((r) => r.contract && !r.contract.ok)
      if (broken.length > 0) {
        gateReasons.push(`${broken.length} run(s) broke the summary contract`)
      }
    }

    const outcome: SuiteScenarioOutcome = {
      ...result,
      gated: gateReasons.length > 0,
      gateReasons,
    }
    outcomes.push(outcome)
    options.onScenario?.(outcome)
  }

  const totals = {
    scenarios: outcomes.length,
    passedScenarios: outcomes.filter((o) => !o.gated).length,
    runs: outcomes.reduce((a, o) => a + o.runs, 0),
    passedRuns: outcomes.reduce((a, o) => a + o.passed, 0),
    judgeCalls: outcomes.reduce(
      (a, o) => a + o.results.reduce((b, r) => b + r.judgeCalls, 0),
      0,
    ),
    unstableScenarios: outcomes.filter((o) => o.stability.verdict !== 'stable').length,
    contractViolations: outcomes.reduce(
      (a, o) => a + o.results.filter((r) => r.contract && !r.contract.ok).length,
      0,
    ),
  }

  const ok = outcomes.every((o) => !o.gated)
  const message = ok
    ? `${totals.passedScenarios}/${totals.scenarios} scenarios passed the gate (${totals.passedRuns}/${totals.runs} runs)`
    : `${totals.scenarios - totals.passedScenarios} of ${totals.scenarios} scenarios failed the gate`

  return { ok, scenarios: outcomes, totals, message }
}
