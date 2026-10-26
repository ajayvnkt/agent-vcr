/** Promptfoo's documented JavaScript assertion interface. No Promptfoo dependency. */
import { z } from 'zod'
import { assertGrounding, assertTransformationSurvival } from './evidence.js'
import type { CompactedRun } from './compaction.js'

const integer = z.number().int().nonnegative()
const text = z.string().min(1)
const call = z.object({ name: text, args: z.record(z.unknown()) }).strict()
const source = z.discriminatedUnion('kind', [
  z.object({ id: text, kind: z.literal('user'), text: z.string(), availableBefore: integer }).strict(),
  z.object({ id: text, kind: z.literal('state'),
    value: z.unknown().refine(v => v !== undefined, 'state value is required'),
    availableBefore: integer }).strict(),
])
const citation = z.object({ call: integer, argument: text, source: text,
  span: z.tuple([integer, integer]).optional(), path: text.optional() }).strict()
const event = z.object({ id: text, kind: z.enum(['sanitize', 'compact', 'summarize']),
  atCall: integer, before: z.string(), after: z.string() }).strict()

export const evidenceSchema = z.object({
  version: z.literal(1), complete: z.literal(true),
  calls: z.array(call), sources: z.array(source), citations: z.array(citation),
  transformations: z.array(event),
}).strict()

const configSchema = z.object({
  grounding: z.array(z.object({ tool: text, arguments: z.array(text).min(1) }).strict()).optional(),
  survival: z.array(z.object({ id: text, fact: text,
    transformation: z.enum(['sanitize', 'compact', 'summarize']).optional(),
    neededBy: text.optional() }).strict()).optional(),
}).strict().refine(c => (c.grounding?.length ?? 0) + (c.survival?.length ?? 0) > 0,
  'declare at least one evidence assertion')

export type EvidenceEnvelope = z.infer<typeof evidenceSchema>
export type EvidenceConfig = z.infer<typeof configSchema>
export type EvidenceGrade = { pass: boolean; score: number; reason: string;
  metadata: { status: 'pass' | 'fail' | 'unsupported'; failures: string[] } }

/** Data must be captured by the trusted provider, not copied from model output. */
export default function evidenceAssertion(_output: unknown, context: {
  config?: unknown; providerResponse?: { metadata?: Record<string, unknown> }
}): EvidenceGrade {
  try {
    const config = configSchema.parse(context.config)
    const evidence = evidenceSchema.parse(context.providerResponse?.metadata?.vcrEvidence)
    const failures: string[] = []
    for (const rule of config.grounding ?? []) {
      if (!evidence.calls.some(c => c.name === rule.tool)) {
        failures.push(`grounding contract for "${rule.tool}" was not exercised`)
      }
    }
    failures.push(...assertGrounding(evidence.calls, config.grounding ?? [],
      evidence.sources.map(s => s.kind === 'state' ? { ...s, value: s.value } : s),
      evidence.citations).map(f => f.message))
    failures.push(...assertTransformationSurvival(evidence.calls, evidence.transformations,
      config.survival ?? []).map(f => f.message))
    return { pass: failures.length === 0, score: failures.length ? 0 : 1,
      reason: failures.length ? failures.join('; ') : 'All declared evidence contracts exercised and satisfied',
      metadata: { status: failures.length ? 'fail' : 'pass', failures } }
  } catch (error) {
    const reason = error instanceof z.ZodError
      ? error.issues.map(i => `${i.path.join('.') || 'contract'}: ${i.message}`).join('; ')
      : error instanceof Error ? error.message : 'invalid evidence'
    return { pass: false, score: 0, reason: `Evidence unsupported: ${reason}`,
      metadata: { status: 'unsupported', failures: [reason] } }
  }
}

/** Opt-in collector capture is required; summary-only history cannot prove survival. */
export function evidenceFromCompactedRun(run: CompactedRun,
  sources: EvidenceEnvelope['sources'] = [], citations: EvidenceEnvelope['citations'] = [],
): EvidenceEnvelope {
  return evidenceSchema.parse({ version: 1, complete: true, calls: run.calls, sources, citations,
    transformations: run.compactions.map((cut, i) => ({ id: `compact-${i}`,
      kind: 'compact', atCall: cut.atCall, before: cut.effectiveBefore, after: cut.effectiveAfter })) })
}
