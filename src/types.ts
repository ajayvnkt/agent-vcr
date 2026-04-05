/**
 * @fileoverview Core types for tool-call traces and chat messages (OpenAI-shaped).
 */

/** One tool invocation captured for comparison / fixtures. */
export type ToolCallRecord = {
  name: string
  args: Record<string, unknown>
}

/** Trace file schema version 1 (JSON on disk). */
export type TraceFileV1 = {
  version: 1
  scenario?: string
  calls: ToolCallRecord[]
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCallSpec[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolCallSpec = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Assistant turn returned by an LLM adapter inside the collection loop. */
export type AssistantTurn = {
  content: string | null
  tool_calls?: ToolCallSpec[]
}

export type CompareMode = 'exact' | 'subsequence'

export type CompareOptions = {
  mode?: CompareMode
}

export type DiffOk = { ok: true }

export type DiffMismatch = {
  ok: false
  reason: string
  index?: number
  expected?: ToolCallRecord
  actual?: ToolCallRecord
}

export type DiffResult = DiffOk | DiffMismatch
