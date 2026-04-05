/**
 * @fileoverview Record mode — call a live LLM, capture tool calls, save as a golden trace.
 *
 * Uses native fetch (Node 18+) with any OpenAI-compatible API.
 * Zero new runtime dependencies.
 *
 * @example
 * ```ts
 * import { recordTrace } from 'agent-vcr'
 *
 * const trace = await recordTrace({
 *   system: 'You are a support agent. Always lookup before refunding.',
 *   user: 'Refund $10 on order 123',
 *   scenario: 'refund_happy_path',
 *   tools: [
 *     {
 *       name: 'lookup_order',
 *       description: 'Look up an order by ID',
 *       parameters: {
 *         type: 'object',
 *         properties: { orderId: { type: 'string' } },
 *         required: ['orderId'],
 *       },
 *     },
 *     {
 *       name: 'refund_order',
 *       description: 'Refund an order',
 *       parameters: {
 *         type: 'object',
 *         properties: {
 *           orderId: { type: 'string' },
 *           amount: { type: 'number' },
 *         },
 *         required: ['orderId', 'amount'],
 *       },
 *     },
 *   ],
 *   stubs: {
 *     lookup_order: { found: true, orderId: '123', balanceCents: 1000 },
 *     refund_order: { ok: true, refundedDollars: 10 },
 *   },
 * })
 * // trace.calls → [{ name: 'lookup_order', args: {...} }, { name: 'refund_order', args: {...} }]
 * ```
 */

import type { AssistantTurn, ChatMessage, ToolCallRecord, ToolCallSpec, TraceFileV1 } from './types.js'

/** JSON Schema object for a tool's parameters. */
export type ToolDefinition = {
  name: string
  description: string
  /** JSON Schema object (type: 'object', properties, required, ...) */
  parameters: Record<string, unknown>
}

/** Configuration for a recording session. */
export type RecordConfig = {
  /** Optional system prompt. */
  system?: string
  /** The user message that kicks off the agent. */
  user: string
  /** Tools the LLM can call. */
  tools: ToolDefinition[]
  /**
   * Stub tool responses keyed by tool name.
   * The stub value is returned verbatim as the tool result during recording
   * so the LLM can continue its reasoning.
   * Defaults to `{ ok: true }` for any unspecified tool.
   */
  stubs?: Record<string, unknown>
  /** Scenario label written into the trace file (optional). */
  scenario?: string
  /** Model to use (default: `gpt-4o-mini`). */
  model?: string
  /**
   * Base URL of the OpenAI-compatible API.
   * Default: `https://api.openai.com/v1`
   * Override to point at Anthropic (via proxy), Azure, Ollama, Groq, etc.
   */
  baseURL?: string
  /**
   * API key. Falls back to `OPENAI_API_KEY` env var.
   */
  apiKey?: string
  /** Max tool-calling rounds (default: 16). */
  maxSteps?: number
  /** Optional progress callback — called after each tool is recorded. */
  onToolCall?: (record: ToolCallRecord, step: number) => void
  /**
   * Override HTTP client (defaults to global `fetch`). Used for tests and custom proxies.
   */
  httpFetch?: typeof fetch
}

// ── Internal types ──────────────────────────────────────────────────────────

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIResponse = {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
  }>
}

// ── Core recording function ──────────────────────────────────────────────────

/**
 * Call a real LLM with the given tools, execute stubs for each tool call,
 * and return the completed trace file.
 *
 * Set `OPENAI_API_KEY` (or pass `config.apiKey`) before calling.
 */
export async function recordTrace(config: RecordConfig): Promise<TraceFileV1> {
  const model = config.model ?? 'gpt-4o-mini'
  const baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'] ?? ''

  if (!apiKey) {
    throw new Error(
      'agent-vcr record: no API key found. Set OPENAI_API_KEY or pass config.apiKey.',
    )
  }

  const maxSteps = config.maxSteps ?? 16
  const messages: OpenAIMessage[] = []

  if (config.system) messages.push({ role: 'system', content: config.system })
  messages.push({ role: 'user', content: config.user })

  const recorded: ToolCallRecord[] = []
  let steps = 0

  const fetchFn = config.httpFetch ?? globalThis.fetch.bind(globalThis)

  while (steps < maxSteps) {
    steps++
    const turn = await callOpenAICompat(messages, config.tools, { model, baseURL, apiKey }, fetchFn)
    const toolCalls = turn.tool_calls

    if (!toolCalls?.length) {
      messages.push({ role: 'assistant', content: turn.content })
      break
    }

    messages.push({
      role: 'assistant',
      content: turn.content,
      tool_calls: toolCalls,
    })

    for (const tc of toolCalls) {
      const name = tc.function.name
      const args = parseArgs(tc.function.arguments)
      const record: ToolCallRecord = { name, args }
      recorded.push(record)
      config.onToolCall?.(record, recorded.length)

      const stubResult = config.stubs?.[name] ?? { ok: true }
      const resultStr = JSON.stringify(stubResult)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr })
    }
  }

  return {
    version: 1,
    ...(config.scenario ? { scenario: config.scenario } : {}),
    calls: recorded,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callOpenAICompat(
  messages: OpenAIMessage[],
  tools: ToolDefinition[],
  opts: { model: string; baseURL: string; apiKey: string },
  fetchFn: typeof fetch,
): Promise<AssistantTurn> {
  const url = `${opts.baseURL}/chat/completions`

  const body = {
    model: opts.model,
    messages,
    tools: tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: 'auto',
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`agent-vcr record: API error ${res.status} from ${url}: ${text}`)
  }

  const data = (await res.json()) as OpenAIResponse
  const msg = data.choices[0]?.message
  if (!msg) throw new Error('agent-vcr record: empty choices in API response')

  const toolCalls: ToolCallSpec[] | undefined = msg.tool_calls?.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }))

  return { content: msg.content, tool_calls: toolCalls }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
    return { _value: v }
  } catch {
    return { _raw: raw }
  }
}

/** Zod schema for a record config JSON file (used by the CLI). */
export type RecordConfigFile = RecordConfig & {
  /** Optional extra metadata (ignored by recordTrace). */
  [key: string]: unknown
}
