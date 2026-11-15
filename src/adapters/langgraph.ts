/**
 * @fileoverview LangGraph.js adapter for Agent VCR.
 *
 * The other adapters wrap a chat model so Agent VCR can drive the tool loop. A
 * LangGraph graph owns its own loop, so this adapter works the other way round:
 * it runs your compiled graph and reads the tool-call trace back out of the
 * message state. The trace is then an ordinary `ToolCallRecord[]`, so golden
 * comparison, policy assertions, approved paths, stability analysis and live
 * behaviour checks all apply to it unchanged.
 *
 * Uses structural typing. There is no dependency on `@langchain/langgraph` or
 * `@langchain/core`; any object with a compatible `invoke` works.
 *
 * What is recorded is every tool call the model *requested*, in message order,
 * which is what the rest of Agent VCR records. Whether a tool node then ran the
 * tool is not checked here.
 *
 * @example
 * ```ts
 * import { assertTrace } from 'agent-vcr'
 * import { collectFromLangGraph } from 'agent-vcr/adapters/langgraph'
 *
 * const { calls } = await collectFromLangGraph(graph, {
 *   messages: [{ role: 'user', content: 'Refund order 4471' }],
 * })
 * const failures = assertTrace(calls, { requires: [['refund_order', 'verify_order']] })
 * ```
 */

import type { ToolCallRecord } from '../types.js'

