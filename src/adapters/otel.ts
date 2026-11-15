/**
 * @fileoverview OpenTelemetry adapter: turn exported GenAI spans into a tool-call trace.
 *
 * Most agent frameworks, in Python and TypeScript alike, can export
 * OpenTelemetry spans that follow the GenAI semantic conventions. Each tool
 * invocation is one span with `gen_ai.operation.name = "execute_tool"`. Reading
 * those spans gives Agent VCR a trace from any such framework without a
 * per-framework adapter and without a client library in that language: export
 * the spans to a file, then assert, compare and classify here.
 *
 * Attributes read, per span:
 * - `gen_ai.operation.name`      must be `execute_tool`
 * - `gen_ai.tool.name`           tool name (falls back to the span name `execute_tool {name}`)
 * - `gen_ai.tool.call.arguments` JSON text or object
 *
 * Two things to know before relying on it.
 *
 * - **Arguments are often not recorded.** The conventions treat them as
 *   sensitive, so many instrumentations leave them out unless content capture
 *   is switched on. A trace without arguments cannot support argument checks or
 *   exact comparison. By default a span with no arguments is an error; pass
 *   `missingArguments: 'empty'` to accept `{}` and check names and order only.
 * - **The GenAI conventions are still marked Development** by OpenTelemetry and
 *   attribute names have changed between versions. This adapter reads the names
 *   above and nothing else.
 *
 * Spans are tool *executions*. A tool the model requested that the framework
 * refused to run produces no span and so does not appear.
 */

import type { ToolCallRecord } from '../types.js'

export type OtelTraceOptions = {
  /** Keep only spans of this trace id. Needed when a file holds several runs. */
  traceId?: string
  /** What to do when a tool span carries no arguments. Default `error`. */
  missingArguments?: 'error' | 'empty'
  /**
   * How calls are ordered. `time` (default) orders by span start time and
   * refuses a file where any tool span has no readable start time. `file`
   * trusts the order the spans appear in; use it only when you know the export
   * is written in execution order.
   */
  order?: 'time' | 'file'
}

export type OtelTraceResult = {
  calls: ToolCallRecord[]
  /** Tool spans that had no recorded arguments (only non-zero with `missingArguments: 'empty'`). */
  withoutArguments: number
  /** Trace id of the tool spans read: one entry, or none when the spans carry no id. */
  traceIds: string[]
}

type FlatSpan = { name: string; traceId: string; spanId: string; start: bigint; order: number; attributes: Record<string, unknown> }

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** OTLP JSON encodes a value as `{ stringValue }`, `{ intValue }`, and so on. */
function otlpValue(v: unknown): unknown {
  if (!isObject(v)) return v
  if ('stringValue' in v) return v['stringValue']
  if ('boolValue' in v) return v['boolValue']
  if ('intValue' in v) {
    const n = Number(v['intValue'])
    // Keep an integer that a double cannot hold as its exact text instead of a rounded number.
    return Number.isSafeInteger(n) ? n : String(v['intValue'])
  }
  if ('doubleValue' in v) return v['doubleValue']
  if ('arrayValue' in v) {
    const list = isObject(v['arrayValue']) ? v['arrayValue']['values'] : undefined
    return Array.isArray(list) ? list.map(otlpValue) : []
  }
  if ('kvlistValue' in v) {
    const list = isObject(v['kvlistValue']) ? v['kvlistValue']['values'] : undefined
    return Array.isArray(list) ? attributesOf(list) : {}
  }
  // An AnyValue with nothing set carries no value.
  if (Object.keys(v).length === 0) return undefined
  // bytesValue or a shape this adapter does not know: refuse instead of passing the wrapper through as data.
  throw new Error(`agent-vcr/adapters/otel: unsupported attribute value type "${Object.keys(v)[0]}"`)
}

/** Attributes arrive as an OTLP `[{ key, value }]` list or as a plain object. */
function attributesOf(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {}
    for (const kv of raw) {
      if (isObject(kv) && typeof kv['key'] === 'string' && kv['key'] !== '__proto__') out[kv['key']] = otlpValue(kv['value'])
    }
    return out
  }
  return isObject(raw) ? raw : {}
}

