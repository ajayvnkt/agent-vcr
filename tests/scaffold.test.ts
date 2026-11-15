import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildStarterPolicy, scaffoldCheck, unexercisedRuleTools } from '../src/scaffold.js'
import { runCheck } from '../src/check.js'
import { classifyBehavior, rateInterval } from '../src/behavior.js'
import { formatBehaviorMarkdown } from '../src/behavior-report.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')
const fresh = () => mkdtempSync(join(tmpdir(), 'vcr-init-'))
const run = (args: string[]) => spawnSync(process.execPath, [cli, 'init-check', ...args], { encoding: 'utf8' })

describe('buildStarterPolicy', () => {
  it('builds each starter shape', () => {
    expect(buildStarterPolicy({ require: [['refund_order', 'verify_order']] })).toEqual({ requires: [['refund_order', 'verify_order']] })
    expect(buildStarterPolicy({ forbid: ['delete_account', 'delete_account', 'drop_table'] })).toEqual({ forbid: ['delete_account', 'drop_table'] })
    expect(buildStarterPolicy({ maxCalls: 20, maxCallsPerTool: 3 })).toEqual({ maxCalls: 20, maxCallsPerTool: 3 })
  })

  it('refuses to write a policy with no rules or contradictory rules', () => {
    expect(() => buildStarterPolicy({})).toThrow(/no rules given/)
    expect(() => buildStarterPolicy({ require: [], forbid: [] })).toThrow(/no rules given/)
    expect(() => buildStarterPolicy({ require: [['a', 'a']] })).toThrow(/own prerequisite/)
    expect(() => buildStarterPolicy({ require: [['refund', 'verify']], forbid: ['verify'] })).toThrow(/both required by a rule and forbidden/)
    expect(() => buildStarterPolicy({ maxCalls: -1 })).toThrow(/non-negative/)
  })
})

describe('unexercisedRuleTools', () => {
  it('names requires-rule tools the runs never call, and ignores forbidden tools', () => {
    const policy = { requires: [['refund_order', 'verify_order']] as [string, string][], forbid: ['delete_account'] }
    expect(unexercisedRuleTools(policy, [[{ name: 'verify_order', args: {} }]])).toEqual(['refund_order'])
    expect(unexercisedRuleTools(policy, [[{ name: 'verify_order', args: {} }], [{ name: 'refund_order', args: {} }]])).toEqual([])
  })
})

