/** Strict counterfactual tool-return replay. No live tool executor exists on this interface. */
import type { ChatMessage, ToolCallRecord } from './types.js'
import type { LlmComplete } from './loop.js'
import { callIdentity, exactSnapshot, parseToolArguments, sameIdentity, snapshotAssistantTurn } from './replay-identity.js'

export type RecordedToolReturn = ToolCallRecord & { result: unknown }
export type CounterfactualOptions = {
  prompt: string
  system?: string
  recording: RecordedToolReturn[]
  model: { complete: LlmComplete }
  maxSteps?: number
}
export type CounterfactualResult = {
  status: 'COMPLETE' | 'INCONCLUSIVE'
  reason: string
  consumed: number
  modelCalls: number
  messages: ChatMessage[]
  divergence?: { atCall: number; expected?: ToolCallRecord; actual?: ToolCallRecord }
}

export async function counterfactualReplay(options: CounterfactualOptions): Promise<CounterfactualResult> {
  const messages: ChatMessage[] = []
  let consumed = 0
  let modelCalls = 0
  const finish = (status: CounterfactualResult['status'], reason: string,
    divergence?: CounterfactualResult['divergence']): CounterfactualResult =>
    ({ status, reason, consumed, modelCalls, messages: structuredClone(messages), ...(divergence ? { divergence } : {}) })
  let recording: RecordedToolReturn[]
  try {
    if (typeof options.prompt !== 'string' || !options.prompt.trim() || !Array.isArray(options.recording)) {
      return finish('INCONCLUSIVE', 'invalid prompt or recording')
    }
    recording = exactSnapshot(options.recording)
    if (recording.some(r => typeof r.name !== 'string' || !r.name ||
      !r.args || Array.isArray(r.args) || typeof r.args !== 'object' ||
      !Object.prototype.hasOwnProperty.call(r, 'result'))) {
      return finish('INCONCLUSIVE', 'recording requires exact JSON arguments and a captured result for every call')
    }
    recording.forEach((call, position) => callIdentity(call, position))
  } catch {
    return finish('INCONCLUSIVE', 'invalid or cyclic recording')
  }
  const limit = options.maxSteps ?? 32
  if (!Number.isInteger(limit) || limit < 1) return finish('INCONCLUSIVE', 'invalid step limit')
  if (options.system) messages.push({ role: 'system', content: options.system })
  messages.push({ role: 'user', content: options.prompt })
  const callIds = new Set<string>()
  while (modelCalls < limit) {
    let response
    try {
      modelCalls++
      response = snapshotAssistantTurn(await options.model.complete(structuredClone(messages)))
      if (!response || (response.content !== null && typeof response.content !== 'string') ||
        (response.tool_calls !== undefined && !Array.isArray(response.tool_calls))) {
        return finish('INCONCLUSIVE', 'malformed model response')
      }
    } catch {
      return finish('INCONCLUSIVE', 'model callback failed; no live tool fallback')
    }
    const calls = response.tool_calls ?? []
    if (!calls.length) {
      messages.push({ role: 'assistant', content: response.content })
      return consumed === recording.length
        ? finish('COMPLETE', 'exact recorded tool path consumed; outcome correctness not assessed')
        : finish('INCONCLUSIVE', 'model terminated before consuming recorded tool path', { atCall: consumed })
    }
    // Validate the whole batch before returning any environment result from it.
    for (let i = 0; i < calls.length; i++) {
      const requested = calls[i]!
      let actual: ToolCallRecord
      try {
        if (requested.type !== 'function' || typeof requested.id !== 'string' || !requested.id || callIds.has(requested.id)) {
          return finish('INCONCLUSIVE', 'invalid or reused tool-call identifier')
        }
        callIds.add(requested.id)
        const args = parseToolArguments(requested.function.arguments)
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          return finish('INCONCLUSIVE', 'invalid tool arguments')
        }
        actual = { name: requested.function.name, args }
        callIdentity(actual, consumed + i)
      } catch {
        return finish('INCONCLUSIVE', 'malformed tool request')
      }
      const expected = recording[consumed + i]
      if (!expected || !sameIdentity(callIdentity(expected, consumed + i), callIdentity(actual, consumed + i))) {
        return finish('INCONCLUSIVE', 'requested tool diverges from recording', {
          atCall: consumed + i, actual,
          ...(expected ? { expected: { name: expected.name, args: expected.args } } : {}),
        })
      }
    }
    messages.push({ role: 'assistant', content: response.content, tool_calls: structuredClone(calls) })
    for (const call of calls) {
      const result = recording[consumed++]!.result
      messages.push({ role: 'tool', tool_call_id: call.id,
        content: typeof result === 'string' ? result : JSON.stringify(result) })
    }
  }
  return finish('INCONCLUSIVE', 'step limit reached before final response')
}
