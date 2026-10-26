import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectTrace, assistantWithTools, assistantText, toolCall } from '../src/loop.js'
import { collectWithCompaction } from '../src/compaction.js'
import { recordTrace } from '../src/record.js'
import { loadTraceFile } from '../src/trace-io.js'

it.each(['loop', 'compaction', 'record'] as const)('cannot lose precision while capturing plans through %s', async kind => {
  const request = toolCall('read', { id: 0.1 })
  request.function.arguments = '{"id":0.10000000000000001}'
  let step = 0, executed = 0
  const complete = async () => step++ === 0 ? assistantWithTools([request], 'read') : assistantText('done')
  const options = { user: 'task', capturePlannerOutput: true, llm: { complete }, executeTool: async () => { executed++; return 'value' } }
  const result = kind === 'loop' ? collectTrace(options) : kind === 'compaction' ?
    collectWithCompaction({ ...options, compaction: { shouldCompact: () => false, summarize: async () => '' } }) :
    recordTrace({ user: 'task', tools: [], apiKey: 'offline', capturePlannerOutput: true,
      onToolCall: () => { executed++ }, httpFetch: async () => new Response(JSON.stringify({ choices: [{ message: await complete() }] })) })
  await expect(result).rejects.toThrow('numeric argument loses precision')
  expect(executed).toBe(0)
})

it('disk loading cannot erase a distinct fractional argument', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vcr-identity-'))
  try {
    const path = join(dir, 'trace.json')
    await writeFile(path, '{"version":1,"calls":[{"name":"read","args":{"id":0.10000000000000001}}]}')
    await expect(loadTraceFile(path)).rejects.toThrow('numeric argument loses precision')
  } finally { await rm(dir, { recursive: true }) }
})

it('a tool executor cannot rewrite the captured arguments', async () => {
  let step = 0
  const result = await collectTrace({ user: 'task', capturePlannerOutput: true,
    llm: { complete: async () => step++ === 0 ? assistantWithTools([toolCall('read', { id: 1 })], 'read') : assistantText('done') },
    executeTool: async (_name, args) => { args.id = 2; return 'value' } })
  expect(result.calls[0]!.args).toEqual({ id: 1 })
})
