import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')

type Call = { name: string; args: Record<string, unknown> }
const lookup: Call = { name: 'lookup_order', args: { orderId: '4471' } }
const verify: Call = { name: 'verify_order', args: { orderId: '4471' } }
const refund: Call = { name: 'refund_order', args: { orderId: '4471', amount: 40 } }

/**
 * A stand-in OpenAI-compatible endpoint. Each conversation follows the script
 * named by the model: one tool call per turn, then a final text turn.
 */
const scripts: Record<string, Call[] | 'fail'> = {
  'm-golden': [lookup, verify, refund],
  'm-newpath': [verify, lookup, refund],
  'm-regress': [lookup, refund],
  'm-down': 'fail',
  'm-loop': [lookup, lookup, lookup, lookup, lookup, lookup, lookup, lookup],
}
let server: Server
let baseURL = ''
let hits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      hits++
      const parsed = JSON.parse(body) as { model: string; messages: { role: string }[] }
      const script = scripts[parsed.model]
      if (script === undefined || script === 'fail') {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('model unavailable')
        return
      }
      const step = parsed.messages.filter((m) => m.role === 'tool').length
      const next = script[step]
      const message = next
        ? { content: null, tool_calls: [{ id: `c${step}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }
        : { content: 'Done.' }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function run(args: string[]): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, OPENAI_API_KEY: 'test', NO_COLOR: '1' } })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.stdout.on('data', (d) => (stdout += d))
    child.on('close', (status) => resolve({ status, stderr, stdout }))
  })
}

function workspace(): { dir: string; config: string; golden: string; policy: string; variants: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vcr-behavior-'))
  const tool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const config = join(dir, 'record.config.json')
  writeFileSync(config, JSON.stringify({
    system: 'Verify before refunding.',
    user: 'Refund order 4471',
    scenario: 'refund',
    model: 'm-golden',
    tools: [tool('lookup_order'), tool('verify_order'), tool('refund_order')],
  }))
  const golden = join(dir, 'golden.json')
  writeFileSync(golden, JSON.stringify({ version: 1, scenario: 'refund', calls: [lookup, verify, refund] }))
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ requires: [['refund_order', 'verify_order']] }))
  return { dir, config, golden, policy, variants: join(dir, 'variants.json') }
}

describe('cli behavior', () => {
  it('exits 0 and reports unchanged when live runs match golden', async () => {
    const w = workspace()
    const r = await run(['behavior', '--config', w.config, '--golden', w.golden, '--policy', w.policy, '--runs', '2', '--base-url', baseURL])
    expect(r.stderr).toMatch(/Agent behaviour unchanged/)
    expect(r.status).toBe(0)
  })

  it('exits 1 on a policy regression and writes a PR comment, JSON and the offending trace', async () => {
    const w = workspace()
    const md = join(w.dir, 'comment.md')
    const json = join(w.dir, 'report.json')
    const out = join(w.dir, 'out')
    const r = await run(['behavior', '--config', w.config, '--golden', w.golden, '--policy', w.policy, '--runs', '2',
      '--model', 'm-regress', '--base-url', baseURL, '--markdown', md, '--json', json, '--out-dir', out])
    expect(r.status).toBe(1)
    const comment = readFileSync(md, 'utf8')
    expect(comment).toMatch(/Agent behaviour regressed/)
    expect(comment).toMatch(/requires a prior "verify_order"/)
    expect(JSON.parse(readFileSync(json, 'utf8')).verdict).toBe('regression')
    expect(readdirSync(out)).toHaveLength(1)
  })

  it('exits 0 for a new path by default, 1 under --strict, and the path can then be accepted', async () => {
    const w = workspace()
    const out = join(w.dir, 'out')
    const md = join(w.dir, 'comment.md')
    const common = ['behavior', '--config', w.config, '--golden', w.golden, '--policy', w.policy, '--variants', w.variants,
      '--runs', '2', '--model', 'm-newpath', '--base-url', baseURL, '--out-dir', out, '--markdown', md]
    const lenient = await run(common)
    expect(lenient.status).toBe(0)
    expect(lenient.stderr).toMatch(/review needed/)
    expect((await run([...common, '--strict'])).status).toBe(1)

    const trace = join(out, readdirSync(out)[0]!)
    expect(readFileSync(md, 'utf8')).toContain(`accept --variants ${w.variants} --trace ${trace}`)

    const accepted = await run(['accept', '--variants', w.variants, '--trace', trace, '--name', 'verify-first', '--policy', w.policy])
    expect(accepted.status).toBe(0)
    expect(JSON.parse(readFileSync(w.variants, 'utf8')).variants[0].name).toBe('verify-first')

    const after = await run([...common, '--strict'])
    expect(after.stderr).toMatch(/Agent behaviour unchanged/)
    expect(after.status).toBe(0)
    expect((await run(['accept', '--variants', w.variants, '--trace', trace, '--name', 'again'])).stderr).toMatch(/already covered/)
  })

  it('refuses to accept a path that breaks policy', async () => {
    const w = workspace()
    const bad = join(w.dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ version: 1, calls: [lookup, refund] }))
    const r = await run(['accept', '--variants', w.variants, '--trace', bad, '--name', 'fast', '--policy', w.policy])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/breaks policy/)
    expect(existsSync(w.variants)).toBe(false)
  })

  it('exits 1, never 0, when the model endpoint fails', async () => {
    const w = workspace()
    const r = await run(['behavior', '--config', w.config, '--golden', w.golden, '--runs', '2', '--model', 'm-down', '--base-url', baseURL])
    expect(r.stderr).toMatch(/inconclusive/)
    expect(r.status).toBe(1)
  })

  it('skips live runs when the fingerprint is unchanged and runs when it changes', async () => {
    const w = workspace()
    const fp = join(w.dir, 'behavior.fingerprint.json')
    // Point the config at an endpoint whose only model fails every request, so
    // exit 0 below can only mean that no live run was made.
    const original = JSON.parse(readFileSync(w.config, 'utf8'))
    writeFileSync(w.config, JSON.stringify({ ...original, model: 'm-down', baseURL }))
    const judged = ['--policy', w.policy, '--golden', w.golden]
    expect((await run(['fingerprint', '--config', w.config, ...judged, '--out', fp])).status).toBe(0)
    expect((await run(['fingerprint', '--config', w.config, ...judged, '--check', fp])).status).toBe(0)

    const base = ['behavior', '--config', w.config, '--golden', w.golden, '--policy', w.policy, '--runs', '1', '--fingerprint', fp, '--if-changed']
    const before = hits
    const skipped = await run(base)
    expect(skipped.stderr).toMatch(/skipped/)
    expect(skipped.status).toBe(0)
    expect(hits).toBe(before)
    // The same command without --if-changed does call the model, and fails.
    expect((await run(base.filter((a) => a !== '--if-changed'))).status).toBe(1)
    expect(hits).toBeGreaterThan(before)

    const config = JSON.parse(readFileSync(w.config, 'utf8'))
    writeFileSync(w.config, JSON.stringify({ ...config, system: 'Refund fast.' }))
    const check = await run(['fingerprint', '--config', w.config, ...judged, '--check', fp])
    expect(check.status).toBe(1)
    expect(check.stderr).toMatch(/changed: system/)

    const md = join(w.dir, 'comment.md')
    const ran = await run([...base, '--model', 'm-golden', '--markdown', md])
    expect(ran.stderr).toMatch(/1 live run/)
    expect(readFileSync(md, 'utf8')).toMatch(/triggered by a change to `model`, `system`/)
  })

  it('does not skip when the endpoint, golden trace, approved paths or mode changed', async () => {
    const w = workspace()
    const fp = join(w.dir, 'fp.json')
    const original = JSON.parse(readFileSync(w.config, 'utf8'))
    writeFileSync(w.config, JSON.stringify({ ...original, baseURL }))
    const judged = ['--policy', w.policy, '--golden', w.golden, '--variants', w.variants]
    await run(['fingerprint', '--config', w.config, ...judged, '--out', fp])
    const check = (extra: string[], args = judged) => run(['fingerprint', '--config', w.config, ...args, ...extra, '--check', fp])
    expect((await check([])).status).toBe(0)

    const moved = await check(['--base-url', 'http://127.0.0.1:1/v1'])
    expect(moved.status).toBe(1)
    expect(moved.stderr).toMatch(/changed: params/)

    expect((await check(['--mode', 'subsequence'])).stderr).toMatch(/changed: extra.mode/)

    const otherGolden = join(w.dir, 'other.json')
    writeFileSync(otherGolden, JSON.stringify({ version: 1, calls: [lookup] }))
    expect((await check([], ['--policy', w.policy, '--golden', otherGolden, '--variants', w.variants])).stderr).toMatch(/changed: extra.golden/)

    writeFileSync(w.variants, JSON.stringify({ version: 1, variants: [{ name: 'v', calls: [verify, lookup, refund] }] }))
    expect((await check([])).stderr).toMatch(/changed: extra.variants/)

    // A fingerprint written without the golden trace never matches a behaviour run, so the run is made.
    const thin = join(w.dir, 'thin.json')
    await run(['fingerprint', '--config', w.config, '--policy', w.policy, '--out', thin])
    const ran = await run(['behavior', '--config', w.config, '--golden', w.golden, '--policy', w.policy, '--runs', '1', '--fingerprint', thin, '--if-changed'])
    expect(ran.stderr).toMatch(/1 live run/)
  })

  it('treats a run cut off at maxSteps as unfinished, not as a match', async () => {
    const w = workspace()
    const original = JSON.parse(readFileSync(w.config, 'utf8'))
    writeFileSync(w.config, JSON.stringify({ ...original, model: 'm-loop', maxSteps: 3 }))
    const golden = join(w.dir, 'loop.json')
    writeFileSync(golden, JSON.stringify({ version: 1, calls: [lookup, lookup, lookup] }))
    const r = await run(['behavior', '--config', w.config, '--golden', golden, '--runs', '1', '--base-url', baseURL])
    expect(r.stderr).toMatch(/stopped at maxSteps \(3\)/)
    expect(r.stderr).toMatch(/inconclusive/)
    expect(r.status).toBe(1)
  })

  it('refuses an empty golden trace in subsequence mode and notes a missing approved-paths file', async () => {
    const w = workspace()
    const empty = join(w.dir, 'empty.json')
    writeFileSync(empty, JSON.stringify({ version: 1, calls: [] }))
    const r = await run(['behavior', '--config', w.config, '--golden', empty, '--mode', 'subsequence', '--runs', '1', '--base-url', baseURL])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/empty golden trace/)
    const noted = await run(['behavior', '--config', w.config, '--golden', w.golden, '--variants', w.variants, '--runs', '1', '--base-url', baseURL])
    expect(noted.stderr).toMatch(/does not exist yet/)
    expect((await run(['behavior', '--config', w.config, '--golden', w.golden, '--runs', '0x2'])).status).toBe(2)
  })

  it('reports usage errors with exit 2', async () => {
    const w = workspace()
    expect((await run(['behavior', '--config', w.config])).status).toBe(2)
    expect((await run(['behavior', '--config', w.config, '--golden', w.golden, '--runs', '0'])).status).toBe(2)
    expect((await run(['behavior', '--config', w.config, '--golden', w.golden, '--bogus', 'x'])).status).toBe(2)
    expect((await run(['behavior', '--config', w.config, '--golden', w.golden, '--if-changed'])).status).toBe(2)
    const typo = join(w.dir, 'typo.json')
    writeFileSync(typo, JSON.stringify({ forbidden: ['x'] }))
    const r = await run(['behavior', '--config', w.config, '--golden', w.golden, '--policy', typo])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown rule "forbidden"/)
  })
})
