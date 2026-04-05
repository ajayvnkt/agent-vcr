/**
 * @fileoverview Vercel AI SDK adapter for Agent VCR.
 *
 * Wraps a Vercel AI SDK `LanguageModel` so it can be used as the `llm`
 * parameter in `collectToolCalls`. Uses structural typing and accepts
 * `generateText` as an injected dependency — no peer dep on `ai`.
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai'
 * import { generateText } from 'ai'
 * import { z } from 'zod'
 * import { collectToolCalls, compareTraces, loadTraceFile } from 'agent-vcr'
 * import { fromVercelAI } from 'agent-vcr/adapters/vercel-ai'
 *
 * const llm = fromVercelAI({
 *   model: openai('gpt-4o-mini'),
 *   generateText,
 *   tools: {
 *     lookup_order: {
 *       description: 'Look up an order by ID',
 *       parameters: z.object({ orderId: z.string() }),
 *     },
 *     refund_order: {
 *       description: 'Refund an order',
 *       parameters: z.object({ orderId: z.string(), amount: z.number() }),
 *     },
 *   },
 * })
 *
 * const recorded = await collectToolCalls({
 *   system: 'You are a support agent.',
 *   user: 'Refund order 123',
 *   llm,
 *   executeTool: async (name, args) => myDispatch(name, args),
 * })
 * ```
 */

import type { AssistantTurn, ChatMessage, ToolCallSpec } from '../types.js'
import type { LlmComplete } from '../loop.js'

// ── Structural types ──────────────────────────────────────────────────────────

/** Minimal shape of a Vercel AI SDK LanguageModel (structural, no import from 'ai'). */
export type VercelLanguageModelLike = object

/** Minimal shape of `generateText` result we use. */
export type VercelGenerateTextResult = {
  text?: string
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }>
}

/** A `generateText`-compatible function (structural). */
export type VercelGenerateTextFn = (options: {
  model: VercelLanguageModelLike
  messages: unknown[]
  tools?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  [key: string]: unknown
}) => Promise<VercelGenerateTextResult>

export type VercelAIAdapterOptions = {
  /** The LanguageModel from `@ai-sdk/openai`, `@ai-sdk/anthropic`, etc. */
  model: VercelLanguageModelLike
  /**
   * Pass `generateText` imported from `ai` directly.
   * This avoids Agent VCR needing a peer dependency on `ai`.
   *
   * ```ts
   * import { generateText } from 'ai'
   * fromVercelAI({ model, generateText, tools })
   * ```
   */
  generateText: VercelGenerateTextFn
  /**
   * Tool definitions in Vercel AI SDK format (with Zod `parameters` or JSON Schema).
   * Pass the same `tools` object you'd give to `generateText`.
   */
  tools?: Record<string, unknown>
  /** Max tokens (default: 4096). */
  maxTokens?: number
  /** Temperature (optional). */
  temperature?: number
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Wrap a Vercel AI SDK model so it can be used as `llm` in `collectToolCalls`.
 *
 * You inject `generateText` from `ai` yourself — Agent VCR doesn't import it.
 */
export function fromVercelAI(options: VercelAIAdapterOptions): { complete: LlmComplete } {
  const { model, generateText, tools, maxTokens = 4096, temperature } = options

  return {
    async complete(messages: ChatMessage[]): Promise<AssistantTurn> {
      const coreMessages = convertToCoreMsgs(messages)

      const result = await generateText({
        model,
        messages: coreMessages,
        ...(tools ? { tools } : {}),
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
      })

      const toolCalls: ToolCallSpec[] = (result.toolCalls ?? []).map((tc) => ({
        id: tc.toolCallId,
        type: 'function' as const,
        function: {
          name: tc.toolName,
          arguments: JSON.stringify(tc.args),
        },
      }))

      return {
        content: result.text ?? null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      }
    },
  }
}

// ── Message conversion ────────────────────────────────────────────────────────

function convertToCoreMsgs(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = []
  const pendingToolResults: Array<{ tool_call_id: string; content: string }> = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      flushToolResults(result, pendingToolResults)
      result.push({ role: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const content: unknown[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            args: tryParseJSON(tc.function.arguments),
          })
        }
      }
      result.push({ role: 'assistant', content })
      continue
    }

    if (msg.role === 'tool') {
      pendingToolResults.push({ tool_call_id: msg.tool_call_id, content: msg.content })
      continue
    }
  }

  flushToolResults(result, pendingToolResults)
  return result
}

function flushToolResults(
  result: unknown[],
  pending: Array<{ tool_call_id: string; content: string }>,
): void {
  if (!pending.length) return
  result.push({
    role: 'tool',
    content: pending.map((tr) => ({
      type: 'tool-result',
      toolCallId: tr.tool_call_id,
      result: tryParseJSON(tr.content),
    })),
  })
  pending.length = 0
}

function tryParseJSON(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return s
  }
}
