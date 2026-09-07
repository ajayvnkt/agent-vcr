/**
 * @fileoverview Compaction-aware tool loop.
 *
 * Long-horizon agents run out of context mid-task and summarize their own history
 * to continue. That summary is an *action taken by the policy* — it rewrites the
 * agent's own observations — so it belongs in the trace like any other call.
 *
 * `collectWithCompaction` is `collectToolCalls` plus a compaction policy: it records
 * where each compaction happened, what summary was written, and what was dropped,
 * so downstream tooling can attribute behaviour changes to a specific cut.
 */

import type { ChatMessage, ToolCallRecord, ToolCallSpec } from './types.js'
import type { LlmComplete, ToolExecutorFn } from './loop.js'

/** One context cut inside a run. */
export type CompactionEvent = {
  /** Index into `calls[]` of the next tool call recorded after this cut. */
  atCall: number
  /** Loop step at which the cut happened (1-based). */
  atStep: number
  /** The summary the policy wrote. */
  summary: string
  /** Messages discarded by the cut. */
  droppedMessages: number
  /** Assistant turns preserved verbatim after the summary. */
  keptRecentTurns: number
  /** Rough context size before/after, in the estimator's units. */
  tokensBefore: number
  tokensAfter: number
}

export type CompactedRun = {
  calls: ToolCallRecord[]
  compactions: CompactionEvent[]
  steps: number
  /** Final assistant text, when the run ended cleanly. */
  finalContent: string | null
}

export type CompactionContext = {
  messages: ChatMessage[]
  step: number
  approxTokens: number
}

export type CompactionPolicy = {
  /** Called before each model turn. Return true to cut now. */
  shouldCompact: (ctx: CompactionContext) => boolean
  /** Produce the summary that replaces the dropped history. */
  summarize: (messages: ChatMessage[]) => Promise<string>
  /** Assistant turns (plus their tool results) kept verbatim after the summary. Default 2. */
  keepRecentTurns?: number
  /** Wrap the summary into the resumed user turn. */
  resume?: (summary: string) => string
  /** Override the context-size estimate. Default: characters / 4. */
  estimateTokens?: (messages: ChatMessage[]) => number
}

export type CollectWithCompactionOptions = {
  system?: string
  user: string
  llm: { complete: LlmComplete }
  executeTool: ToolExecutorFn
  maxSteps?: number
  compaction: CompactionPolicy
}

const DEFAULT_KEEP_RECENT_TURNS = 2

function defaultResume(summary: string): string {
  return [
    'Your earlier context was compacted. This is the record of work so far:',
    '',
    summary,
    '',
    'Continue the task from here.',
  ].join('\n')
}

/** Cheap, dependency-free context estimate. Swap via `estimateTokens` for a real tokenizer. */
export function estimateTokensByChars(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length
      }
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Slice the tail starting at the k-th-from-last assistant turn.
 *
 * Cutting on an arbitrary index can orphan a `tool` message whose matching
 * assistant `tool_calls` was dropped, which most providers reject. Anchoring on
 * assistant turns keeps every call paired with its result.
 */
export function tailFromRecentAssistantTurns(messages: ChatMessage[], k: number): ChatMessage[] {
  if (k <= 0) return []
  const assistantIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'assistant') assistantIdx.push(i)
  }
  if (assistantIdx.length === 0) return []
  const start = assistantIdx[Math.max(0, assistantIdx.length - k)]!
  return messages.slice(start)
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed === '') return {}
  try {
    const v = JSON.parse(trimmed) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
    return { _value: v as unknown }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid JSON in tool arguments: ${msg}`)
  }
}

/**
 * Run a tool loop that compacts its own context when the policy says to,
 * recording each cut alongside the tool calls.
 */
export async function collectWithCompaction(
  options: CollectWithCompactionOptions,
): Promise<CompactedRun> {
  const maxSteps = options.maxSteps ?? 64
  const policy = options.compaction
  const keepRecent = policy.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS
  const resume = policy.resume ?? defaultResume
  const estimate = policy.estimateTokens ?? estimateTokensByChars

  const systemMsg: ChatMessage | null = options.system
    ? { role: 'system', content: options.system }
    : null

  let messages: ChatMessage[] = []
  if (systemMsg) messages.push(systemMsg)
  messages.push({ role: 'user', content: options.user })

  const calls: ToolCallRecord[] = []
  const compactions: CompactionEvent[] = []
  let steps = 0
  let finalContent: string | null = null

  while (steps < maxSteps) {
    steps++

    const approxTokens = estimate(messages)
    if (policy.shouldCompact({ messages, step: steps, approxTokens })) {
      const summary = await policy.summarize(messages)
      const tail = tailFromRecentAssistantTurns(messages, keepRecent)
      const rebuilt: ChatMessage[] = []
      if (systemMsg) rebuilt.push(systemMsg)
      rebuilt.push({ role: 'user', content: resume(summary) })
      rebuilt.push(...tail)

      compactions.push({
        atCall: calls.length,
        atStep: steps,
        summary,
        droppedMessages: messages.length - tail.length - (systemMsg ? 1 : 0),
        keptRecentTurns: tail.filter((m) => m.role === 'assistant').length,
        tokensBefore: approxTokens,
        tokensAfter: estimate(rebuilt),
      })

      messages = rebuilt
    }

    const assistant = await options.llm.complete(messages)
    const toolCalls = assistant.tool_calls

    if (!toolCalls?.length) {
      messages.push({ role: 'assistant', content: assistant.content })
      finalContent = assistant.content
      break
    }

    messages.push({
      role: 'assistant',
      content: assistant.content,
      tool_calls: toolCalls,
    })

    for (const tc of toolCalls) {
      await recordAndExecuteOne(tc, calls, messages, options.executeTool)
    }
  }

  const last = messages[messages.length - 1]
  if (last?.role === 'tool') {
    throw new Error(
      `collectWithCompaction: maxSteps (${maxSteps}) exceeded — conversation ended after a tool result without a final assistant turn`,
    )
  }

  return { calls, compactions, steps, finalContent }
}

async function recordAndExecuteOne(
  tc: ToolCallSpec,
  calls: ToolCallRecord[],
  messages: ChatMessage[],
  executeTool: ToolExecutorFn,
): Promise<void> {
  if (tc.type !== 'function') {
    throw new Error(`Unsupported tool call type: ${tc.type}`)
  }
  const name = tc.function.name
  const args = parseToolArguments(tc.function.arguments)
  calls.push({ name, args })
  const result = await executeTool(name, args)
  const content = typeof result === 'string' ? result : JSON.stringify(result)
  messages.push({ role: 'tool', tool_call_id: tc.id, content })
}

/**
 * `shouldCompact` that cuts whenever the estimated context passes `budget`.
 * Stateful — build one per run.
 */
export function compactAtTokenBudget(budget: number): (ctx: CompactionContext) => boolean {
  let lastCutStep = -1
  return (ctx: CompactionContext) => {
    if (ctx.approxTokens < budget) return false
    if (ctx.step === lastCutStep) return false
    lastCutStep = ctx.step
    return true
  }
}