/** One tool call as it appears on a LangChain AI message or an OpenAI-shaped dict. */
export type LangGraphToolCallLike = {
  name?: unknown
  args?: unknown
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

/**
 * Minimal view of a message in graph state. Covers LangChain message classes
 * (`type`, or the older `getType()` / `_getType()`), serialized messages
 * (`{ type: 'ai' }`, `toDict()` output, and `JSON.stringify` output) and
 * OpenAI-shaped dicts (`{ role: 'assistant' }`).
 */
export type LangGraphMessageLike = {
  type?: unknown
  role?: unknown
  getType?: () => string
  _getType?: () => string
  tool_calls?: unknown
  /** LangChain puts tool calls it could not parse here instead of in `tool_calls`. */
  invalid_tool_calls?: unknown
}

/** Minimal view of a compiled graph or agent: something with `invoke`. */
export type LangGraphLike<I = unknown, S = unknown> = {
  invoke(input: I, config?: Record<string, unknown>): Promise<S>
}

export type LangGraphTraceOptions = {
  /** State key that holds the message list. Default `messages`. */
  messagesKey?: string
  /**
   * Leading messages to ignore. Use it when the input already carries earlier
   * turns whose tool calls are history, not behaviour under test. Default 0.
   *
   * It is a count on purpose. Dropping "the messages I passed in" by identity
   * would silently lose calls in a graph that trims or rewrites its history.
   */
  skipMessages?: number
}

export type CollectFromLangGraphOptions = LangGraphTraceOptions & {
  /** Passed to `graph.invoke` as its second argument (thread id, recursion limit, ...). */
  config?: Record<string, unknown>
}

const STORED_TYPES = ['ai', 'human', 'system', 'tool', 'function', 'generic', 'remove', 'developer']

/**
 * Unwrap the two serialized forms LangChain produces, so a state that has been
 * through JSON (a checkpoint, a log, `toDict()`) reads the same as live objects.
 *
 * - `JSON.stringify(message)` gives `{ lc: 1, type: 'constructor', id: [..., 'AIMessage'], kwargs }`
 * - `message.toDict()` gives `{ type: 'ai', data: { ... } }`
 */
function unwrap(msg: Record<string, unknown>): Record<string, unknown> {
  if (msg['lc'] === 1 && msg['type'] === 'constructor' && isObject(msg['kwargs']) && Array.isArray(msg['id'])) {
    const cls = msg['id'][msg['id'].length - 1]
    return { ...msg['kwargs'], type: typeof cls === 'string' ? cls : undefined }
  }
  if (typeof msg['type'] === 'string' && STORED_TYPES.includes(msg['type']) && isObject(msg['data']) && msg['tool_calls'] === undefined) {
    return { ...msg['data'], type: msg['type'] }
  }
  return msg
}

function messageType(msg: LangGraphMessageLike): string | null {
  if (typeof msg.type === 'string') return msg.type
  if (typeof msg.getType === 'function') return msg.getType()
  if (typeof msg._getType === 'function') return msg._getType()
  if (typeof msg.role === 'string') return msg.role
  return null
}

function isAssistant(type: string | null): boolean {
  return type === 'ai' || type === 'assistant' || type === 'AIMessage' || type === 'AIMessageChunk'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function toRecord(call: LangGraphToolCallLike, where: string): ToolCallRecord {
  // LangChain shape: { name, args: object }
  if (typeof call.name === 'string') {
    if (call.args === undefined || call.args === null) return { name: call.name, args: {} }
    if (!isObject(call.args)) {
      throw new Error(`agent-vcr/adapters/langgraph: ${where}: tool call "${call.name}" has non-object args`)
    }
    return { name: call.name, args: call.args }
  }
  // OpenAI shape: { function: { name, arguments: JSON string } }
  const fn = call.function
  if (isObject(fn) && typeof fn['name'] === 'string') {
    const raw = fn['arguments']
    if (raw === undefined || raw === null || raw === '') return { name: fn['name'], args: {} }
    if (isObject(raw)) return { name: fn['name'], args: raw }
    if (typeof raw !== 'string') {
      throw new Error(`agent-vcr/adapters/langgraph: ${where}: tool call "${fn['name']}" has unreadable arguments`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`agent-vcr/adapters/langgraph: ${where}: tool call "${fn['name']}" has arguments that are not valid JSON`)
    }
    if (!isObject(parsed)) {
      throw new Error(`agent-vcr/adapters/langgraph: ${where}: tool call "${fn['name']}" arguments are not a JSON object`)
    }
    return { name: fn['name'], args: parsed }
  }
  throw new Error(`agent-vcr/adapters/langgraph: ${where}: tool call has no name`)
}

/**
 * Extract the tool-call trace from a list of graph messages.
 *
 * Malformed tool calls throw instead of being skipped: a trace with a call
 * silently missing would pass assertions it should fail.
 */
export function traceFromMessages(
  messages: readonly unknown[],
  options?: Pick<LangGraphTraceOptions, 'skipMessages'>,
): ToolCallRecord[] {
  const skip = options?.skipMessages ?? 0
  if (!Number.isInteger(skip) || skip < 0) {
    throw new Error('agent-vcr/adapters/langgraph: skipMessages must be a non-negative integer')
  }
  const calls: ToolCallRecord[] = []
  for (let i = skip; i < messages.length; i++) {
    const raw = messages[i]
    // Strings and [role, text] tuples are valid LangGraph input and cannot carry tool calls.
    if (!isObject(raw)) continue
    const msg = unwrap(raw)
    const like = msg as LangGraphMessageLike
    const type = messageType(like)
    if (type === null) {
      // Skipping a message of unknown kind could skip the one that made a call.
      throw new Error(`agent-vcr/adapters/langgraph: message ${i}: cannot tell what kind of message this is (no type or role)`)
    }
    if (!isAssistant(type)) continue
    // A call the framework could not parse is still a call the model made.
    // Leaving it out would shorten the trace and could turn a failure into a pass.
    if (Array.isArray(like.invalid_tool_calls) && like.invalid_tool_calls.length > 0) {
      throw new Error(
        `agent-vcr/adapters/langgraph: message ${i}: the model emitted ${like.invalid_tool_calls.length} tool call(s) that could not be parsed`,
      )
    }
    let toolCalls = like.tool_calls
    if (toolCalls === undefined || toolCalls === null || (Array.isArray(toolCalls) && toolCalls.length === 0)) {
      // Older and provider-native shapes keep the calls elsewhere. Read them
      // instead of reporting an assistant turn with calls as having none.
      toolCalls = fallbackToolCalls(msg)
    }
    if (toolCalls === undefined || toolCalls === null) continue
    if (!Array.isArray(toolCalls)) {
      throw new Error(`agent-vcr/adapters/langgraph: message ${i}: tool_calls is not an array`)
    }
    toolCalls.forEach((tc, j) => {
      if (!isObject(tc)) throw new Error(`agent-vcr/adapters/langgraph: message ${i}: tool call ${j} is not an object`)
      calls.push(toRecord(tc as LangGraphToolCallLike, `message ${i}, tool call ${j}`))
    })
  }
  return calls
}

/** Tool calls stored outside `tool_calls`: OpenAI raw kwargs, legacy function_call, Anthropic content blocks. */
function fallbackToolCalls(msg: Record<string, unknown>): unknown {
  const extra = msg['additional_kwargs']
  if (isObject(extra)) {
    if (Array.isArray(extra['tool_calls']) && extra['tool_calls'].length > 0) return extra['tool_calls']
    if (isObject(extra['function_call'])) return [{ function: extra['function_call'] }]
  }
  if (Array.isArray(msg['content'])) {
    const blocks = msg['content'].filter((b) => isObject(b) && b['type'] === 'tool_use')
    if (blocks.length > 0) {
      return blocks.map((b) => {
        const block = b as Record<string, unknown>
        return { name: block['name'], args: block['input'] ?? {} }
      })
    }
  }
  return undefined
}

/** Extract the tool-call trace from a graph's final state. */
export function traceFromState(state: unknown, options?: LangGraphTraceOptions): ToolCallRecord[] {
  const key = options?.messagesKey ?? 'messages'
  if (!isObject(state)) {
    throw new Error('agent-vcr/adapters/langgraph: graph state is not an object')
  }
  const messages = state[key]
  if (!Array.isArray(messages)) {
    throw new Error(`agent-vcr/adapters/langgraph: state has no "${key}" array. Set messagesKey if your graph stores messages under another key.`)
  }
  return traceFromMessages(messages, options)
}

/**
 * Invoke a compiled graph once and return its tool-call trace with the final state.
 *
 * Works with a `StateGraph(...).compile()` result and with the prebuilt agents,
 * which expose the same `invoke`.
 */
export async function collectFromLangGraph<I, S>(
  graph: LangGraphLike<I, S>,
  input: I,
  options?: CollectFromLangGraphOptions,
): Promise<{ calls: ToolCallRecord[]; state: S }> {
  const state = options?.config === undefined ? await graph.invoke(input) : await graph.invoke(input, options.config)
  return { calls: traceFromState(state, options), state }
}
