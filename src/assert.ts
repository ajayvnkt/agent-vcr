/**
 * @fileoverview Deterministic assertions over a tool-call trace.
 *
 * An exact golden trace answers one question — "is this byte-identical to last
 * time?" — and answers it too strictly. Agents legitimately reorder independent
 * calls, retry, or add a lookup. Pinning the whole sequence turns every harmless
 * variation into a failing build, and a suite that cries wolf gets deleted.
 *
 * What teams actually want to enforce is narrower and stronger: *this tool is
 * never called*, *verification always precedes the payout*, *the refund amount
 * matches the order*. Those are policy, and policy survives refactors that a
 * golden trace does not.
 *
 * Everything here is free: no model calls, no embeddings, no network. It runs
 * first so the paid tiers never get spent on a run that already broke a rule.
 */

import type { ToolCallRecord } from './types.js'
import { stableStringify } from './normalize.js'

/** How one argument is checked. A bare value is shorthand for `{ equals: value }`. */
export type ArgMatcher =
  | { equals: unknown }
  | { contains: string }
  | { matches: string }
  | { oneOf: unknown[] }
  | { exists: true }
  | { absent: true }

export type ToolExpectation = {
  name: string
  /** Per-argument checks. Arguments not named here are ignored. */
  args?: Record<string, ArgMatcher | unknown>
}

/** A tool named by string alone, or with argument expectations. */
export type ToolPattern = string | ToolExpectation

export type TraceAssertion = {
  /** These tools must appear in this relative order. Other calls may sit between them. */
  sequence?: ToolPattern[]
  /** These tools must appear at least once, in any order. */
  includes?: ToolPattern[]
  /** These tools must never appear. */
  forbid?: string[]
  /** Whenever both appear, the first must precede the second. Partial order, not a full sequence. */
  ordering?: [string, string][]
  /**
   * `[dependent, prerequisite]` — wherever `dependent` is called, `prerequisite`
   * must already have been called.
   *
   * This is the difference between an ordering rule and a safety rule, and it is
   * the one people get wrong. `ordering: [['verify', 'refund']]` says nothing at
   * all when `verify` is absent — so an agent that refunds without verifying
   * passes. `requires: [['refund', 'verify']]` fails it, which is the actual
   * policy: *never refund unverified*.
   */
  requires?: [string, string][]
  /** Upper bound on total calls — catches runaway loops and retry storms. */
  maxCalls?: number
  /** No tool may be called more than this many times. */
  maxCallsPerTool?: number
}

export type AssertionFailureKind =
  | 'sequence'
  | 'missing'
  | 'forbidden'
  | 'ordering'
  | 'requires'
  | 'maxCalls'
  | 'maxCallsPerTool'
  | 'args'

export type AssertionFailure = {
  kind: AssertionFailureKind
  message: string
  /** Index into the actual trace, where one applies. */
  index?: number
  expected?: unknown
  actual?: unknown
}

function isArgMatcher(v: unknown): v is ArgMatcher {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v as Record<string, unknown>)
  if (keys.length !== 1) return false
  return ['equals', 'contains', 'matches', 'oneOf', 'exists', 'absent'].includes(keys[0]!)
}

/** Check one argument against one matcher. Returns null on success, else a reason. */
export function checkArg(
  key: string,
  actual: unknown,
  matcher: ArgMatcher | unknown,
): string | null {
  const m: ArgMatcher = isArgMatcher(matcher) ? matcher : { equals: matcher }

  if ('exists' in m) {
    return actual === undefined ? `expected arg "${key}" to be present` : null
  }
  if ('absent' in m) {
    return actual !== undefined ? `expected arg "${key}" to be absent, got ${str(actual)}` : null
  }
  if ('equals' in m) {
    return stableStringify(actual) === stableStringify(m.equals)
      ? null
      : `arg "${key}": expected ${str(m.equals)}, got ${str(actual)}`
  }
  if ('oneOf' in m) {
    const want = m.oneOf.map((v) => stableStringify(v))
    return want.includes(stableStringify(actual))
      ? null
      : `arg "${key}": expected one of ${str(m.oneOf)}, got ${str(actual)}`
  }
  if ('contains' in m) {
    const s = typeof actual === 'string' ? actual : stableStringify(actual)
    return s.includes(m.contains) ? null : `arg "${key}": expected to contain "${m.contains}"`
  }
  // matches
  const s = typeof actual === 'string' ? actual : stableStringify(actual)
  let re: RegExp
  try {
    re = new RegExp(m.matches)
  } catch {
    return `arg "${key}": invalid regex ${str(m.matches)}`
  }
  return re.test(s) ? null : `arg "${key}": expected to match /${m.matches}/, got ${str(actual)}`
}

function str(v: unknown): string {
  const s = stableStringify(v)
  return s.length > 120 ? `${s.slice(0, 117)}...` : s
}

function patternName(p: ToolPattern): string {
  return typeof p === 'string' ? p : p.name
}

/** Does one recorded call satisfy one pattern? */
export function callMatches(call: ToolCallRecord, pattern: ToolPattern): boolean {
  if (call.name !== patternName(pattern)) return false
  if (typeof pattern === 'string' || !pattern.args) return true
  for (const [k, matcher] of Object.entries(pattern.args)) {
    if (checkArg(k, call.args[k], matcher) !== null) return false
  }
  return true
}

