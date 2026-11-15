import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseCheckSuite, runCheck } from '../src/check.js'
import { formatCheckHtml, formatCheckMarkdown } from '../src/check-report.js'
import { assertTrace } from '../src/assert.js'
import { parsePolicyFile } from '../src/behavior-io.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')
const examples = join(root, 'examples', 'check-suite')

const lookup = { name: 'lookup_order', args: { orderId: '1' } }
const verify = { name: 'verify_order', args: { orderId: '1' } }
const refund = { name: 'refund_order', args: { orderId: '1', amount: 40 } }

function workspace(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vcr-check-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}
const trace = (calls: unknown[]) => ({ version: 1, calls })
const policy = { requires: [['refund_order', 'verify_order']] }
const kv = (key: string, stringValue: string) => ({ key, value: { stringValue } })
const span = (name: string, args: unknown, t: string) => ({
  traceId: 't1', spanId: `s${t}`, name: `execute_tool ${name}`, startTimeUnixNano: t,
  attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', name), ...(args === undefined ? [] : [kv('gen_ai.tool.call.arguments', JSON.stringify(args))])],
})

describe('policy conformance cases', () => {
  const file = JSON.parse(readFileSync(join(root, 'conformance', 'policy-cases.json'), 'utf8')) as {
    cases: { name: string; policy: unknown; calls: { name: string; args: Record<string, unknown> }[]; kinds: string[] }[]
  }
  it('has cases', () => expect(file.cases.length).toBeGreaterThan(20))
  for (const bad of (file as unknown as { invalid: { name: string; policy: unknown }[] }).invalid) {
    it(`rejects: ${bad.name}`, () => expect(() => parsePolicyFile(bad.policy)).toThrow())
  }
  it('does not treat inherited property names as arguments', () => {
    const calls = [{ name: 'a', args: {} }]
    expect(assertTrace(calls, { includes: [{ name: 'a', args: { toString: { exists: true } } }] }).map((f) => f.kind)).toEqual(['args'])
    expect(assertTrace(calls, { includes: [{ name: 'a', args: { constructor: { absent: true } } }] })).toEqual([])
  })
  for (const c of file.cases) {
    it(c.name, () => {
      const kinds = assertTrace(c.calls, parsePolicyFile(c.policy)).map((f) => f.kind).sort()
      expect(kinds).toEqual(c.kinds)
    })
  }
})

