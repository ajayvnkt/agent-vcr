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
