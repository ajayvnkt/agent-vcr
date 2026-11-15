/**
 * @fileoverview `check`: evaluate recorded runs against policy and golden traces,
 * and write an evidence bundle.
 *
 * This is the deterministic gate. It makes no model calls: it reads traces that
 * already exist (Agent VCR trace files, or exported OpenTelemetry spans from any
 * framework) and judges each one. It is what the GitHub Action runs.
 *
 * A suite file lists scenarios. Paths are relative to the suite file.
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "refund agent",
 *   "policy": "policy.json",
 *   "scenarios": [
 *     { "name": "refund", "trace": "traces/run.json", "golden": "traces/refund.expected.json" },
 *     { "name": "python agent", "otel": "spans.json", "traceId": "ab12" }
 *   ]
 * }
 * ```
 *
 * Each scenario ends in one status:
 * - `pass`    matches the golden trace or an approved path, or (with no golden) breaks no policy
 * - `review`  a path nobody has approved that breaks no policy
 * - `fail`    breaks policy
 * - `error`   could not be evaluated: unreadable input, or nothing to check it against
 *
 * `error` fails the check. A scenario that could not be judged must never read
 * as a pass, so a suite with a missing file or a scenario with neither a policy
 * nor a golden trace is refused.
 *
 * The bundle records a sha256 of every input file, so a report can be tied to
 * the exact traces and policy it judged. The hashes show what was evaluated.
 * They are not a signature and do not prove who ran the check.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AssertionFailure, TraceAssertion } from './assert.js'
import { assertTrace } from './assert.js'
import type { BehaviorClass, BehaviorDivergence } from './behavior.js'
import { classifyRun } from './behavior.js'
import { parsePolicyFile, parseVariantFile } from './behavior-io.js'
import { parseExactArguments } from './replay-identity.js'
import { parseTraceFileV1 } from './schema.js'
import type { CompareMode, ToolCallRecord } from './types.js'
import type { Variant } from './variants.js'
import { parseOtelExport, traceFromOtelSpans } from './adapters/otel.js'

export type CheckStatus = 'pass' | 'review' | 'fail' | 'error'

export type CheckScenario = {
  name: string
  /** An Agent VCR trace file holding the run to judge. Exactly one of `trace` and `otel`. */
  trace?: string
  /** An exported OpenTelemetry span file holding the run to judge. */
  otel?: string
  /** Which trace in the span file, when it holds several. */
  traceId?: string
  /** Accept spans with no recorded arguments. The policy must then not check arguments. */
  namesOnly?: boolean
  golden?: string
  variants?: string
  /** Overrides the suite-level policy. */
  policy?: string
  mode?: CompareMode
}

export type CheckSuite = { version: 1; name?: string; policy?: string; scenarios: CheckScenario[] }

export type CheckInput = { role: string; path: string; sha256: string }

export type CheckScenarioResult = {
  name: string
  status: CheckStatus
  /** How the run compared with the golden trace, when one was given. */
  class: BehaviorClass | null
  variant: string | null
  reason: string
  calls: ToolCallRecord[]
  failures: AssertionFailure[]
  divergence: BehaviorDivergence | null
  inputs: CheckInput[]
}

