/**
 * @fileoverview Generic tool-calling loop that records each tool name + parsed args.
 */

import { exactSnapshot, parseExactArguments } from './replay-identity.js'
import type { AssistantTurn, ChatMessage, ToolCallRecord, ToolCallSpec, TraceFileV1, PlannerOutput } from './types.js'

export type LlmComplete = (messages: ChatMessage[]) => Promise<AssistantTurn>

export type ToolExecutorFn = (name: string, args: Record<string, unknown>) => Promise<unknown>

export type CollectOptions = {
  /** Included first when set. */
  system?: string
  user: string
  llm: { complete: LlmComplete }
  executeTool: ToolExecutorFn
  /** Guard against runaway loops (default 32). */
  maxSteps?: number
  /** Explicitly identify this model's emitted content as application planner output. */
  capturePlannerOutput?: boolean
}

function parseToolArguments(raw: string): Record<string, unknown> {
  return parseExactArguments(raw)
}

function randomId(): string {
  return `call_${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Run a multi-turn tool loop: call LLM → if tool_calls, record + execute tools → repeat.
 * Stops when the assistant returns without tool_calls or maxSteps is exceeded.
 */
export async function collectToolCalls(options: CollectOptions): Promise<ToolCallRecord[]> {
  return (await collectTrace(options)).calls
}

/** Collection including planner output, retaining the old calls-only API. */
export async function collectTrace(options: CollectOptions): Promise<TraceFileV1> {
  const maxSteps = options.maxSteps ?? 32
  const messages: ChatMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push({ role: 'user', content: options.user })

  const recorded: ToolCallRecord[] = []
  const plannerOutputs: PlannerOutput[] = []
  let steps = 0

  while (steps < maxSteps) {
    steps++
    const assistant = exactSnapshot(await options.llm.complete(messages), ['tool_calls', 'planner_output'])
    const plan = assistant.planner_output ?? (options.capturePlannerOutput ? assistant.content : null)
    if (plan !== null && plan !== undefined) {
      if (typeof plan !== 'string') throw new Error('planner output must be literal text')
      plannerOutputs.push({ atStep: steps, atCall: recorded.length, callCount: assistant.tool_calls?.length ?? 0, text: plan })
    }
    const toolCalls = assistant.tool_calls

    if (!toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: assistant.content,
      })
      break
    }

    messages.push({
      role: 'assistant',
      content: assistant.content,
      tool_calls: toolCalls,
    })

    for (const tc of toolCalls) {
      await recordAndExecuteOne(tc, recorded, messages, options.executeTool)
    }
  }

  const last = messages[messages.length - 1]
  if (last?.role === 'tool') {
    throw new Error(
      `collectToolCalls: maxSteps (${maxSteps}) exceeded — conversation ended after a tool result without a final assistant turn`,
    )
  }

  return { version: 1, calls: recorded, ...(plannerOutputs.length ? { plannerOutputs } : {}) }
}

async function recordAndExecuteOne(
  tc: ToolCallSpec,
  recorded: ToolCallRecord[],
  messages: ChatMessage[],
  executeTool: ToolExecutorFn,
): Promise<void> {
  if (tc.type !== 'function') {
    throw new Error(`Unsupported tool call type: ${tc.type}`)
  }
  const name = tc.function.name
  const args = parseToolArguments(tc.function.arguments)
  recorded.push({ name, args })
  const result = await executeTool(name, exactSnapshot(args))
  const content = typeof result === 'string' ? result : JSON.stringify(result)
  messages.push({
    role: 'tool',
    tool_call_id: tc.id,
    content,
  })
}

/** Build OpenAI-shaped tool_calls entries with JSON-string arguments. */
export function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string = randomId(),
): ToolCallSpec {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

/** Convenience: assistant turn that only requests tools. */
export function assistantWithTools(
  toolSpecs: ToolCallSpec[],
  content: string | null = null,
): AssistantTurn {
  return { content, tool_calls: toolSpecs }
}

/** Convenience: final text-only assistant turn. */
export function assistantText(content: string): AssistantTurn {
  return { content, tool_calls: undefined }
}