describe('scaffoldCheck', () => {
  it('writes a scaffold whose example run passes its own check, with chained rules in a valid order', async () => {
    const dir = fresh()
    const r = await scaffoldCheck({ dir, require: [['ship', 'pay'], ['pay', 'verify']], forbid: ['delete_account'], maxCallsPerTool: 2 })
    expect(r.created.sort()).toEqual(['.github/workflows/agent-checks.yml', 'agent-vcr.suite.json', 'policy.json', 'traces/example.run.json'])
    expect(r.example).toBe(true)
    const trace = JSON.parse(readFileSync(join(dir, 'traces/example.run.json'), 'utf8'))
    expect(trace.calls.map((c: { name: string }) => c.name)).toEqual(['verify', 'pay', 'ship'])
    expect((await runCheck(r.suitePath)).verdict).toBe('pass')
    expect(readFileSync(join(dir, '.github/workflows/agent-checks.yml'), 'utf8')).toMatch(/uses: ajayvnkt\/agent-vcr@main\n\s+with:\n\s+suite: agent-vcr\.suite\.json/)
  })

  const written = (dir: string) => ['policy.json', 'agent-vcr.suite.json', 'traces', '.github'].filter((f) => existsSync(join(dir, f)))

  it('refuses to scaffold over an existing policy, suite or run, and writes nothing', async () => {
    for (const [name, body] of [['policy.json', '{"maxCalls":1000}'], ['agent-vcr.suite.json', '{"version":1}']] as const) {
      const dir = fresh()
      writeFileSync(join(dir, name), body)
      await expect(scaffoldCheck({ dir, forbid: ['delete_account'] })).rejects.toThrow(/already exists.*Nothing was written/)
      expect(written(dir)).toEqual([name])
      expect(readFileSync(join(dir, name), 'utf8')).toBe(body)
    }
    // Scaffolding twice: the second run must not leave the first run's weaker setup looking like a pass.
    const dir = fresh()
    await scaffoldCheck({ dir, require: [['refund_order', 'verify_order']] })
    await expect(scaffoldCheck({ dir, require: [['refund_order', 'verify_order']] })).rejects.toThrow(/already exist/)
  })

  it('leaves an existing workflow file alone and reports it', async () => {
    const dir = fresh()
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'agent-checks.yml'), 'mine')
    const r = await scaffoldCheck({ dir, forbid: ['x'] })
    expect(r.skipped).toEqual(['.github/workflows/agent-checks.yml'])
    expect(readFileSync(join(dir, '.github', 'workflows', 'agent-checks.yml'), 'utf8')).toBe('mine')
  })

  it('refuses rules that cannot work, before writing anything', async () => {
    const src = fresh()
    const good = join(src, 'good.json')
    writeFileSync(good, JSON.stringify({ version: 1, calls: [{ name: 'z', args: {} }] }))
    const cases: [object, RegExp][] = [
      [{ require: [['a', 'b'], ['b', 'a']] }, /cycle/],
      [{ require: [['a', 'b'], ['b', 'a']], from: good }, /cycle/],
      [{ maxCalls: 0 }, /no room for even a minimal run/],
      [{ require: [['a', 'b']], maxCalls: 1 }, /no room for even a minimal run/],
      [{ maxCallsPerTool: 0 }, /no room for even a minimal run/],
      [{ maxCalls: 1e23 }, /whole number/],
    ]
    for (const [options, message] of cases) {
      const dir = fresh()
      await expect(scaffoldCheck({ dir, ...options })).rejects.toThrow(message)
      expect(written(dir)).toEqual([])
    }
    const forbidExample = await scaffoldCheck({ dir: fresh(), forbid: ['example_tool'] })
    expect((await runCheck(forbidExample.suitePath)).verdict).toBe('pass')
    expect(buildStarterPolicy({ require: [['a', 'b'], ['a', 'b']] })).toEqual({ requires: [['a', 'b']] })
  })

  it('reports why a --from file is unusable, and leaves no partial scaffold on a late failure', async () => {
    const src = fresh()
    const file = (name: string, body: string) => { const p = join(src, name); writeFileSync(p, body); return p }
    const cases: [string, RegExp, object?][] = [
      [file('junk.json', '{"hello":1}'), /not an Agent VCR trace file, and it contains no OpenTelemetry tool spans/],
      [file('v2.json', '{"version":2,"calls":[]}'), /does not match trace schema version 1/],
      [file('dupe.json', '{"version":1,"calls":[{"name":"a","args":{"x":1,"x":2}}]}'), /not a usable trace file/],
      [file('ok.json', '{"version":1,"calls":[{"name":"a","args":{}}]}'), /apply to OpenTelemetry span files only/, { namesOnly: true }],
    ]
    for (const [from, message, extra] of cases) {
      const dir = fresh()
      await expect(scaffoldCheck({ dir, forbid: ['x'], from, ...extra })).rejects.toThrow(message)
      expect(written(dir)).toEqual([])
    }
    const blocked = fresh()
    writeFileSync(join(blocked, 'traces'), 'a file where a directory is needed')
    await expect(scaffoldCheck({ dir: blocked, forbid: ['x'] })).rejects.toThrow()
    expect(existsSync(join(blocked, 'policy.json'))).toBe(false)
  })

  it('takes a real run from a trace file or a span file', async () => {
    const src = fresh()
    const trace = join(src, 't.json')
    writeFileSync(trace, JSON.stringify({ version: 1, calls: [{ name: 'verify_order', args: { id: 1 } }, { name: 'refund_order', args: { id: 1 } }] }))
    const a = await scaffoldCheck({ dir: fresh(), require: [['refund_order', 'verify_order']], from: trace })
    expect(a.example).toBe(false)
    expect((await runCheck(a.suitePath)).verdict).toBe('pass')

    const kv = (key: string, stringValue: string) => ({ key, value: { stringValue } })
    const span = (name: string, t: string) => ({ traceId: 't', spanId: t, name: `execute_tool ${name}`, startTimeUnixNano: t, attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', name), kv('gen_ai.tool.call.arguments', '{}')] })
    const spans = join(src, 's.json')
    writeFileSync(spans, JSON.stringify([span('refund_order', '1')]))
    const b = await scaffoldCheck({ dir: fresh(), require: [['refund_order', 'verify_order']], from: spans })
    const report = await runCheck(b.suitePath)
    expect(report.verdict).toBe('fail')
    expect(b.unexercised).toEqual(['verify_order'])
  })
})

