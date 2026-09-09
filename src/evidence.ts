/** Deterministic provenance and information-survival assertions. No model calls. */
import type { ToolCallRecord } from './types.js'
import { stableStringify } from './normalize.js'

export type GroundingSource =
  | { id: string; kind: 'user'; text: string; availableBefore: number }
  | { id: string; kind: 'state'; value: unknown; availableBefore: number }

export type GroundingCitation = {
  call: number
  /** Dot-separated own-property path in the tool arguments. */
  argument: string
  source: string
  /** Required for user text: exact UTF-16 [start, end) span. */
  span?: [number, number]
  /** Optional dot-separated own-property path in a state value. */
  path?: string
}

export type GroundingRule = { tool: string; arguments: string[] }
export type EvidenceFailure = {
  kind: 'grounding' | 'survival'
  message: string
  index?: number
  fact?: string
}

function dig(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' ||
        !Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Every protected argument on EVERY matching invocation requires a valid citation.
 * Literal text proves provenance only, not intent, authorization, or semantic correctness.
 * Numbers must be parsed from the complete cited span; partial numeric matches are rejected.
 */
export function assertGrounding(
  calls: ToolCallRecord[], rules: GroundingRule[], sources: GroundingSource[], citations: GroundingCitation[],
): EvidenceFailure[] {
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('duplicate source id')
  if (sources.some(s => !s.id || !Number.isInteger(s.availableBefore) || s.availableBefore < 0)) {
    throw new Error('sources require ids and nonnegative integer availability indices')
  }
  if (rules.some(r => !r.tool || !r.arguments.length || r.arguments.some(a => !a))) {
    throw new Error('grounding rules require a tool and nonempty argument paths')
  }
  const failures: EvidenceFailure[] = []
  calls.forEach((call, index) => {
    for (const rule of rules.filter(r => r.tool === call.name)) {
      for (const argument of rule.arguments) {
        const actual = dig(call.args, argument)
        const grounded = actual !== undefined && citations.some(c => {
          if (c.call !== index || c.argument !== argument) return false
          const source = sources.find(s => s.id === c.source)
          if (!source || source.availableBefore > index) return false
          if (source.kind === 'state') {
            const value = c.path ? dig(source.value, c.path) : source.value
            return value !== undefined && stableStringify(value) === stableStringify(actual)
          }
          if (!c.span) return false
          const [start, end] = c.span
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length) return false
          const text = source.text.slice(start, end)
          // Reject selecting "12" inside "3124" (or a substring of an identifier).
          const word = /[\p{L}\p{N}_]/u
          if ((word.test(text[0]!) && start > 0 && word.test(source.text[start - 1]!)) ||
              (word.test(text[text.length - 1]!) && end < source.text.length && word.test(source.text[end]!))) return false
          if (typeof actual === 'number') return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && Number(text) === actual
          return typeof actual === 'string' && text === actual
        })
        if (!grounded) failures.push({ kind: 'grounding', index,
          message: `"${call.name}" argument "${argument}" has no valid prior user/state citation` })
      }
    }
  })
  return failures
}

export type TransformationEvent = {
  id: string
  kind: 'sanitize' | 'compact' | 'summarize'
  /** Index of the next tool call. */
  atCall: number
  /** Effective context immediately before/after, including retained context. */
  before: string
  after: string
}

export type SurvivalRule = {
  id: string
  /** Literal fact required in effective context; avoid broad prose clauses. */
  fact: string
  transformation?: TransformationEvent['kind']
  /** If present, only cuts before a call to this tool apply. */
  neededBy?: string
}

/** Checks every applicable boundary, including a missing signal BEFORE the cut.
 * A missing transformation is a failure: an unexercised contract is not a green test.
 */
export function assertTransformationSurvival(
  calls: ToolCallRecord[], events: TransformationEvent[], rules: SurvivalRule[],
): EvidenceFailure[] {
  if (new Set(events.map(e => e.id)).size !== events.length || events.some((e, i) =>
    !e.id || !Number.isInteger(e.atCall) || e.atCall < 0 || e.atCall > calls.length ||
    (i > 0 && e.atCall < events[i - 1]!.atCall))) throw new Error('invalid transformation events')
  const failures: EvidenceFailure[] = []
  for (const rule of rules) {
    if (!rule.id || !rule.fact.trim()) throw new Error('survival rules require an id and nonempty fact')
    const relevant = events.filter(e => (!rule.transformation || e.kind === rule.transformation) &&
      (!rule.neededBy || calls.slice(e.atCall).some(c => c.name === rule.neededBy)))
    if (!relevant.length) failures.push({ kind: 'survival', fact: rule.id,
      message: `fact "${rule.id}": no applicable transformation/dependent call; contract not exercised` })
    for (const event of relevant) {
      if (!event.before.includes(rule.fact) || !event.after.includes(rule.fact)) {
        failures.push({ kind: 'survival', index: event.atCall, fact: rule.id,
          message: `fact "${rule.id}" missing ${!event.before.includes(rule.fact) ? 'before' : 'after'} ${event.kind} "${event.id}"` })
      }
    }
  }
  return failures
}
