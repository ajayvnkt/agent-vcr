/** Deterministic router regression using recorded application plans, without inference. */
import { callIdentity, exactSnapshot, sameIdentity } from './replay-identity.js'
import { parseTraceFileV1 } from './schema.js'
import type { TraceFileV1, ToolCallRecord } from './types.js'

export type PlannerRoutingOptions = {
  trace: TraceFileV1
  routerId: string
  /** A deterministic application parser/router, with no model or tool executor. */
  route: (plannerText: string) => ToolCallRecord[]
}

export function replayPlannerRouting({ trace, routerId, route }: PlannerRoutingOptions) {
  const rows: { atStep: number; text: string; expected: ToolCallRecord[]; actual: ToolCallRecord[]; status: 'PASS' | 'UNKNOWN' }[] = []
  const finish = (status: 'PASS' | 'FAIL' | 'UNKNOWN', reason: string) =>
    ({ status, disposition: status === 'PASS' ? 'COMPLETE' as const : 'INCONCLUSIVE' as const,
      reason, routerId, modelCalls: 0 as const, toolCalls: 0 as const, plans: rows,
      scope: 'Router behavior on recorded planner text only; no changed-prompt or environment-outcome claim.' })
  try {
    if (!routerId?.trim() || typeof route !== 'function') return finish('UNKNOWN', 'named deterministic router required')
    const frozen = parseTraceFileV1(exactSnapshot(trace))
    const plans = frozen.plannerOutputs
    if (!plans?.length) return finish('UNKNOWN', 'planner output was not captured')
    if (plans[0]!.atCall !== 0 || plans.at(-1)!.atCall + plans.at(-1)!.callCount !== frozen.calls.length) {
      return finish('UNKNOWN', 'planner evidence does not cover the tool path')
    }
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!
      const prior = plans[i - 1]
      if (!plan.text.trim() || plan.atCall + plan.callCount > frozen.calls.length ||
          (prior && (plan.atStep <= prior.atStep || plan.atCall !== prior.atCall + prior.callCount))) {
        return finish('UNKNOWN', 'missing text or invalid planner boundaries')
      }
      const actual = exactSnapshot(route(plan.text))
      if (!Array.isArray(actual)) return finish('UNKNOWN', 'router returned inexact or asynchronous data')
      // Snapshot before invoking again: a shared mutable return must not rewrite the first result.
      const snapshot = structuredClone(actual)
      const repeat = exactSnapshot(route(plan.text))
      if (JSON.stringify(snapshot) !== JSON.stringify(repeat)) {
        return finish('UNKNOWN', 'router did not produce repeatable decisions')
      }
      const normalized = parseTraceFileV1({ version: 1, calls: snapshot }).calls
      const expected = frozen.calls.slice(plan.atCall, plan.atCall + plan.callCount)
      rows.push({ atStep: plan.atStep, text: plan.text, expected, actual: normalized,
        status: expected.length === normalized.length && expected.every((call, index) =>
          sameIdentity(callIdentity(call, plan.atCall + index), callIdentity(normalized[index]!, plan.atCall + index))) ? 'PASS' : 'UNKNOWN' })
      if (rows.at(-1)!.status === 'UNKNOWN') {
        return finish('UNKNOWN', 'routing diverged; later plans were not exercised')
      }
    }
    return finish(rows.some(r => r.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS', 'exact routing identity required; changed routes are inconclusive')
  } catch (error) {
    return finish('UNKNOWN', `routing check unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
