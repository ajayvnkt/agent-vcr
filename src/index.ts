/**
 * @fileoverview Agent VCR — deterministic tool-call traces for agent CI.
 *
 * Core library: ScriptedLlm, collectToolCalls, compareTraces, record, init.
 * Framework adapters: import from 'agent-vcr/adapters/openai' etc.
 */

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  AssistantTurn,
  ChatMessage,
  CompareMode,
  CompareOptions,
  DiffResult,
  ToolCallRecord,
  ToolCallSpec,
  TraceFileV1,
} from './types.js'

// ── Trace comparison ──────────────────────────────────────────────────────────
export { compareTraces } from './diff.js'
export { stableStringify, callsEqual } from './normalize.js'

// ── Schema + IO ───────────────────────────────────────────────────────────────
export { parseTraceFileV1, safeParseTraceFileV1, traceFileV1Schema } from './schema.js'
export type { ParsedTraceFileV1 } from './schema.js'
export { loadTraceFile, saveTraceFile } from './trace-io.js'

// ── Scripted LLM + tool loop ──────────────────────────────────────────────────
export { ScriptedLlm } from './scripted-llm.js'
export {
  assistantText,
  assistantWithTools,
  collectToolCalls,
  toolCall,
} from './loop.js'
export type { CollectOptions, LlmComplete, ToolExecutorFn } from './loop.js'

// ── Record mode (real LLM → golden trace) ────────────────────────────────────
export { recordTrace } from './record.js'
export type { RecordConfig, RecordConfigFile, ToolDefinition } from './record.js'

// ── Project scaffolding ───────────────────────────────────────────────────────
export { initProject } from './init.js'
export type { InitOptions, InitResult } from './init.js'
