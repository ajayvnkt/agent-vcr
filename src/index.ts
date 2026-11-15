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
  PlannerOutput,
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
export { collectTrace } from './loop.js'
export { replayPlannerRouting } from './planner.js'
export type { PlannerRoutingOptions } from './planner.js'
export type { InitOptions, InitResult } from './init.js'

// ── Live behaviour checks: the optional second layer ──────────────────────────
export { classifyBehavior, classifyRun, describeBehavior, pathId, runBehaviorCheck } from './behavior.js'
export type {
  BehaviorBaseline,
  BehaviorCheckOptions,
  BehaviorClass,
  BehaviorDivergence,
  BehaviorPath,
  BehaviorReport,
  BehaviorRun,
  BehaviorVerdict,
  RunClassification,
} from './behavior.js'
export { BEHAVIOR_COMMENT_MARKER, formatBehaviorConsole, formatBehaviorMarkdown } from './behavior-report.js'
export type { BehaviorMarkdownOptions } from './behavior-report.js'
export { changedComponents, fingerprintInputs, parseFingerprint } from './fingerprint.js'
export type { BehaviorFingerprintV1, BehaviorInputs } from './fingerprint.js'
export {
  loadFingerprintFile,
  loadPolicyFile,
  loadVariantFile,
  parsePolicyFile,
  parseVariantFile,
  saveFingerprintFile,
  saveVariantFile,
} from './behavior-io.js'

// ── check: the deterministic gate over recorded runs ──────────────────────────
export { parseCheckSuite, runCheck } from './check.js'
export type { CheckInput, CheckReport, CheckScenario, CheckScenarioResult, CheckStatus, CheckSuite, RunCheckOptions } from './check.js'
export { CHECK_COMMENT_MARKER, formatCheckHtml, formatCheckMarkdown } from './check-report.js'
export { policyHasRules, rateInterval } from './behavior.js'
export { buildStarterPolicy, scaffoldCheck, unexercisedRuleTools } from './scaffold.js'
export type { ScaffoldOptions, ScaffoldResult, StarterPolicyOptions } from './scaffold.js'

export { assertGrounding, assertTransformationSurvival } from './evidence.js'
export { counterfactualReplay } from './counterfactual.js'
export { diffContext } from './context-diff.js'
export type { ContextComponents, ContextTokenizer, ComponentDelta, ContextDiff } from './context-diff.js'
export type { CounterfactualOptions, CounterfactualResult, RecordedToolReturn } from './counterfactual.js'
export type { GroundingSource, GroundingCitation, GroundingRule, EvidenceFailure,
  TransformationEvent, SurvivalRule } from './evidence.js'
