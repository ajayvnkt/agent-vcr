/**
 * @fileoverview Zod schemas for trace files — fail fast with readable errors.
 */

import { z } from 'zod'

const recordSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})

export const traceFileV1Schema = z.object({
  version: z.literal(1),
  scenario: z.string().optional(),
  calls: z.array(recordSchema),
})

export type ParsedTraceFileV1 = z.infer<typeof traceFileV1Schema>

const compactionEventSchema = z.object({
  atCall: z.number().int().nonnegative(),
  atStep: z.number().int().nonnegative(),
  summary: z.string(),
  droppedMessages: z.number().int().nonnegative().default(0),
  keptRecentTurns: z.number().int().nonnegative().default(0),
  tokensBefore: z.number().int().nonnegative().default(0),
  tokensAfter: z.number().int().nonnegative().default(0),
})

/** v2 adds compaction events: where the agent cut its own context, and what it wrote. */
export const traceFileV2Schema = z.object({
  version: z.literal(2),
  scenario: z.string().optional(),
  calls: z.array(recordSchema),
  compactions: z.array(compactionEventSchema).default([]),
})

export type ParsedTraceFileV2 = z.infer<typeof traceFileV2Schema>

/** Accepts either version; v1 files come back normalized to the v2 shape. */
export const traceFileSchema = z.union([traceFileV1Schema, traceFileV2Schema])

export function parseTraceFile(raw: unknown): ParsedTraceFileV2 {
  const parsed = traceFileSchema.parse(raw)
  if (parsed.version === 2) return parsed
  return { version: 2, scenario: parsed.scenario, calls: parsed.calls, compactions: [] }
}

export function parseTraceFileV1(raw: unknown): ParsedTraceFileV1 {
  return traceFileV1Schema.parse(raw)
}

export function safeParseTraceFileV1(
  raw: unknown,
): { success: true; data: ParsedTraceFileV1 } | { success: false; error: z.ZodError } {
  const r = traceFileV1Schema.safeParse(raw)
  if (r.success) return { success: true, data: r.data }
  return { success: false, error: r.error }
}
