import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectTrace, assistantText, assistantWithTools, toolCall } from '../src/loop.js'
import { replayPlannerRouting } from '../src/planner.js'
import { parseTraceFile } from '../src/schema.js'
import { saveTraceFile, loadTraceFile } from '../src/trace-io.js'
import { recordTrace } from '../src/record.js'
import { collectWithCompaction } from '../src/compaction.js'
import type { TraceFileV1 } from '../src/types.js'

const trace: TraceFileV1 = { version: 1, calls: [{ name: 'read', args: { id: 'x' } }],
  plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 1, text: 'read x' }, { atStep: 2, atCall: 1, callCount: 0, text: 'done' }] }
const route = (text: string) => text === 'done' ? [] : [{ name: 'read', args: { id: text.split(' ')[1] } }]

it('captures explicit planner text and preserves it through disk and schema normalization', async () => {
  let step = 0
  const result = await collectTrace({ user: 'task', capturePlannerOutput: true,
    llm: { complete: async () => step++ === 0 ? assistantWithTools([toolCall('read', { id: 'x' })], 'read x') : assistantText('done') },
    executeTool: async () => 'value' })
  expect(result).toEqual(trace)
  const dir = await mkdtemp(join(tmpdir(), 'vcr-plan-'))
  try {
    await saveTraceFile(join(dir, 'trace.json'), result)
    const loaded = await loadTraceFile(join(dir, 'trace.json'))
    expect(loaded.plannerOutputs).toEqual(trace.plannerOutputs)
    expect(parseTraceFile(loaded).plannerOutputs).toEqual(trace.plannerOutputs)
  } finally { await rm(dir, { recursive: true }) }
})

it('replays the router with zero inference or tool calls and detects changed routing', () => {
  const matched = replayPlannerRouting({ trace, route, routerId: 'router-v1' })
  expect(matched.status).toBe('PASS')
  expect(matched.plans.map(p => p.status)).toEqual(['PASS', 'PASS'])
  expect(matched.modelCalls).toBe(0)
  expect(matched.toolCalls).toBe(0)
  const changed = replayPlannerRouting({ trace, routerId: 'router-v2', route: text => text === 'done' ? [] : [{ name: 'write', args: { id: 'x' } }] })
  expect(changed.status).toBe('UNKNOWN')
  expect(changed.plans[0]!.actual[0]!.name).toBe('write')
})

it('missing, invalid and nondeterministic planner evidence is UNKNOWN', () => {
  expect(replayPlannerRouting({ trace: { version: 1, calls: [] }, route, routerId: 'v1' }).status).toBe('UNKNOWN')
  expect(replayPlannerRouting({ trace: { ...trace, plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 1, text: '' }] }, route, routerId: 'v1' }).status).toBe('UNKNOWN')
  let calls = 0
  expect(replayPlannerRouting({ trace, routerId: 'v1', route: () => [{ name: String(calls++), args: {} }] }).status).toBe('UNKNOWN')
  expect(replayPlannerRouting({ trace: { ...trace, calls: [{ name: 'read', args: { id: 9007199254740992 } }] }, route, routerId: 'v1' }).status).toBe('UNKNOWN')
  expect(replayPlannerRouting({ trace, routerId: 'v1', route: () => { throw new Error('bad plan') } }).status).toBe('UNKNOWN')
})

it('ordinary assistant text is not silently relabelled as a plan', async () => {
  const result = await collectTrace({ user: 'task', llm: { complete: async () => assistantText('done') }, executeTool: async () => null })
  expect(result).toEqual({ version: 1, calls: [] })
  expect(replayPlannerRouting({ trace: result, route, routerId: 'v1' }).status).toBe('UNKNOWN')
})

it('rejects uncovered spans, missing counts, sparse arrays and malformed routes', () => {
  const missing = { ...trace, plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 0, text: 'done' }] }
  expect(replayPlannerRouting({ trace: missing, route, routerId: 'v1' }).status).toBe('UNKNOWN')
  const sparse = { ...trace, calls: [{ name: 'read', args: { items: new Array(1) } }] }
  expect(replayPlannerRouting({ trace: sparse, route, routerId: 'v1' }).status).toBe('UNKNOWN')
  expect(replayPlannerRouting({ trace, routerId: 'v1', route: () => [{}] as never }).status).toBe('UNKNOWN')
})

it('captures planner output in record and compaction paths without changing legacy defaults', async () => {
  const recorded = await recordTrace({ user: 'task', tools: [], apiKey: 'offline-test', capturePlannerOutput: true,
    httpFetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 }) })
  expect(recorded.plannerOutputs).toEqual([{ atStep: 1, atCall: 0, callCount: 0, text: 'done' }])
  const compacted = await collectWithCompaction({ user: 'task',
    llm: { complete: async () => ({ content: 'done', planner_output: 'explicit plan' }) },
    executeTool: async () => null, compaction: { shouldCompact: () => false, summarize: async () => '' } })
  expect(compacted.plannerOutputs).toEqual([{ atStep: 1, atCall: 0, callCount: 0, text: 'explicit plan' }])
})
