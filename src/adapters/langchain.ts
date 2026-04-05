/**
 * @fileoverview LangChain.js adapter for Agent VCR.
 *
 * Wraps a LangChain `BaseChatModel` so it can be used as the `llm` parameter
 * in `collectToolCalls`. Uses structural typing — no peer dependency on
 * `@langchain/core` or `langchain`.
 *
 * @example
 * ```ts
 * import { ChatOpenAI } from '@langchain/openai'
 * import { collectToolCalls, compareTraces, loadTraceFile } from 'agent-vcr'
 * import { fromLangChain } from 'agent-vcr/adapters/langchain'
 *
 * const chat = new ChatOpenAI({ model: 'gpt-4o-mini' })
 * const llm = fromLangChain(chat.bindTools([lookupOrderTool, refundOrderTool]))
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

/** Minimal subset of LangChain BaseMessage we use. */
export type LangChainMessageLike = {
  _getType?(): string
  content: string | Array<{ type: string; text?: string }>
  tool_calls?: Array<{
    id?: string
    name: string
    args: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
}

/** Minimal subset of LangChain BaseChatModel / RunnableSequence we invoke. */
export type LangChainModelLike = {
  invoke(
    messages: unknown[],
    options?: Record<string, unknown>,
  ): Promise<LangChainMessageLike>
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Wrap a LangChain chat model (or chain with `.bindTools(...)`) so it can be
 * used as `llm` in `collectToolCalls`.
 *
 * Pass a model with tools already bound:
 * ```ts
 * const llm = fromLangChain(chat.bindTools([myTool]))
 * ```
 */
export function fromLangChain(
  model: LangChainModelLike,
): { complete: LlmComplete } {
  return {
    async complete(messages: ChatMessage[]): Promise<AssistantTurn> {
      const lcMessages = convertToLangChain(messages)
      const response = await model.invoke(lcMessages)
      return convertFromLangChain(response)
    },
  }
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function convertToLangChain(messages: ChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === 'system') {
      return { _getType: (): string => 'system', content: msg.content }
    }
    if (msg.role === 'user') {
      return { _getType: (): string => 'human', content: msg.content }
    }
    if (msg.role === 'assistant') {
      return {
        _getType: (): string => 'ai',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          args: tryParseJSON(tc.function.arguments),
        })),
      }
    }
    if (msg.role === 'tool') {
      return {
        _getType: (): string => 'tool',
        content: msg.content,
        tool_call_id: msg.tool_call_id,
      }
    }
    throw new Error(`agent-vcr/adapters/langchain: unknown role in message`)
  })
}

function convertFromLangChain(msg: LangChainMessageLike): AssistantTurn {
  // Extract text content
  let text: string | null = null
  if (typeof msg.content === 'string') {
    text = msg.content || null
  } else if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
    text = textParts.join('') || null
  }

  // Convert LangChain tool_calls to ToolCallSpec[]
  const toolCalls: ToolCallSpec[] | undefined = msg.tool_calls?.map((tc, i) => ({
    id: tc.id ?? `lc_call_${i}`,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.args),
    },
  }))

  return {
    content: text,
    tool_calls: toolCalls?.length ? toolCalls : undefined,
  }
}

function tryParseJSON(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return s
  }
}