/**
 * Start time in nanoseconds, or -1n when it cannot be read with a known unit.
 *
 * Only forms whose unit is unambiguous are accepted: the OTLP nanosecond field,
 * an ISO-8601 string, or a [seconds, nanoseconds] pair. A bare number or digit
 * string under `startTime` could be seconds, milliseconds or nanoseconds, and
 * guessing would order spans wrongly without any error.
 */
function startOf(span: Record<string, unknown>): bigint {
  const nanos = span['startTimeUnixNano'] ?? span['start_time_unix_nano']
  if (typeof nanos === 'bigint') return nanos >= 0n ? nanos : -1n
  if (typeof nanos === 'string' && /^[0-9]+$/.test(nanos)) return BigInt(nanos)
  if (typeof nanos === 'number' && Number.isSafeInteger(nanos) && nanos >= 0) return BigInt(nanos)

  const raw = span['startTime'] ?? span['start_time']
  if (typeof raw === 'string' && !/^[0-9.]+$/.test(raw)) {
    const ms = Date.parse(raw)
    if (!Number.isNaN(ms)) {
      // Date.parse stops at milliseconds; keep any finer digits the string carries.
      const fraction = /\.(\d+)/.exec(raw)?.[1] ?? ''
      const sub = fraction.length > 3 ? BigInt(fraction.slice(3, 9).padEnd(6, '0')) : 0n
      return BigInt(ms) * 1000000n + sub
    }
  }
  // [seconds, nanoseconds], as the JS SDK's in-memory spans carry it
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
    return BigInt(raw[0] as number) * 1000000000n + BigInt(raw[1] as number)
  }
  return -1n
}

/** Trace ids appear as hex in either case, sometimes with a 0x prefix. */
function normaliseId(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, '')
}

function spanIdOf(span: Record<string, unknown>): string {
  const direct = span['spanId'] ?? span['span_id']
  if (typeof direct === 'string') return normaliseId(direct)
  const context = span['context'] ?? span['spanContext']
  if (isObject(context)) {
    const id = context['spanId'] ?? context['span_id']
    if (typeof id === 'string') return normaliseId(id)
  }
  return ''
}

function traceIdOf(span: Record<string, unknown>): string {
  const direct = span['traceId'] ?? span['trace_id']
  if (typeof direct === 'string') return normaliseId(direct)
  const context = span['context'] ?? span['spanContext']
  if (isObject(context)) {
    const id = context['traceId'] ?? context['trace_id']
    if (typeof id === 'string') return normaliseId(id)
  }
  return ''
}

/** Flatten an OTLP JSON export, a list of spans, or JSON Lines already parsed into an array. */
function flatten(input: unknown): FlatSpan[] {
  const spans: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!isObject(node)) return
    const resourceSpans = node['resourceSpans'] ?? node['resource_spans']
    if (Array.isArray(resourceSpans)) {
      for (const rs of resourceSpans) {
        if (!isObject(rs)) continue
        const scopes = rs['scopeSpans'] ?? rs['scope_spans']
        if (!Array.isArray(scopes)) continue
        for (const ss of scopes) {
          if (isObject(ss) && Array.isArray(ss['spans'])) ss['spans'].forEach(visit)
        }
      }
      return
    }
    if (typeof node['name'] === 'string') spans.push(node)
  }
  visit(input)
  return spans.map((span, order) => ({
    name: span['name'] as string,
    traceId: traceIdOf(span),
    spanId: spanIdOf(span),
    start: startOf(span),
    order,
    attributes: attributesOf(span['attributes']),
  }))
}

function parseArguments(raw: unknown, tool: string): Record<string, unknown> {
  if (isObject(raw)) return raw
  if (typeof raw !== 'string') {
    throw new Error(`agent-vcr/adapters/otel: tool "${tool}": gen_ai.tool.call.arguments is neither JSON text nor an object`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`agent-vcr/adapters/otel: tool "${tool}": gen_ai.tool.call.arguments is not valid JSON`)
  }
  if (!isObject(parsed)) {
    throw new Error(`agent-vcr/adapters/otel: tool "${tool}": gen_ai.tool.call.arguments is not a JSON object`)
  }
  return parsed
}