describe('runCheck', () => {
  it('passes the example suite, including a run read from OpenTelemetry spans', async () => {
    const r = await runCheck(join(examples, 'suite.json'), { now: () => new Date('2026-11-14T00:00:00Z'), tool: 'agent-vcr@test' })
    expect(r.verdict).toBe('pass')
    expect(r.scenarios.map((s) => [s.status, s.class])).toEqual([['pass', 'golden'], ['pass', 'golden']])
    expect(r.generatedAt).toBe('2026-11-14T00:00:00.000Z')
    expect(r.scenarios[1]!.inputs.map((i) => i.role)).toEqual(['policy', 'otel', 'golden'])
    expect(r.scenarios[1]!.inputs.every((i) => /^[0-9a-f]{64}$/.test(i.sha256))).toBe(true)
  })

  it('fails the regressed example with the broken rule and the divergence', async () => {
    const r = await runCheck(join(examples, 'suite.failing.json'))
    expect(r.verdict).toBe('fail')
    const bad = r.scenarios[1]!
    expect(bad.status).toBe('fail')
    expect(bad.failures[0]!.kind).toBe('requires')
    expect(bad.divergence!.index).toBe(1)
  })

  it('judges a run on policy alone when there is no golden trace', async () => {
    const dir = workspace({
      'p.json': policy, 'ok.json': trace([lookup, verify, refund]), 'bad.json': trace([refund]),
      's.json': { version: 1, policy: 'p.json', scenarios: [{ name: 'ok', trace: 'ok.json' }, { name: 'bad', trace: 'bad.json' }] },
    })
    const r = await runCheck(join(dir, 's.json'))
    expect(r.scenarios.map((s) => s.status)).toEqual(['pass', 'fail'])
    expect(r.scenarios[0]!.class).toBeNull()
  })

  it('reports an unapproved path for review, and an approved one as a pass', async () => {
    const dir = workspace({
      'p.json': policy, 'g.json': trace([lookup, verify, refund]), 'run.json': trace([verify, lookup, refund]),
      'v.json': { version: 1, variants: [{ name: 'verify-first', calls: [verify, lookup, refund] }] },
      's.json': { version: 1, policy: 'p.json', scenarios: [
        { name: 'new', trace: 'run.json', golden: 'g.json' },
        { name: 'approved', trace: 'run.json', golden: 'g.json', variants: 'v.json' },
      ] },
    })
    const r = await runCheck(join(dir, 's.json'))
    expect(r.verdict).toBe('review')
    expect(r.scenarios.map((s) => [s.status, s.variant])).toEqual([['review', null], ['pass', 'verify-first']])
  })

  it('turns every scenario it cannot judge into an error, and an error fails the check', async () => {
    const dir = workspace({
      'p.json': policy, 'typo.json': { requirez: [] }, 'run.json': trace([lookup]), 'broken.json': '{not json',
      'noargs.json': [span('verify_order', undefined, '1'), span('refund_order', undefined, '2')],
      'argpolicy.json': { includes: [{ name: 'refund_order', args: { amount: { absent: true } } }] },
      'chat.json': [{ traceId: 't1', name: 'chat', startTimeUnixNano: '1', attributes: [kv('gen_ai.operation.name', 'chat')] }],
      's.json': { version: 1, scenarios: [
        { name: 'no baseline', trace: 'run.json' },
        { name: 'missing file', trace: 'nope.json', policy: 'p.json' },
        { name: 'broken json', trace: 'broken.json', policy: 'p.json' },
        { name: 'policy typo', trace: 'run.json', policy: 'typo.json' },
        { name: 'no arguments', otel: 'noargs.json', policy: 'p.json' },
        { name: 'names only with argument policy', otel: 'noargs.json', namesOnly: true, policy: 'argpolicy.json' },
        { name: 'names only with golden', otel: 'noargs.json', namesOnly: true, policy: 'p.json', golden: 'run.json' },
        { name: 'no tool spans', otel: 'chat.json', policy: 'p.json' },
        { name: 'names only with order policy', otel: 'noargs.json', namesOnly: true, policy: 'p.json' },
      ] },
    })
    const r = await runCheck(join(dir, 's.json'))
    expect(r.scenarios.map((s) => s.status)).toEqual(['error', 'error', 'error', 'error', 'error', 'error', 'error', 'error', 'pass'])
    expect(r.scenarios[0]!.reason).toMatch(/nothing to check against/)
    expect(r.scenarios[3]!.reason).toMatch(/unknown rule "requirez"/)
    expect(r.scenarios[5]!.reason).toMatch(/policy checks tool arguments/)
    expect(r.scenarios[7]!.reason).toMatch(/no tool spans/)
    expect(r.verdict).toBe('fail')
    expect(r.counts).toEqual({ pass: 1, review: 0, fail: 0, error: 8 })
  })

  it('refuses duplicate keys, a self-comparison, and an empty run judged by policy alone', async () => {
    const dir = workspace({
      'strict.json': { forbid: ['lookup_order'] }, 'lax.json': { forbid: ['never'] }, 'run.json': trace([lookup]), 'empty.json': trace([]),
      'dupe.json': '{"version":1,"policy":"strict.json","policy":"lax.json","scenarios":[{"name":"a","trace":"run.json"}]}',
      's.json': { version: 1, policy: 'lax.json', scenarios: [
        { name: 'self', trace: 'run.json', golden: './run.json' },
        { name: 'empty by policy', trace: 'empty.json' },
        { name: 'empty as expected', trace: 'empty.json', golden: 'run.json' },
      ] },
      'e2.json': trace([]),
      's2.json': { version: 1, scenarios: [{ name: 'nothing expected, nothing done', trace: 'empty.json', golden: 'e2.json' }] },
    })
    await expect(runCheck(join(dir, 'dupe.json'))).rejects.toThrow(/Invalid JSON/)
    const r = await runCheck(join(dir, 's.json'))
    expect(r.scenarios.map((s) => s.status)).toEqual(['error', 'error', 'review'])
    expect(r.scenarios[0]!.reason).toMatch(/same file/)
    expect(r.scenarios[1]!.reason).toMatch(/no tool calls/)
    expect((await runCheck(join(dir, 's2.json'))).verdict).toBe('pass')
  })

  it('refuses a malformed suite file', () => {
    const s = { name: 'a', trace: 't.json' }
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ ...s, variants: 'v.json' }] })).toThrow(/need a "golden" trace/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ ...s, mode: 'subsequence' }] })).toThrow(/need a "golden" trace/)
    expect(() => parseCheckSuite({ version: 1, policy: '', scenarios: [s] })).toThrow(/non-empty path/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [] })).toThrow(/non-empty/)
    expect(() => parseCheckSuite({ version: 1, polcy: 'p.json', scenarios: [s] })).toThrow(/unknown key "polcy"/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ ...s, goldn: 'g.json' }] })).toThrow(/unknown key "goldn"/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ name: 'a' }] })).toThrow(/exactly one of/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ ...s, otel: 'o.json' }] })).toThrow(/exactly one of/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [s, s] })).toThrow(/duplicate scenario name/)
    expect(() => parseCheckSuite({ version: 1, scenarios: [{ ...s, namesOnly: true }] })).toThrow(/"otel" inputs only/)
    expect(() => parseCheckSuite({ version: 2, scenarios: [s] })).toThrow(/version/)
  })
})

