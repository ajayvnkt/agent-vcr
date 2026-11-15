import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseOtelExport, traceFromOtelSpans } from '../src/adapters/otel.js'
import { scriptedGraphModel } from '../src/adapters/langgraph.js'
import { assertTrace } from '../src/assert.js'

const kv = (key: string, stringValue: string) => ({ key, value: { stringValue } })
const toolSpan = (name: string, args: unknown, start: string, traceId = 't1') => ({
  traceId,
  spanId: `s${start}`,
  name: `execute_tool ${name}`,
  startTimeUnixNano: start,
  attributes: [
    kv('gen_ai.operation.name', 'execute_tool'),
    kv('gen_ai.tool.name', name),
    ...(args === undefined ? [] : [kv('gen_ai.tool.call.arguments', JSON.stringify(args))]),
  ],
})
const chatSpan = { traceId: 't1', name: 'chat gpt-4o', startTimeUnixNano: '5', attributes: [kv('gen_ai.operation.name', 'chat')] }
const otlp = (spans: unknown[]) => ({ resourceSpans: [{ resource: {}, scopeSpans: [{ scope: { name: 'x' }, spans }] }] })

describe('OpenTelemetry adapter', () => {
  it('reads execute_tool spans from an OTLP export, ordered by start time, ignoring other spans', () => {
    const r = traceFromOtelSpans(otlp([
      toolSpan('refund_order', { orderId: '1', amount: 40 }, '30'),
      chatSpan,
      toolSpan('lookup_order', { orderId: '1' }, '10'),
      toolSpan('verify_order', { orderId: '1' }, '20'),
    ]))
    expect(r.calls).toEqual([
      { name: 'lookup_order', args: { orderId: '1' } },
      { name: 'verify_order', args: { orderId: '1' } },
      { name: 'refund_order', args: { orderId: '1', amount: 40 } },
    ])
    expect(r.traceIds).toEqual(['t1'])
    expect(assertTrace(r.calls, { requires: [['refund_order', 'verify_order']] })).toEqual([])
  })

  it('orders nanosecond timestamps beyond the safe integer range correctly', () => {
    const r = traceFromOtelSpans([
      toolSpan('b', {}, '1763164800000000002'),
      toolSpan('a', {}, '1763164800000000001'),
    ])
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('reads flat spans with plain-object attributes, object arguments and the span-name fallback', () => {
    const r = traceFromOtelSpans([
      { name: 'execute_tool search', trace_id: 'x', start_time: '2026-11-14T00:00:01Z', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.arguments': { q: 'a' } } },
      { name: 'whatever', trace_id: 'x', start_time: '2026-11-14T00:00:00Z', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'plan', 'gen_ai.tool.call.arguments': '{}' } },
    ])
    expect(r.calls).toEqual([{ name: 'plan', args: {} }, { name: 'search', args: { q: 'a' } }])
  })

  it('refuses a file where call order cannot be established, unless file order is requested', () => {
    const timed = toolSpan('refund_order', {}, '5')
    const untimed = { ...toolSpan('verify_order', {}, '0'), startTimeUnixNano: undefined, timestamp: '1' }
    expect(() => traceFromOtelSpans([timed, untimed])).toThrow(/no readable start time/)
    // A bare number under startTime has no known unit.
    expect(() => traceFromOtelSpans([timed, { ...untimed, startTime: 1763164800200 }])).toThrow(/no readable start time/)
    expect(() => traceFromOtelSpans([timed, { ...untimed, startTime: '1763164800200' }])).toThrow(/no readable start time/)
    expect(() => traceFromOtelSpans([timed, { ...untimed, startTime: [1.5, 2] }])).toThrow(/no readable start time/)
    expect(traceFromOtelSpans([timed, untimed], { order: 'file' }).calls.map((c) => c.name)).toEqual(['refund_order', 'verify_order'])
    expect(traceFromOtelSpans([untimed]).calls).toHaveLength(1)
  })

  it('keeps sub-millisecond order from ISO timestamps', () => {
    const iso = (name: string, t: string) => ({ name: `execute_tool ${name}`, startTime: t, attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.arguments': '{}' } })
    const r = traceFromOtelSpans([iso('b', '2026-11-14T00:00:00.000900Z'), iso('a', '2026-11-14T00:00:00.000100Z')])
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('never returns an empty trace for a trace id that matches nothing, and normalises ids', () => {
    const spans = [toolSpan('refund_order', {}, '1', 'AB12')]
    expect(() => traceFromOtelSpans(spans, { traceId: 'ffff' })).toThrow(/no tool span has trace id "ffff".*ab12/)
    expect(traceFromOtelSpans(spans, { traceId: '0xab12' }).calls).toHaveLength(1)
    expect(traceFromOtelSpans([{ ...toolSpan('a', {}, '1'), traceId: undefined, context: { trace_id: '0xAB12' } }], { traceId: 'ab12' }).calls).toHaveLength(1)
  })

  it('refuses spans with no trace id mixed into a run that has one', () => {
    const orphan = { ...toolSpan('b', {}, '2'), traceId: undefined }
    expect(() => traceFromOtelSpans([toolSpan('a', {}, '1'), orphan, toolSpan('c', {}, '3')])).toThrow(/spans with no trace id/)
  })

  it('does not drop a tool span that omits or re-cases the operation attribute', () => {
    const noOp = { traceId: 't1', spanId: 'x1', name: 'execute_tool refund_order', startTimeUnixNano: '2', attributes: [kv('gen_ai.tool.name', 'refund_order'), kv('gen_ai.tool.call.arguments', '{}')] }
    const cased = { traceId: 't1', spanId: 'x2', name: 'tool', startTimeUnixNano: '3', attributes: [kv('gen_ai.operation.name', 'Execute_Tool'), kv('gen_ai.tool.name', 'delete_account'), kv('gen_ai.tool.call.arguments', '{}')] }
    const r = traceFromOtelSpans([toolSpan('verify_order', {}, '1'), noOp, cased, chatSpan])
    expect(r.calls.map((c) => c.name)).toEqual(['verify_order', 'refund_order', 'delete_account'])
    expect(assertTrace(r.calls, { forbid: ['delete_account'] })).toHaveLength(1)
  })

  it('counts an exported span once and treats unset or unknown argument values as missing or an error', () => {
    const a = toolSpan('a', { x: 1 }, '1')
    expect(traceFromOtelSpans([a, a]).calls).toHaveLength(1)
    const withValue = (value: unknown) => [{ name: 'execute_tool a', attributes: [kv('gen_ai.operation.name', 'execute_tool'), { key: 'gen_ai.tool.call.arguments', value }] }]
    expect(() => traceFromOtelSpans(withValue({}))).toThrow(/no recorded arguments/)
    expect(() => traceFromOtelSpans(withValue({ stringValue: '' }))).toThrow(/no recorded arguments/)
    expect(() => traceFromOtelSpans(withValue({ bytesValue: 'e30=' }))).toThrow(/unsupported attribute value type "bytesValue"/)
    expect(traceFromOtelSpans(withValue({ kvlistValue: {} })).calls[0]!.args).toEqual({})
    const nested = { kvlistValue: { values: [{ key: 'id', value: { intValue: '9007199254740993' } }, { key: 'n', value: { intValue: '7' } }] } }
    expect(traceFromOtelSpans(withValue(nested)).calls[0]!.args).toEqual({ id: '9007199254740993', n: 7 })
  })

  it('refuses spans without arguments unless asked to check names only', () => {
    const spans = [toolSpan('lookup_order', undefined, '1'), toolSpan('refund_order', { orderId: '1' }, '2')]
    expect(() => traceFromOtelSpans(spans)).toThrow(/no recorded arguments/)
    const r = traceFromOtelSpans(spans, { missingArguments: 'empty' })
    expect(r.calls).toEqual([{ name: 'lookup_order', args: {} }, { name: 'refund_order', args: { orderId: '1' } }])
    expect(r.withoutArguments).toBe(1)
  })

  it('refuses to interleave two runs and selects one by trace id', () => {
    const spans = [toolSpan('a', {}, '1', 't1'), toolSpan('b', {}, '2', 't2'), toolSpan('c', {}, '3', 't1')]
    expect(() => traceFromOtelSpans(spans)).toThrow(/2 different traces/)
    expect(traceFromOtelSpans(spans, { traceId: 't1' }).calls.map((c) => c.name)).toEqual(['a', 'c'])
  })

  it('throws on unreadable arguments and nameless tool spans', () => {
    const bad = (value: string) => [{ name: 'execute_tool x', attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', 'x'), kv('gen_ai.tool.call.arguments', value)] }]
    expect(() => traceFromOtelSpans(bad('{oops'))).toThrow(/not valid JSON/)
    expect(() => traceFromOtelSpans(bad('[1]'))).toThrow(/not a JSON object/)
    expect(() => traceFromOtelSpans([{ name: 'tool', attributes: [kv('gen_ai.operation.name', 'execute_tool')] }])).toThrow(/no gen_ai.tool.name/)
  })

  it('parses a single JSON document and JSON Lines', () => {
    const doc = otlp([toolSpan('a', {}, '1')])
    expect(traceFromOtelSpans(parseOtelExport(JSON.stringify(doc))).calls).toHaveLength(1)
    const lines = [otlp([toolSpan('a', {}, '1')]), otlp([toolSpan('b', {}, '2')])].map((d) => JSON.stringify(d)).join('\n')
    expect(traceFromOtelSpans(parseOtelExport(lines)).calls.map((c) => c.name)).toEqual(['a', 'b'])
    expect(() => parseOtelExport('{"a":1}\nnot json')).toThrow(/line 2/)
    expect(parseOtelExport('  ')).toEqual([])
  })

  it('converts a span file to a trace file from the CLI', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const cli = join(root, 'dist', 'cli.js')
    const dir = mkdtempSync(join(tmpdir(), 'vcr-otel-'))
    const spans = join(dir, 'spans.json')
    const out = join(dir, 'trace.json')
    writeFileSync(spans, JSON.stringify(otlp([toolSpan('lookup_order', { orderId: '1' }, '1'), toolSpan('refund_order', undefined, '2')])))
    const strict = spawnSync(process.execPath, [cli, 'from-otel', spans, '--out', out], { encoding: 'utf8' })
    expect(strict.status).toBe(2)
    expect(strict.stderr).toMatch(/no recorded arguments/)
    expect(strict.stderr).toMatch(/--names-only/)
    const loose = spawnSync(process.execPath, [cli, 'from-otel', spans, '--out', out, '--names-only', '--scenario', 'refund'], { encoding: 'utf8' })
    expect(loose.status).toBe(0)
    expect(loose.stderr).toMatch(/1 call\(s\) had no recorded arguments/)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      version: 1,
      scenario: 'refund',
      calls: [{ name: 'lookup_order', args: { orderId: '1' } }, { name: 'refund_order', args: {} }],
    })
    expect(spawnSync(process.execPath, [cli, 'validate', out], { encoding: 'utf8' }).status).toBe(0)
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, JSON.stringify(otlp([chatSpan])))
    const rejected = spawnSync(process.execPath, [cli, 'from-otel', empty, '--names-only'], { encoding: 'utf8' })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toMatch(/chat span\(s\).*no executed-tool evidence/)
    expect(rejected.stderr).toMatch(/Instrument the tool executor/)
    expect(rejected.stderr).toMatch(/--names-only cannot recover/)
    expect(rejected.stdout).toBe('')
  })
})

describe('scriptedGraphModel', () => {
  const calls = [{ name: 'lookup_order', args: { orderId: '1' } }, { name: 'refund_order', args: { orderId: '1' } }]

  it('replays a trace one call per turn, then a final text turn, then refuses', async () => {
    const model = scriptedGraphModel(calls).bindTools([])
    const a = await model.invoke()
    expect(a['role']).toBe('assistant')
    expect(a['tool_calls']).toEqual([{ name: 'lookup_order', args: { orderId: '1' }, id: 'vcr_1_0', type: 'tool_call' }])
    await model.invoke()
    const last = await model.invoke()
    expect(last['tool_calls']).toBeUndefined()
    expect(last['content']).toBe('Done.')
    expect(model.remaining()).toBe(0)
    await expect(model.invoke()).rejects.toThrow(/no more turns/)
  })

  it('refuses a mixed script and does not share arguments with the recording', async () => {
    expect(() => scriptedGraphModel([calls[0]!, { calls: [calls[1]!] }] as never)).toThrow(/not a mix/)
    expect(() => scriptedGraphModel([{ content: 'hi', name: 'assistant' }] as never)).not.toThrow()
    const source = [{ name: 'a', args: { list: [1] } }]
    const turn = await scriptedGraphModel(source).invoke()
    ;((turn['tool_calls'] as { args: { list: number[] } }[])[0]!.args.list).push(2)
    expect(source[0]!.args.list).toEqual([1])
    const empty = scriptedGraphModel([])
    expect((await empty.invoke())['content']).toBe('Done.')
  })

  it('accepts explicit turns, including parallel calls', async () => {
    const model = scriptedGraphModel([{ calls }, { content: 'All set.' }])
    expect(((await model.invoke())['tool_calls'] as unknown[]).length).toBe(2)
    expect((await model.invoke())['content']).toBe('All set.')
  })
})