/**
 * Extract the tool-call trace from exported OpenTelemetry spans.
 *
 * Accepts an OTLP JSON export (`{ resourceSpans: [...] }`), an array of those,
 * or a flat array of span objects whose `attributes` are an OTLP list or a
 * plain object. Calls are ordered by span start time.
 */
export function traceFromOtelSpans(input: unknown, options?: OtelTraceOptions): OtelTraceResult {
  const missing = options?.missingArguments ?? 'error'
  const order = options?.order ?? 'time'

  // A tool span is one whose operation is execute_tool. Instrumentations that
  // omit the operation attribute, or vary its case, are still tool spans when
  // the span name or the tool-name attribute says so; dropping them would
  // shorten the trace and let a forbid rule pass.
  const all = flatten(input).filter((s) => {
    const op = s.attributes['gen_ai.operation.name']
    if (typeof op === 'string') return op.toLowerCase() === 'execute_tool'
    return /^execute_tool /i.test(s.name) || typeof s.attributes['gen_ai.tool.name'] === 'string'
  })

  // The same span exported twice is one call.
  const seen = new Set<string>()
  let tools = all.filter((s) => {
    if (s.spanId === '') return true
    const key = `${s.traceId}/${s.spanId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const present = [...new Set(tools.map((s) => s.traceId))].sort()
  if (options?.traceId !== undefined) {
    const wanted = normaliseId(options.traceId)
    tools = tools.filter((s) => s.traceId === wanted)
    if (tools.length === 0 && all.length > 0) {
      // An empty trace satisfies every forbid and requires rule, so a wrong id must not return one.
      const shown = present.filter((id) => id !== '').slice(0, 3).join(', ') || '(spans carry no trace id)'
      throw new Error(`agent-vcr/adapters/otel: no tool span has trace id "${options.traceId}". Trace ids in the file: ${shown}`)
    }
  }

  const ids = [...new Set(tools.map((s) => s.traceId))].sort()
  if (ids.length > 1) {
    // Interleaving two runs would produce a trace neither run made. A span with
    // no trace id next to spans that have one counts as a second run.
    const named = ids.filter((id) => id !== '')
    throw new Error(
      `agent-vcr/adapters/otel: the tool spans belong to ${ids.length} different traces ` +
        `(${named.slice(0, 3).join(', ')}${named.length > 3 ? ', ...' : ''}${ids.includes('') ? ', and spans with no trace id' : ''}). ` +
        'Pass traceId to choose one run.',
    )
  }

  if (order === 'time') {
    if (tools.length > 1 && tools.some((s) => s.start < 0n)) {
      // Sorting an unreadable time first could put a prerequisite ahead of the call that needed it.
      throw new Error(
        'agent-vcr/adapters/otel: a tool span has no readable start time, so call order cannot be established. ' +
          "Export startTimeUnixNano or an ISO startTime, or pass order: 'file' if the file is written in execution order.",
      )
    }
    // Start time, then position in the file for spans that start in the same instant.
    tools.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.order - b.order))
  }

  let withoutArguments = 0
  const calls = tools.map((span): ToolCallRecord => {
    const named = span.attributes['gen_ai.tool.name']
    const fromSpanName = /^execute_tool /i.test(span.name) ? span.name.slice('execute_tool '.length).trim() : ''
    const name = typeof named === 'string' && named !== '' ? named : fromSpanName
    if (name === '') throw new Error('agent-vcr/adapters/otel: an execute_tool span has no gen_ai.tool.name')

    const raw = span.attributes['gen_ai.tool.call.arguments']
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (missing === 'error') {
        throw new Error(
          `agent-vcr/adapters/otel: tool "${name}" has no recorded arguments. Turn on content capture in your instrumentation, ` +
            `or check tool names and order only (missingArguments: 'empty', or --names-only on the command line).`,
        )
      }
      withoutArguments++
      return { name, args: {} }
    }
    return { name, args: parseArguments(raw, name) }
  })

  return { calls, withoutArguments, traceIds: ids.filter((id) => id !== '') }
}

/** Parse the text of an exported span file: one JSON document, or JSON Lines. */
export function parseOtelExport(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return []
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // Collector file exporter and many SDK exporters write one JSON object per line.
    return trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line, i) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          throw new Error(`agent-vcr/adapters/otel: line ${i + 1} is not valid JSON`)
        }
      })
  }
}
