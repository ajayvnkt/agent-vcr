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
export {
  parseTraceFileV1,
  safeParseTraceFileV1,
  traceFileV1Schema,
  parseTraceFile,
  traceFileV2Schema,
  traceFileSchema,
} from './schema.js'
export type { ParsedTraceFileV1, ParsedTraceFileV2 } from './schema.js'

// ── Compaction: cuts as first-class trace events ──────────────────────────────
export {
  collectWithCompaction,
  compactAtTokenBudget,
  estimateTokensByChars,
  tailFromRecentAssistantTurns,
} from './compaction.js'
export type {
  CollectWithCompactionOptions,
  CompactedRun,
  CompactionContext,
  CompactionEvent,
  CompactionPolicy,
} from './compaction.js'

// ── Stability: variance across runs, attributed to cuts ───────────────────────
export { analyzeStability, describeStability, firstDivergence } from './stability.js'
export type {
  RunDivergence,
  RunVerdict,
  StabilityOptions,
  StabilityReport,
} from './stability.js'

// ── Ablation: which summary facts are load-bearing ────────────────────────────
export { ablateSummary, describeAblation, splitByLines } from './ablation.js'
export type { AblationOptions, AblationReport, FactVerdict } from './ablation.js'
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