describe('cli init-check', () => {
  it('scaffolds, runs the first check and exits 0', () => {
    const dir = fresh()
    const r = run(['--dir', dir, '--require', 'refund_order:verify_order', '--forbid', 'delete_account, drop_table', '--max-calls', '20'])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/\+ policy\.json/)
    expect(r.stderr).toMatch(/generated example/)
    expect(r.stderr).toMatch(/pass\s+example run/)
    expect(JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'))).toEqual({
      requires: [['refund_order', 'verify_order']], forbid: ['delete_account', 'drop_table'], maxCalls: 20,
    })
  })

  it('exits 1 and says why when the real first run already breaks the policy', () => {
    const src = fresh()
    const trace = join(src, 't.json')
    writeFileSync(trace, JSON.stringify({ version: 1, calls: [{ name: 'refund_order', args: {} }] }))
    const r = run(['--dir', fresh(), '--require', 'refund_order:verify_ordr', '--from', trace])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/requires a prior "verify_ordr"/)
    expect(r.stderr).toMatch(/warning: "verify_ordr" is named in a --require rule but never appears/)
  })

  it('refuses a repeated flag instead of keeping only the last value', () => {
    const dir = fresh()
    const twice = run(['--dir', dir, '--require', 'a:b', '--require', 'c:d'])
    expect(twice.status).toBe(2)
    expect(twice.stderr).toMatch(/given more than once/)
    expect(run(['--dir', dir, '--forbid', 'x', '--forbid', 'y']).status).toBe(2)
    expect(run(['--dir', dir, '--max-calls', '99999999999999999999999']).status).toBe(2)
    expect(existsSync(join(dir, 'policy.json'))).toBe(false)
  })

  it('exits 2 and enforces nothing new when a check is already set up', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'policy.json'), '{"maxCalls":1000}')
    const src = fresh()
    const trace = join(src, 't.json')
    writeFileSync(trace, JSON.stringify({ version: 1, calls: [{ name: 'delete_account', args: {} }] }))
    const r = run(['--dir', dir, '--forbid', 'delete_account', '--from', trace])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/already exists/)
    expect(r.stderr).not.toMatch(/pass\s+first run/)
  })

  it('exits 2 with no rules, a malformed pair, or a bad count, and writes nothing', () => {
    const dir = fresh()
    expect(run(['--dir', dir]).status).toBe(2)
    expect(run(['--dir', dir, '--require', 'refund_order']).status).toBe(2)
    expect(run(['--dir', dir, '--max-calls', '2.5']).status).toBe(2)
    expect(run(['--dir', dir, '--forbid', 'x', '--names-only']).status).toBe(2)
    expect(existsSync(join(dir, 'policy.json'))).toBe(false)
  })
})

describe('rateInterval', () => {
  it('gives the exact one-sided bound when nothing or everything happened', () => {
    expect(rateInterval(0, 5).low).toBe(0)
    expect(rateInterval(0, 5).high).toBeCloseTo(0.4507, 3)
    expect(rateInterval(0, 59).high).toBeCloseTo(0.0495, 3)
    expect(rateInterval(5, 5).low).toBeCloseTo(0.5493, 3)
    expect(rateInterval(5, 5).high).toBe(1)
  })

  it('gives the Wilson interval in between', () => {
    const { low, high } = rateInterval(2, 5)
    expect(low).toBeCloseTo(0.1176, 3)
    expect(high).toBeCloseTo(0.7693, 3)
  })

  it('rejects impossible counts', () => {
    expect(() => rateInterval(3, 2)).toThrow()
    expect(() => rateInterval(0, 0)).toThrow()
    expect(() => rateInterval(1.5, 3)).toThrow()
  })

  it('appears in the pull-request comment only when a policy made the count meaningful', () => {
    const calls = [{ name: 'a', args: {} }]
    const clean = classifyBehavior(Array.from({ length: 5 }, () => ({ calls })), { golden: calls, policy: { forbid: ['x'] } })
    expect(formatBehaviorMarkdown(clean)).toMatch(/No policy break in 5 finished runs\. That is consistent with a true break rate anywhere up to 45%/)
    const broken = classifyBehavior([{ calls }, { calls: [{ name: 'x', args: {} }] }, { error: 'boom' }], { golden: calls, policy: { forbid: ['x'] } })
    expect(formatBehaviorMarkdown(broken)).toMatch(/Policy broken in 1 of 2 finished runs\. The true rate is plausibly between \d+% and \d+% \(approximate 95% interval/)
    const always = classifyBehavior(Array.from({ length: 5 }, () => ({ calls: [{ name: 'x', args: {} }] })), { golden: calls, policy: { forbid: ['x'] } })
    expect(formatBehaviorMarkdown(always)).toMatch(/Policy broken in 5 of 5 finished runs\. The true break rate is plausibly at least 55% \(95% bound/)
    const one = classifyBehavior([{ calls: [{ name: 'x', args: {} }] }], { golden: calls, policy: { forbid: ['x'] } })
    expect(formatBehaviorMarkdown(one)).toMatch(/in 1 of 1 finished run\./)
    const many = classifyBehavior(Array.from({ length: 700 }, () => ({ calls })), { golden: calls, policy: { forbid: ['x'] } })
    expect(formatBehaviorMarkdown(many)).toMatch(/anywhere up to under 1%/)
    const noPolicy = classifyBehavior([{ calls }], { golden: calls })
    expect(formatBehaviorMarkdown(noPolicy)).not.toMatch(/true break rate|plausibly between/)
  })
})
