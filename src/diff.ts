/**
 * @fileoverview Compare expected vs actual tool-call traces.
 */

import type { CompareOptions, DiffResult, ToolCallRecord } from './types.js'
import { callsEqual } from './normalize.js'

const defaultOpts: Required<CompareOptions> = {
  mode: 'exact',
}

/**
 * Compare two call lists. `exact` requires same length and pairwise match.
 * `subsequence` requires expected to appear in order within actual (extra calls allowed).
 */
export function compareTraces(
  expected: ToolCallRecord[],
  actual: ToolCallRecord[],
  options?: CompareOptions,
): DiffResult {
  const mode = options?.mode ?? defaultOpts.mode
  if (mode === 'exact') return compareExact(expected, actual)
  return compareSubsequence(expected, actual)
}

function compareExact(expected: ToolCallRecord[], actual: ToolCallRecord[]): DiffResult {
  if (expected.length !== actual.length) {
    return {
      ok: false,
      reason: `length mismatch: expected ${expected.length} calls, got ${actual.length}`,
    }
  }
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!
    const a = actual[i]!
    if (!callsEqual(e, a)) {
      return {
        ok: false,
        reason: `call ${i} differs`,
        index: i,
        expected: e,
        actual: a,
      }
    }
  }
  return { ok: true }
}

function compareSubsequence(expected: ToolCallRecord[], actual: ToolCallRecord[]): DiffResult {
  if (expected.length === 0) return { ok: true }
  let j = 0
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!
    while (j < actual.length && !callsEqual(e, actual[j]!)) {
      j++
    }
    if (j >= actual.length) {
      return {
        ok: false,
        reason: `subsequence: expected call ${i} (${e.name}) not found in actual trace`,
        index: i,
        expected: e,
      }
    }
    j++
  }
  return { ok: true }
}
