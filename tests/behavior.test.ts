import { describe, it, expect } from 'vitest'
import { classifyBehavior, classifyRun, pathId, runBehaviorCheck } from '../src/behavior.js'
import type { BehaviorBaseline } from '../src/behavior.js'
import { formatBehaviorConsole, formatBehaviorMarkdown, BEHAVIOR_COMMENT_MARKER } from '../src/behavior-report.js'
import type { ToolCallRecord } from '../src/types.js'
import { addVariant } from '../src/variants.js'

const lookup: ToolCallRecord = { name: 'lookup_order', args: { orderId: '4471' } }
const verify: ToolCallRecord = { name: 'verify_order', args: { orderId: '4471' } }
const refund: ToolCallRecord = { name: 'refund_order', args: { orderId: '4471', amount: 40 } }
const ask: ToolCallRecord = { name: 'ask_customer', args: { question: 'Which order?' } }

const golden = [lookup, verify, refund]
const policy = { requires: [['refund_order', 'verify_order']] as [string, string][], forbid: ['delete_account'] }
const baseline: BehaviorBaseline = {
  golden,
  variants: [{ name: 'verify-first', calls: [verify, lookup, refund] }],
  policy,
}

describe('classifyRun', () => {
  it('sorts a run into each bucket', () => {
    expect(classifyRun(golden, baseline).class).toBe('golden')
    const accepted = classifyRun([verify, lookup, refund], baseline)
    expect(accepted.class).toBe('accepted')
    expect(accepted.variant).toBe('verify-first')
    expect(classifyRun([lookup, verify, ask], baseline).class).toBe('unreviewed')
    expect(classifyRun([lookup, refund], baseline).class).toBe('regression')
  })

  it('reports the first divergence from golden with both sides', () => {
    const r = classifyRun([lookup, refund], baseline)
    expect(r.divergence).toEqual({ index: 1, expected: verify, actual: refund })
    expect(r.failures[0]!.kind).toBe('requires')
  })

  it('reports a divergence past the end of the shorter trace', () => {
    expect(classifyRun([lookup], baseline).divergence).toEqual({ index: 1, expected: verify, actual: null })
    expect(classifyRun([...golden, ask], baseline).divergence).toEqual({ index: 3, expected: null, actual: ask })
  })

  it('lets policy overrule a stale golden trace', () => {
    const stale: BehaviorBaseline = { golden: [lookup, refund], policy }
    const r = classifyRun([lookup, refund], stale)
    expect(r.class).toBe('regression')
  })

  it('lets policy overrule a stale approved path', () => {
    const stale: BehaviorBaseline = { golden, variants: [{ name: 'fast', calls: [lookup, refund] }], policy }
    expect(classifyRun([lookup, refund], stale).class).toBe('regression')
  })

  it('never calls an unknown path a regression without a policy, and says nothing was checked', () => {
    const r = classifyRun([lookup, refund], { golden })
    expect(r.class).toBe('unreviewed')
    expect(r.reason).toMatch(/no policy rules/)
  })

  it('treats different arguments as a different path', () => {
    const other = [lookup, verify, { name: 'refund_order', args: { orderId: '4471', amount: 400 } }]
    const r = classifyRun(other, baseline)
    expect(r.class).toBe('unreviewed')
    expect(r.divergence!.index).toBe(2)
  })

  it('honours subsequence mode for golden and approved paths', () => {
    const r = classifyRun([lookup, ask, verify, refund], { ...baseline, mode: 'subsequence' })
    expect(r.class).toBe('golden')
  })
})

