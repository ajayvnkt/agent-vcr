/**
 * @fileoverview Multi-path golden traces.
 *
 * A single golden trace assumes one right answer. Plenty of agents have several:
 * two independent lookups can happen in either order, a cache hit skips a fetch,
 * a retry adds a call. Each of those is correct behaviour, and a one-path golden
 * file fails all but one of them.
 *
 * The usual workaround is to loosen the comparison until it stops complaining,
 * which quietly stops catching regressions too. A variant set keeps every path
 * exact and simply accepts more than one — so the suite stays strict about what
 * it knows and honest about what it doesn't.
 *
 * When nothing matches, `matchVariants` reports the *closest* variant and where
 * it diverged, because "no variant matched" alone is not a debuggable message.
 */

import type { CompareMode, ToolCallRecord } from './types.js'
import { compareTraces } from './diff.js'
import { firstDivergence } from './stability.js'

export type Variant = {
  /** Short label shown in reports, e.g. 'cache-hit'. */
  name: string
  calls: ToolCallRecord[]
  /** Free-text note on when this path is legitimate. */
  note?: string
}

export type VariantFileV1 = {
  version: 1
  scenario?: string
  variants: Variant[]
}

export type VariantMatch = {
  matched: boolean
  /** Name of the variant that matched, when one did. */
  variant: string | null
  /** Closest variant by divergence depth, for the failure message. */
  closest: {
    variant: string
    divergedAt: number | null
    reason: string
  } | null
  message: string
}

/**
 * Match an actual trace against a set of accepted paths.
 *
 * "Closest" is measured by how far the trace got before diverging, not by edit
 * distance. A run that diverges at call 9 of 10 is a near miss worth reading;
 * one that diverges at call 0 is a different path entirely, and edit distance
 * would happily rank the second one higher on a long trace.
 */
export function matchVariants(
  actual: ToolCallRecord[],
  variants: Variant[],
  options?: { mode?: CompareMode },
): VariantMatch {
  if (variants.length === 0) {
    throw new Error('matchVariants: no variants supplied')
  }
  const mode: CompareMode = options?.mode ?? 'exact'

  let closest: VariantMatch['closest'] = null

  for (const v of variants) {
    const diff = compareTraces(v.calls, actual, { mode })
    if (diff.ok) {
      return {
        matched: true,
        variant: v.name,
        closest: null,
        message: `matched accepted path "${v.name}"`,
      }
    }
    const divergedAt = firstDivergence(v.calls, actual)
    const depth = divergedAt ?? Number.MAX_SAFE_INTEGER
    const bestDepth = closest?.divergedAt ?? -1
    if (closest === null || depth > bestDepth) {
      closest = { variant: v.name, divergedAt, reason: diff.reason }
    }
  }

  const names = variants.map((v) => `"${v.name}"`).join(', ')
  const where =
    closest?.divergedAt !== null && closest?.divergedAt !== undefined
      ? ` Closest was "${closest.variant}", which diverged at call ${closest.divergedAt}: ${closest.reason}`
      : closest
        ? ` Closest was "${closest.variant}": ${closest.reason}`
        : ''

  return {
    matched: false,
    variant: null,
    closest,
    message: `no accepted path matched (tried ${names}).${where}`,
  }
}

/**
 * Add a newly observed trace as an accepted path, if it isn't one already.
 *
 * This is the "approve" step. It is deliberately a separate, explicit call
 * rather than something the runner does on a failure: a suite that widens its
 * own definition of correct whenever it fails does not test anything.
 */
export function addVariant(
  variants: Variant[],
  candidate: ToolCallRecord[],
  name: string,
  options?: { mode?: CompareMode; note?: string },
): { variants: Variant[]; added: boolean; reason: string } {
  const existing = matchVariants(candidate, variants.length ? variants : [], options)
  if (variants.length > 0 && existing.matched) {
    return {
      variants,
      added: false,
      reason: `already covered by accepted path "${existing.variant}"`,
    }
  }
  if (variants.some((v) => v.name === name)) {
    throw new Error(`addVariant: a variant named "${name}" already exists`)
  }
  return {
    variants: [...variants, { name, calls: candidate, note: options?.note }],
    added: true,
    reason: `added "${name}" as an accepted path`,
  }
}

/** Distinct trace shapes seen across runs, most frequent first — candidates to approve. */
export function proposeVariants(
  runs: ToolCallRecord[][],
): { calls: ToolCallRecord[]; count: number; share: number }[] {
  const seen = new Map<string, { calls: ToolCallRecord[]; count: number }>()
  for (const calls of runs) {
    const key = JSON.stringify(calls.map((c) => [c.name, c.args]))
    const hit = seen.get(key)
    if (hit) hit.count++
    else seen.set(key, { calls, count: 1 })
  }
  return [...seen.values()]
    .sort((a, b) => b.count - a.count)
    .map((v) => ({ ...v, share: v.count / runs.length }))
}
