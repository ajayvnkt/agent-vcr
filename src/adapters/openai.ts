/**
 * @fileoverview OpenAI SDK adapter for Agent VCR.
 *
 * Wraps an OpenAI client so it can be used as the `llm` parameter in
 * `collectToolCalls`. Uses structural typing — no peer dependency on `openai`.
 *
 * @example
 * ```ts
 * import OpenAI from 'openai'
 * import { collectToolCalls, compareTraces, loadTraceFile } from 'agent-vcr'
 * import { fromOpenAI } from 'agent-vcr/adapters/openai'
 *
 * const client = new OpenAI()
 * const llm = fromOpenAI(client, 'gpt-4o-mini')
 *
 * const recorded = await collectToolCalls({
 *   system: 'You are a support agent.',
 *   user: 'Refund order 123',
 *   llm,
 *   executeTool: async (name, args) => myDispatch(name, args),
 * })
 *
 * const expected = await loadTraceFile('traces/refund.expected.json')
 * const result = compareTraces(expected.calls, recorded)
 * if (!result.ok) throw new Error(result.reason)
 * ```
 */

import type { AssistantTurn, ChatMessage, ToolCallSpec } from '../types.js'
import type { LlmComplete } from '../loop.js'

// ── Structural types (no import from 'openai' package) ───────────────────────

/** Minimal subset of the OpenAI chat completions API we need. */
export type OpenAIClientLike = {
  chat: {
    completions: {
      create(params: {
        model: string
        messages: unknown[]
        [key: string]: unknown
      }): Promise<OpenAICompletionLike>
    }
  }
}

export type OpenAICompletionLike = {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
  }>
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * Wrap an OpenAI SDK client so it can be used as `llm` in `collectToolCalls`.
 *
 * Pass any extra ChatCompletion params (temperature, tools, etc.) via `extraParams`.
 * Note: Agent VCR does NOT pass tool definitions — your agent's tools are expressed
 * through the `executeTool` callback. If you need the model to know the tool schemas,
 * pass them via `extraParams.tools`.
 */
export function fromOpenAI(
  client: OpenAIClientLike,
  model: string,
  extraParams?: Record<string, unknown>,
): { complete: LlmComplete } {
  return {
    async complete(messages: ChatMessage[]): Promise<AssistantTurn> {
      const response = await client.chat.completions.create({
        model,
        messages: messages as unknown[],
        ...extraParams,
      })

      const msg = response.choices[0]?.message
      if (!msg) throw new Error('agent-vcr/adapters/openai: no message in response')

      const toolCalls: ToolCallSpec[] | undefined = msg.tool_calls
        ?.filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }))

      return { content: msg.content, tool_calls: toolCalls?.length ? toolCalls : undefined }
    },
  }
}