export type CheckReport = {
  version: 1
  tool: string
  suite: { name: string; path: string; sha256: string }
  generatedAt: string
  verdict: 'pass' | 'review' | 'fail'
  counts: Record<CheckStatus, number>
  scenarios: CheckScenarioResult[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const SCENARIO_KEYS = ['name', 'trace', 'otel', 'traceId', 'namesOnly', 'golden', 'variants', 'policy', 'mode']

/** Validate a suite file. Unknown keys are refused: a misspelt "polcy" would otherwise check nothing. */
export function parseCheckSuite(data: unknown, where = 'suite file'): CheckSuite {
  if (!isObject(data)) throw new Error(`${where}: expected an object`)
  if (data['version'] !== 1) throw new Error(`${where}: expected "version": 1`)
  const unknownTop = Object.keys(data).filter((k) => !['version', 'name', 'policy', 'scenarios'].includes(k))
  if (unknownTop.length > 0) throw new Error(`${where}: unknown key ${unknownTop.map((k) => `"${k}"`).join(', ')}`)
  if (data['name'] !== undefined && typeof data['name'] !== 'string') throw new Error(`${where}: "name" must be a string`)
  if (data['policy'] !== undefined && (typeof data['policy'] !== 'string' || data['policy'] === '')) throw new Error(`${where}: "policy" must be a non-empty path`)
  if (!Array.isArray(data['scenarios']) || data['scenarios'].length === 0) {
    throw new Error(`${where}: "scenarios" must be a non-empty array`)
  }
  const names = new Set<string>()
  const scenarios = data['scenarios'].map((s, i): CheckScenario => {
    const at = `${where}: scenario ${i}`
    if (!isObject(s)) throw new Error(`${at} must be an object`)
    const unknown = Object.keys(s).filter((k) => !SCENARIO_KEYS.includes(k))
    if (unknown.length > 0) throw new Error(`${at}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')}`)
    if (typeof s['name'] !== 'string' || s['name'].trim() === '') throw new Error(`${at} needs a non-empty "name"`)
    if (names.has(s['name'])) throw new Error(`${where}: duplicate scenario name "${s['name']}"`)
    names.add(s['name'])
    for (const key of ['trace', 'otel', 'traceId', 'golden', 'variants', 'policy']) {
      if (s[key] !== undefined && (typeof s[key] !== 'string' || s[key] === '')) throw new Error(`${at}: "${key}" must be a non-empty string`)
    }
    if ((s['trace'] === undefined) === (s['otel'] === undefined)) throw new Error(`${at} needs exactly one of "trace" and "otel"`)
    if (s['namesOnly'] !== undefined && typeof s['namesOnly'] !== 'boolean') throw new Error(`${at}: "namesOnly" must be true or false`)
    if (s['otel'] === undefined && (s['traceId'] !== undefined || s['namesOnly'] !== undefined)) {
      throw new Error(`${at}: "traceId" and "namesOnly" apply to "otel" inputs only`)
    }
    if (s['mode'] !== undefined && s['mode'] !== 'exact' && s['mode'] !== 'subsequence') throw new Error(`${at}: "mode" must be exact or subsequence`)
    if (s['golden'] === undefined && (s['variants'] !== undefined || s['mode'] !== undefined)) {
      // Both only mean something next to a golden trace; accepting them alone would ignore them silently.
      throw new Error(`${at}: "variants" and "mode" need a "golden" trace`)
    }
    return s as unknown as CheckScenario
  })
  return {
    version: 1,
    ...(typeof data['name'] === 'string' ? { name: data['name'] } : {}),
    ...(typeof data['policy'] === 'string' ? { policy: data['policy'] } : {}),
    scenarios,
  }
}

/** Does any rule in the policy look at arguments? Such a policy means nothing on a names-only trace. */
function policyChecksArguments(policy: TraceAssertion): boolean {
  const patterns = [...(policy.sequence ?? []), ...(policy.includes ?? [])]
  return patterns.some((p) => typeof p !== 'string' && p.args !== undefined && Object.keys(p.args).length > 0) ||
    policy.grounding !== undefined || policy.survival !== undefined
}

export type RunCheckOptions = {
  /** Override the clock, for reproducible bundles in tests. */
  now?: () => Date
  /** Tool identifier written into the bundle, e.g. `agent-vcr@0.5.0`. */
  tool?: string
}

/** Evaluate every scenario in a suite file. Never throws for a bad scenario; that scenario becomes an `error`. */
export async function runCheck(suitePath: string, options?: RunCheckOptions): Promise<CheckReport> {
  const suiteText = await readFile(suitePath, 'utf8')
  let suiteData: unknown
  try {
    // The exact parser refuses duplicate keys. With JSON.parse a second "policy"
    // key would silently replace the first.
    suiteData = parseExactArguments(suiteText)
  } catch (e) {
    throw new Error(`Invalid JSON in ${suitePath}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const suite = parseCheckSuite(suiteData, suitePath)
  const base = dirname(resolve(suitePath))
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(base, p))

  const scenarios: CheckScenarioResult[] = []
  for (const scenario of suite.scenarios) {
    const inputs: CheckInput[] = []
    const read = async (role: string, path: string): Promise<string> => {
      const text = await readFile(at(path), 'utf8')
      inputs.push({ role, path, sha256: sha256(text) })
      return text
    }
    const exact = (text: string, path: string): unknown => {
      try {
        return parseExactArguments(text)
      } catch (e) {
        throw new Error(`Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const empty = { class: null, variant: null, calls: [] as ToolCallRecord[], failures: [] as AssertionFailure[], divergence: null }

    try {
      const policyPath = scenario.policy ?? suite.policy
      const policy = policyPath ? parsePolicyFile(exact(await read('policy', policyPath), policyPath), policyPath) : undefined

      let calls: ToolCallRecord[]
      if (scenario.trace !== undefined) {
        calls = (parseTraceFileV1(exact(await read('trace', scenario.trace), scenario.trace)) as { calls: ToolCallRecord[] }).calls
      } else {
        const otel = traceFromOtelSpans(parseOtelExport(await read('otel', scenario.otel!)), {
          traceId: scenario.traceId,
          missingArguments: scenario.namesOnly ? 'empty' : 'error',
        })
        if (otel.calls.length === 0) throw new Error(`${scenario.otel}: contains no tool spans, so there is no run to judge`)
        if (otel.withoutArguments > 0) {
          if (policy && policyChecksArguments(policy)) {
            throw new Error('the policy checks tool arguments, but the spans carry none. Record arguments, or use a policy of name and order rules only.')
          }
          if (scenario.golden !== undefined) {
            throw new Error('a golden trace cannot be compared with spans that carry no arguments. Record arguments, or drop "golden" and rely on the policy.')
          }
        }
        calls = otel.calls
      }

      if (scenario.golden === undefined) {
        if (!policy) throw new Error('nothing to check against: give the scenario a policy, a golden trace, or both')
        if (calls.length === 0) {
          // An empty run satisfies every forbid and requires rule. To assert that an agent
          // should call nothing, give a golden trace with no calls.
          throw new Error('the run has no tool calls, so a policy alone cannot judge it. Add a golden trace to say what was expected.')
        }
        const failures = assertTrace(calls, policy)
        scenarios.push({
          name: scenario.name,
          status: failures.length > 0 ? 'fail' : 'pass',
          class: null,
          variant: null,
          reason: failures.length > 0 ? failures.map((f) => f.message).join('; ') : 'breaks no policy rule',
          calls,
          failures,
          divergence: null,
          inputs,
        })
        continue
      }

      if (scenario.trace !== undefined && at(scenario.trace) === at(scenario.golden)) {
        throw new Error('"trace" and "golden" are the same file, so the comparison would prove nothing')
      }
      const golden = (parseTraceFileV1(exact(await read('golden', scenario.golden), scenario.golden)) as { calls: ToolCallRecord[] }).calls
      let variants: Variant[] = []
      if (scenario.variants !== undefined) {
        variants = parseVariantFile(exact(await read('variants', scenario.variants), scenario.variants), scenario.variants).variants
      }
      const r = classifyRun(calls, { golden, variants, policy, mode: scenario.mode })
      scenarios.push({
        name: scenario.name,
        status: r.class === 'regression' ? 'fail' : r.class === 'unreviewed' ? 'review' : 'pass',
        class: r.class,
        variant: r.variant,
        reason: r.reason,
        calls,
        failures: r.failures,
        divergence: r.divergence,
        inputs,
      })
    } catch (e) {
      scenarios.push({ name: scenario.name, status: 'error', ...empty, reason: e instanceof Error ? e.message : String(e), inputs })
    }
  }

  const counts: Record<CheckStatus, number> = { pass: 0, review: 0, fail: 0, error: 0 }
  for (const s of scenarios) counts[s.status]++
  return {
    version: 1,
    tool: options?.tool ?? 'agent-vcr',
    suite: { name: suite.name ?? 'agent-vcr check', path: suitePath, sha256: sha256(suiteText) },
    generatedAt: (options?.now?.() ?? new Date()).toISOString(),
    verdict: counts.fail + counts.error > 0 ? 'fail' : counts.review > 0 ? 'review' : 'pass',
    counts,
    scenarios,
  }
}