/** Why a call failed a pattern it matched by name — used for actionable messages. */
function argFailures(call: ToolCallRecord, pattern: ToolPattern): string[] {
  if (typeof pattern === 'string' || !pattern.args) return []
  const out: string[] = []
  for (const [k, matcher] of Object.entries(pattern.args)) {
    const r = checkArg(k, call.args[k], matcher)
    if (r !== null) out.push(r)
  }
  return out
}

/**
 * Run every assertion against a trace and return all failures.
 *
 * Deliberately returns the full list rather than throwing on the first one:
 * a single CI run should tell you everything that is wrong, not make you fix
 * and re-push six times.
 */
export function assertTrace(
  calls: ToolCallRecord[],
  assertion: TraceAssertion,
): AssertionFailure[] {
  const failures: AssertionFailure[] = []

  if (assertion.maxCalls !== undefined && calls.length > assertion.maxCalls) {
    failures.push({
      kind: 'maxCalls',
      message: `trace has ${calls.length} calls, limit is ${assertion.maxCalls}`,
      expected: assertion.maxCalls,
      actual: calls.length,
    })
  }

  if (assertion.maxCallsPerTool !== undefined) {
    const counts = new Map<string, number>()
    for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
    for (const [name, n] of counts) {
      if (n > assertion.maxCallsPerTool) {
        failures.push({
          kind: 'maxCallsPerTool',
          message: `"${name}" called ${n} times, limit is ${assertion.maxCallsPerTool}`,
          expected: assertion.maxCallsPerTool,
          actual: n,
        })
      }
    }
  }

  for (const name of assertion.forbid ?? []) {
    const at = calls.findIndex((c) => c.name === name)
    if (at !== -1) {
      failures.push({
        kind: 'forbidden',
        message: `forbidden tool "${name}" was called at index ${at}`,
        index: at,
        actual: calls[at],
      })
    }
  }

  for (const pattern of assertion.includes ?? []) {
    if (!calls.some((c) => callMatches(c, pattern))) {
      failures.push(missingFailure(calls, pattern))
    }
  }

  if (assertion.sequence?.length) {
    let cursor = 0
    for (let i = 0; i < assertion.sequence.length; i++) {
      const pattern = assertion.sequence[i]!
      let found = -1
      for (let j = cursor; j < calls.length; j++) {
        if (callMatches(calls[j]!, pattern)) {
          found = j
          break
        }
      }
      if (found === -1) {
        failures.push({
          ...missingFailure(calls.slice(cursor), pattern),
          kind: 'sequence',
          message: `expected "${patternName(pattern)}" at position ${i} of the required sequence, not found after index ${cursor - 1}`,
          index: cursor,
        })
        break
      }
      cursor = found + 1
    }
  }

  for (const [dependent, prerequisite] of assertion.requires ?? []) {
    for (let i = 0; i < calls.length; i++) {
      if (calls[i]!.name !== dependent) continue
      const satisfied = calls.slice(0, i).some((c) => c.name === prerequisite)
      if (!satisfied) {
        const laterAt = calls.findIndex((c) => c.name === prerequisite)
        failures.push({
          kind: 'requires',
          message:
            laterAt === -1
              ? `"${dependent}" at index ${i} requires a prior "${prerequisite}", which was never called`
              : `"${dependent}" at index ${i} requires a prior "${prerequisite}", but that only happened at index ${laterAt}`,
          index: i,
          expected: `${prerequisite} before ${dependent}`,
          actual: calls[i],
        })
        break
      }
    }
  }

  for (const [first, second] of assertion.ordering ?? []) {
    const firstAt = calls.findIndex((c) => c.name === first)
    const secondAt = calls.findIndex((c) => c.name === second)
    if (firstAt === -1 || secondAt === -1) continue
    if (firstAt > secondAt) {
      failures.push({
        kind: 'ordering',
        message: `"${first}" must precede "${second}" — got "${second}" at ${secondAt}, "${first}" at ${firstAt}`,
        index: secondAt,
        expected: `${first} before ${second}`,
        actual: `${second} before ${first}`,
      })
    }
  }

  return failures
}

/**
 * Build the most useful "not found" message available: when a call of the right
 * name exists but its arguments are wrong, say which argument — that is almost
 * always the real bug, and "expected lookup_order, not found" would hide it.
 */
function missingFailure(calls: ToolCallRecord[], pattern: ToolPattern): AssertionFailure {
  const name = patternName(pattern)
  const byName = calls.findIndex((c) => c.name === name)
  if (byName !== -1) {
    const reasons = argFailures(calls[byName]!, pattern)
    if (reasons.length > 0) {
      return {
        kind: 'args',
        message: `"${name}" was called but ${reasons.join('; ')}`,
        index: byName,
        expected: pattern,
        actual: calls[byName],
      }
    }
  }
  return {
    kind: 'missing',
    message: `expected a call to "${name}", none found`,
    expected: pattern,
  }
}

/** True when the trace satisfies every assertion. */
export function traceSatisfies(calls: ToolCallRecord[], assertion: TraceAssertion): boolean {
  return assertTrace(calls, assertion).length === 0
}