describe('check reports', () => {
  it('escapes hostile names in markdown and HTML', async () => {
    const hostile = '</h2><script>alert(1)</script> `x` | @everyone\r\n# pwned'
    const dir = workspace({
      'p.json': { forbid: ['delete_account'] },
      'run.json': trace([{ name: 'delete_account', args: { note: '<img src=x onerror=alert(1)>' } }]),
      's.json': { version: 1, name: hostile, policy: 'p.json', scenarios: [{ name: hostile, trace: 'run.json' }] },
    })
    const r = await runCheck(join(dir, 's.json'))
    const html = formatCheckHtml(r)
    expect(html).not.toMatch(/<script>|<img /)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/<link|<iframe|javascript:/i)
    const md = formatCheckMarkdown(r)
    expect(md.split('\n').filter((l) => /^#+ .*pwned/.test(l))).toEqual([])
    for (const line of md.split('\n').filter((l) => l.includes('@everyone'))) expect(/`[^`]*@everyone[^`]*`/.test(line)).toBe(true)
  })

  it('leaves no backslash in front of a pipe inside a table cell', async () => {
    const dir = workspace({
      'p.json': { forbid: ['x'] }, 'run.json': trace([{ name: 'a\\|[link](https://e.example)', args: {} }]),
      's.json': { version: 1, policy: 'p.json', scenarios: [{ name: 'n\\\\|m', trace: 'run.json' }] },
    })
    const md = formatCheckMarkdown(await runCheck(join(dir, 's.json')))
    expect(md).not.toMatch(/\\\\\|/)
    expect(md).toContain('a\\|[link]')
  })
})

describe('cli check', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cli, 'check', ...args], { encoding: 'utf8' })

  it('writes the bundle and exits by verdict', () => {
    const out = mkdtempSync(join(tmpdir(), 'vcr-check-out-'))
    const ok = run(['--suite', join(examples, 'suite.json'), '--out-dir', out])
    expect(ok.status).toBe(0)
    for (const f of ['results.json', 'report.md', 'report.html']) expect(existsSync(join(out, f))).toBe(true)
    const bundle = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
    expect(bundle.verdict).toBe('pass')
    expect(bundle.tool).toMatch(/^agent-vcr@\d/)
    expect(run(['--suite', join(examples, 'suite.failing.json')]).status).toBe(1)
  })

  it('exits 1 for review only under --strict, and 2 for an unreadable suite', () => {
    const dir = workspace({
      'g.json': trace([lookup, verify, refund]), 'run.json': trace([verify, lookup, refund]), 'p.json': policy,
      's.json': { version: 1, policy: 'p.json', scenarios: [{ name: 'new', trace: 'run.json', golden: 'g.json' }] },
    })
    expect(run(['--suite', join(dir, 's.json')]).status).toBe(0)
    expect(run(['--suite', join(dir, 's.json'), '--strict']).status).toBe(1)
    expect(run(['--suite', join(dir, 'missing.json')]).status).toBe(2)
    expect(run([]).status).toBe(2)
  })
})
