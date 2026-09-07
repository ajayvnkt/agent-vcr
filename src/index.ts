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

// ── Assertions: free, deterministic policy checks ─────────────────────────────
export { assertTrace, callMatches, checkArg, traceSatisfies } from './assert.js'
export type {
  ArgMatcher,
  AssertionFailure,
  AssertionFailureKind,
  ToolExpectation,
  ToolPattern,
  TraceAssertion,
} from './assert.js'

// ── Variants: more than one correct path ──────────────────────────────────────
export { addVariant, matchVariants, proposeVariants } from './variants.js'
export type { Variant, VariantFileV1, VariantMatch } from './variants.js'

// ── Summary contracts: the compaction schema, enforced ────────────────────────
export { contractFromAblation, verifyRunContract, verifySummary } from './contract.js'
export type {
  ContractFact,
  ContractResult,
  ContractViolation,
  SummaryContract,
} from './contract.js'

// ── Judge: the optional paid tier ─────────────────────────────────────────────
export { assertOutput, keywordJudge, llmJudge } from './judge.js'
export type { Judge, JudgeInput, JudgeVerdict, OutputAssertion } from './judge.js'

// ── Scenarios: multi-turn tests ───────────────────────────────────────────────
export { runScenario, runScenarioRepeated } from './scenario.js'
export type {
  RepeatedScenarioResult,
  RunScenarioOptions,
  Scenario,
  ScenarioAgent,
  ScenarioAgentFactory,
  ScenarioRunResult,
  Tier,
  Turn,
  TurnOutcome,
  TurnResult,
} from './scenario.js'

// ── Suite + reporters ─────────────────────────────────────────────────────────
export { runSuite } from './suite.js'
export type { SuiteGate, SuiteResult, SuiteScenarioOutcome } from './suite.js'
export { formatConsole, formatJson, formatMarkdown, runFailures } from './report.js'
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