describe('classifyBehavior', () => {
  it('is unchanged when every run is golden or approved', () => {
    const r = classifyBehavior([{ calls: golden }, { calls: [verify, lookup, refund] }], baseline)
    expect(r.verdict).toBe('unchanged')
    expect(r.counts).toEqual({ golden: 1, accepted: 1, unreviewed: 0, regression: 0, error: 0 })
    expect(r.newPaths).toEqual([])
  })

  it('asks for review on an unseen path and groups identical runs', () => {
    const fresh = [lookup, verify, ask]
    const r = classifyBehavior([{ calls: golden }, { calls: fresh }, { calls: fresh }], baseline)
    expect(r.verdict).toBe('review')
    expect(r.newPaths).toHaveLength(1)
    expect(r.newPaths[0]!.count).toBe(2)
    expect(r.newPaths[0]!.runIndexes).toEqual([1, 2])
    expect(r.newPaths[0]!.id).toBe(pathId(fresh))
    expect(r.distinctTraces).toBe(2)
  })

  it('is a regression if any single run breaks policy', () => {
    const r = classifyBehavior([{ calls: golden }, { calls: golden }, { calls: [lookup, refund] }], baseline)
    expect(r.verdict).toBe('regression')
    expect(r.regressions[0]!.failures[0]!.message).toMatch(/requires a prior "verify_order"/)
  })

  it('is inconclusive, not unchanged, when a run did not finish', () => {
    const r = classifyBehavior([{ calls: golden }, { error: 'API error 503' }], baseline)
    expect(r.verdict).toBe('inconclusive')
    expect(r.counts.error).toBe(1)
  })

  it('still reports a regression when other runs errored', () => {
    const r = classifyBehavior([{ error: 'timeout' }, { calls: [lookup, refund] }], baseline)
    expect(r.verdict).toBe('regression')
  })

  it('flags a baseline that breaks the policy it is enforced with', () => {
    const r = classifyBehavior([{ calls: golden }], {
      golden: [lookup, refund],
      variants: [{ name: 'ok', calls: golden }],
      policy,
    })
    expect(r.baselineIssues).toHaveLength(1)
    expect(r.baselineIssues[0]).toMatch(/golden trace breaks current policy/)
  })

  it('says so when no policy was supplied', () => {
    const r = classifyBehavior([{ calls: [lookup, refund] }], { golden })
    expect(r.hasPolicy).toBe(false)
    expect(r.verdict).toBe('review')
    expect(r.summary).toMatch(/No policy rules were supplied/)
  })

  it('refuses an empty batch', () => {
    expect(() => classifyBehavior([], baseline)).toThrow(/at least one run/)
  })

  it('gives the same path the same id regardless of argument key order', () => {
    const a = [{ name: 'refund_order', args: { orderId: '1', amount: 2 } }]
    const b = [{ name: 'refund_order', args: { amount: 2, orderId: '1' } }]
    expect(pathId(a)).toBe(pathId(b))
    expect(pathId(a)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('addVariant', () => {
  it('adds the first approved path to an empty set', () => {
    const r = addVariant([], [verify, lookup, refund], 'verify-first')
    expect(r.added).toBe(true)
    expect(r.variants).toHaveLength(1)
    expect(addVariant(r.variants, [verify, lookup, refund], 'again').added).toBe(false)
  })
})

describe('runBehaviorCheck', () => {
  it('runs sequentially, records thrown runs as errors and reports each run', async () => {
    const order: number[] = []
    const seen: string[] = []
    const report = await runBehaviorCheck({
      runs: 3,
      baseline,
      collect: async (i) => {
        order.push(i)
        if (i === 1) throw new Error('boom')
        return golden
      },
      onRun: (r) => seen.push(r.class),
    })
    expect(order).toEqual([0, 1, 2])
    expect(seen).toEqual(['golden', 'error', 'golden'])
    expect(report.verdict).toBe('inconclusive')
    expect(report.classifications[1]!.error).toBe('boom')
  })

  it('rejects a non-positive run count', async () => {
    await expect(runBehaviorCheck({ runs: 0, baseline, collect: async () => golden })).rejects.toThrow(/positive integer/)
  })
})

describe('behaviour reports', () => {
  const report = classifyBehavior(
    [{ calls: golden }, { calls: [lookup, verify, ask] }, { calls: [lookup, refund] }, { error: 'API error 503' }],
    baseline,
  )

  it('renders a pull-request comment with divergence, violated policy and an accept command', () => {
    const md = formatBehaviorMarkdown(report, {
      scenario: 'refund',
      changed: ['system', 'tools'],
      acceptCommand: (p) => `npx agent-vcr accept --trace out/${p.id}.json --name <name>`,
    })
    expect(md.startsWith(BEHAVIOR_COMMENT_MARKER)).toBe(true)
    expect(md).toMatch(/Agent behaviour regressed/)
    expect(md).toMatch(/triggered by a change to `system`, `tools`/)
    expect(md).toMatch(/Violated: `"refund_order" at index 1 requires a prior "verify_order"/)
    expect(md).toMatch(/First divergence from golden at call 1/)
    expect(md).toMatch(/expected: `verify_order\(/)
    expect(md).toMatch(new RegExp(`accept --trace out/${pathId([lookup, verify, ask])}.json`))
    expect(md).toMatch(/Did not finish \| 1/)
    expect(md).toMatch(/API error 503/)
  })

  it('keeps model-controlled text inside code so it cannot inject markdown', () => {
    const hostile: ToolCallRecord = {
      name: 'ask_customer',
      args: { question: '``` \n@everyone <img src=x> | [click](http://evil.example)' },
    }
    const r = classifyBehavior([{ calls: [hostile] }, { error: '`oops` @team' }], { golden })
    const md = formatBehaviorMarkdown(r)
    // Every line that carries the hostile text is a code span or sits inside a fence, with no stray backticks.
    for (const line of md.split('\n').filter((l) => l.includes('@everyone') || l.includes('@team'))) {
      const fencedOrSpan = /^\d+\. /.test(line) || /`[^`]*@(everyone|team)[^`]*`/.test(line)
      expect(fencedOrSpan).toBe(true)
    }
    const fences = md.split('\n').filter((l) => l.trim() === '```').length
    expect(fences % 2).toBe(0)
  })

  it('omits the accept command when none is supplied and warns when there is no policy', () => {
    const r = classifyBehavior([{ calls: [lookup] }], { golden })
    const md = formatBehaviorMarkdown(r)
    expect(md).not.toMatch(/To approve this path/)
    expect(md).toMatch(/not checked against anything/)
  })

  it('renders a console summary', () => {
    const text = formatBehaviorConsole(report)
    expect(text).toMatch(/run 0: golden/)
    expect(text).toMatch(/violated:/)
    expect(text).toMatch(/new path/)
  })
})
