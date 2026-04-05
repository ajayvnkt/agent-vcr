/**
 * @fileoverview Anthropic SDK adapter for Agent VCR.
 *
 * Wraps an Anthropic client so it can be used as the `llm` parameter in
 * `collectToolCalls`. Uses structural typing — no peer dependency on `@anthropic-ai/sdk`.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk'
 * import { collectToolCalls, compareTraces, loadTraceFile } from 'agent-vcr'
 * import { fromAnthropic } from 'agent-vcr/adapters/anthropic'
 *
 * const client = new Anthropic()
 * const llm = fromAnthropic(client, 'claude-3-5-sonnet-20241022', {
 *   tools: [
 *     {
 *       name: 'lookup_order',
 *       description: 'Look up an order by ID',
 *       input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
 *     },
 *   ],
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

export type AnthropicClientLike = {
  messages: {
    create(params: {
      model: string
      max_tokens: number
      system?: string
      messages: unknown[]
      tools?: unknown[]
      [key: string]: unknown
    }): Promise<AnthropicMessageLike>
  }
}

export type AnthropicMessageLike = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  stop_reason: string
}

export type AnthropicAdapterOptions = {
  /** Tool definitions in Anthropic format (with `input_schema`). */
  tools?: unknown[]
  /** Max tokens for each completion (default: 4096). */
  maxTokens?: number
  /** Any extra params forwarded to `messages.create`. */
  [key: string]: unknown
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Wrap an Anthropic SDK client so it can be used as `llm` in `collectToolCalls`.
 *
 * Anthropic uses a different message format than OpenAI — this adapter
 * converts Agent VCR's OpenAI-shaped messages to Anthropic's format and back.
 */
export function fromAnthropic(
  client: AnthropicClientLike,
  model: string,
  options: AnthropicAdapterOptions = {},
): { complete: LlmComplete } {
  const { tools, maxTokens = 4096, ...extraParams } = options

  return {
    async complete(messages: ChatMessage[]): Promise<AssistantTurn> {
      // Extract system message (Anthropic takes it separately)
      const systemMsg = messages.find((m) => m.role === 'system')
      const nonSystem = messages.filter((m) => m.role !== 'system')

      // Convert OpenAI-shaped messages to Anthropic format
      const anthropicMessages = convertMessages(nonSystem)

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(systemMsg ? { system: systemMsg.content as string } : {}),
        messages: anthropicMessages,
        ...(tools ? { tools } : {}),
        ...extraParams,
      })

      // Convert Anthropic response back to AssistantTurn
      return convertResponse(response)
    },
  }
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function convertMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'system') continue // handled separately

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const content: unknown[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            const parsed = JSON.parse(tc.function.arguments) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>
            }
          } catch {
            // ignore parse errors
          }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
      }
      result.push({ role: 'assistant', content: content.length ? content : '' })
      continue
    }

    if (msg.role === 'tool') {
      // Anthropic tool results go in a user message with type: 'tool_result'
      result.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      })
      continue
    }
  }

  return result
}

function convertResponse(response: AnthropicMessageLike): AssistantTurn {
  let textContent: string | null = null
  const toolCalls: ToolCallSpec[] = []

  for (const block of response.content) {
    if (block.type === 'text') {
      textContent = block.text
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }

  return {
    content: textContent,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  }
}
