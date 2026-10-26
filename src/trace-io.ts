/**
 * @fileoverview Read / write trace JSON files with schema validation.
 */

import { exactSnapshot, parseExactArguments } from './replay-identity.js'
import { readFile, writeFile } from 'node:fs/promises'
import type { TraceFileV1 } from './types.js'
import { parseTraceFileV1 } from './schema.js'

export async function loadTraceFile(path: string): Promise<TraceFileV1> {
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = parseExactArguments(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid JSON in ${path}: ${msg}`)
  }
  return parseTraceFileV1(parsed) as TraceFileV1
}

export async function saveTraceFile(path: string, trace: TraceFileV1): Promise<void> {
  const snapshot = exactSnapshot(trace)
  parseTraceFileV1(snapshot)
  const body = `${JSON.stringify(snapshot, null, 2)}\n`
  await writeFile(path, body, 'utf8')
}
