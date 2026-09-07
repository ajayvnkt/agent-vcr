import { describe, expect, it } from 'vitest'

import { runScenario, runScenarioRepeated } from '../src/scenario.js'
import { runSuite } from '../src/suite.js'
import { formatConsole, formatJson, formatMarkdown } from '../src/report.js'
import { assertOutput, keywordJudge, llmJudge } from '../src/judge.js'
import { contractFromAblation, verifyRunContract, verifySummary } from '../src/contract.js'
import type { Scenario, ScenarioAgent, TurnResult } from '../src/scenario.js'
import type { SummaryContract } from '../src/contract.js'
import type { ToolCallRecord } from '../src/types.js'

const c = (name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ name, args })

/** An agent that replays a fixed list of turn results. */
function scriptedAgent(script: TurnResult[]): () => ScenarioAgent {
  return () => {
    let i = 0
    return { send: async () => script[i++] ?? { calls: [], finalContent: null } }
  }
}

const goodTurn: TurnResult = {
  calls: [c('lookup_order', { orderId: '123' }), c('refund_order', { orderId: '123' })],
  finalContent: 'Refunded order 123.',
}

const badTurn: TurnResult = {
  calls: [c('refund_order', { orderId: '123' })],
  finalContent: 'Refunded order 123.',
}

describe('assertOutput', () => {
  it('passes matching text', () => {
    expect(assertOutput('Refunded order 123.', { contains: ['refunded'] })).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(assertOutput('REFUNDED', { contains: ['refunded'] })).toEqual([])
  })

  it('catches forbidden phrases', () => {
    expect(assertOutput('I am an AI language model', { notContains: ['language model'] })).toHaveLength(1)
  })

  it('reports a missing final message when one was required', () => {
    expect(assertOutput(null, { required: true })[0]).toMatch(/got none/)
    expect(assertOutput(null, {})).toEqual([])
  })

  it('throws on an invalid regex', () => {
    expect(() => assertOutput('x', { matches: '([' })).toThrow(/invalid regex/)
  })
})

describe('runScenario', () => {
  const scenario: Scenario = {
    name: 'refund',
    turns: [
      {
        user: 'Refund order 123',
        expect: { sequence: ['lookup_order', 'refund_order'], forbid: ['delete_account'] },
        output: { contains: ['refunded'] },
      },
    ],
  }

  it('passes a clean run without touching the judge', async () => {
    const r = await runScenario(scenario, { agent: scriptedAgent([goodTurn]) })
    expect(r.ok).toBe(true)
    expect(r.judgeCalls).toBe(0)
    expect(r.allCalls).toHaveLength(2)
  })

  it('fails when a required call is missing', async () => {
    const r = await runScenario(scenario, { agent: scriptedAgent([badTurn]) })
    expect(r.ok).toBe(false)
    expect(r.reachedTier).toBe('structural')
    expect(r.turns[0]!.traceFailures[0]!.kind).toBe('sequence')
  })

  it('does not pay for the judge when a free tier already failed', async () => {
    let judged = 0
    const withRubric: Scenario = {
      ...scenario,
      turns: [{ ...scenario.turns[0]!, rubric: 'expect: refunded' }],
    }
    const r = await runScenario(withRubric, {
      agent: scriptedAgent([badTurn]),
      judge: {
        name: 'counting',
        evaluate: async () => {
          judged++
          return { score: 1, pass: true, reason: 'ok' }
        },
      },
    })
    expect(r.ok).toBe(false)
    expect(judged).toBe(0)
    expect(r.judgeCalls).toBe(0)
  })

  it('runs the judge when everything free passed', async () => {
    const withRubric: Scenario = {
      ...scenario,
      turns: [{ ...scenario.turns[0]!, rubric: 'expect: refunded' }],
    }
    const r = await runScenario(withRubric, {
      agent: scriptedAgent([goodTurn]),
      judge: keywordJudge(),
    })
    expect(r.judgeCalls).toBe(1)
    expect(r.reachedTier).toBe('judge')
    expect(r.ok).toBe(true)
  })

  it('honours alwaysJudge for a nightly deep run', async () => {
    const withRubric: Scenario = {
      ...scenario,
      turns: [{ ...scenario.turns[0]!, rubric: 'expect: refunded' }],
    }
    const r = await runScenario(withRubric, {
      agent: scriptedAgent([badTurn]),
      judge: keywordJudge(),
      alwaysJudge: true,
    })
    expect(r.judgeCalls).toBe(1)
    expect(r.ok).toBe(false)
  })

  it('runs every turn of a conversation and aggregates calls', async () => {
    const multi: Scenario = {
      name: 'clarify-then-act',
      turns: [
        { user: 'I want a refund', expect: { forbid: ['refund_order'] } },
        { user: 'Order 123', expect: { includes: ['refund_order'] } },
      ],
    }
    const r = await runScenario(multi, {
      agent: scriptedAgent([
        { calls: [c('ask_clarify')], finalContent: 'Which order?' },
        goodTurn,
      ]),
    })
    expect(r.ok).toBe(true)
    expect(r.turns).toHaveLength(2)
    expect(r.allCalls).toHaveLength(3)
  })

  it('applies whole-conversation assertions across turns', async () => {
    const multi: Scenario = {
      name: 'ordering-across-turns',
      turns: [{ user: 'a' }, { user: 'b' }],
      expectOverall: { ordering: [['lookup_order', 'refund_order']] },
    }
    const r = await runScenario(multi, {
      agent: scriptedAgent([
        { calls: [c('refund_order')], finalContent: null },
        { calls: [c('lookup_order')], finalContent: null },
      ]),
    })
    expect(r.ok).toBe(false)
    expect(r.overallFailures[0]!.kind).toBe('ordering')
  })

  it('rejects an empty scenario', async () => {
    await expect(
      runScenario({ name: 'empty', turns: [] }, { agent: scriptedAgent([]) }),
    ).rejects.toThrow(/no turns/)
  })

  it('checks accepted paths only after assertions pass', async () => {
    const withVariants: Scenario = {
      name: 'paths',
      turns: [{ user: 'go' }],
      variants: [{ name: 'only', calls: [c('x')] }],
    }
    const r = await runScenario(withVariants, {
      agent: scriptedAgent([{ calls: [c('y')], finalContent: null }]),
    })
    expect(r.ok).toBe(false)
    expect(r.reachedTier).toBe('variants')
    expect(r.variantMatch?.matched).toBe(false)
  })
})

describe('runScenarioRepeated', () => {
  it('separates correctness from consistency', async () => {
    let call = 0
    const flaky: Scenario = { name: 'flaky', turns: [{ user: 'go' }] }
    const r = await runScenarioRepeated(flaky, {
      runs: 4,
      agent: () => ({
        send: async () => ({
          calls: call++ % 2 === 0 ? [c('a')] : [c('b')],
          finalContent: 'done',
        }),
      }),
    })
    // Every run passes — there are no assertions — but behaviour differs.
    expect(r.passed).toBe(4)
    expect(r.passRate).toBe(1)
    expect(r.stability.verdict).not.toBe('stable')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/distinct traces/)
  })

  it('reports ok when runs both pass and agree', async () => {
    const r = await runScenarioRepeated(
      { name: 'steady', turns: [{ user: 'go' }] },
      { runs: 3, agent: scriptedAgent([{ calls: [c('a')], finalContent: 'x' }]) },
    )
    expect(r.ok).toBe(true)
    expect(r.stability.verdict).toBe('stable')
  })
})

describe('summary contracts', () => {
  const contract: SummaryContract = {
    version: 1,
    scenario: 'refund',
    facts: [
      { id: 'order-id', must: '4471' },
      { id: 'amount', must: '\\$\\d+', regex: true },
    ],
  }

  it('passes a summary carrying every clause', () => {
    const r = verifySummary('order 4471, refund of $40 agreed', contract)
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(2)
  })

  it('names exactly which clause is missing', () => {
    const r = verifySummary('refund of $40 agreed', contract)
    expect(r.ok).toBe(false)
    expect(r.violations[0]!.factId).toBe('order-id')
    expect(r.message).toMatch(/order-id/)
  })

  it('enforces a token ceiling', () => {
    const r = verifySummary('4471 $40 ' + 'x'.repeat(400), {
      ...contract,
      maxSummaryTokens: 10,
    })
    expect(r.violations.some((v) => v.kind === 'tooLong')).toBe(true)
  })

  it('throws on an invalid regex clause', () => {
    expect(() =>
      verifySummary('x', { version: 1, scenario: 's', facts: [{ id: 'bad', must: '([', regex: true }] }),
    ).toThrow(/invalid regex/)
  })

  it('derives a contract from an ablation report', () => {
    const derived = contractFromAblation('refund', {
      facts: [],
      loadBearing: ['the order in question is 4471'],
      droppable: ['customer was polite'],
      compactionSchema: '- the order in question is 4471',
      signalRatio: 0.5,
      summary: '',
    })
    expect(derived.facts).toHaveLength(1)
    expect(derived.facts[0]!.id).toBe('the-order-in-question-is-4471')
    expect(derived.derivedFrom).toBe('ablation')
  })

  it('checks every compaction in a run, not just the first', () => {
    const r = verifyRunContract(
      [
        { atCall: 3, atStep: 4, summary: 'order 4471 $40', droppedMessages: 0, keptRecentTurns: 1, tokensBefore: 0, tokensAfter: 0 },
        { atCall: 9, atStep: 11, summary: 'customer was polite', droppedMessages: 0, keptRecentTurns: 1, tokensBefore: 0, tokensAfter: 0 },
      ],
      contract,
    )
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/1 of 2 compactions/)
    expect(r.message).toMatch(/call 9/)
  })

  it('says so when no compaction happened', () => {
    expect(verifyRunContract([], contract).message).toMatch(/not exercised/)
  })
})

describe('judges', () => {
  it('keywordJudge grades expect: clauses without a model', async () => {
    const j = keywordJudge()
    const pass = await j.evaluate({ user: 'u', output: 'we refunded it', calls: [], rubric: 'expect: refunded' })
    expect(pass.pass).toBe(true)
    const fail = await j.evaluate({ user: 'u', output: 'no', calls: [], rubric: 'expect: refunded' })
    expect(fail.pass).toBe(false)
    expect(fail.reason).toMatch(/missing/)
  })

  it('keywordJudge passes a rubric with nothing to check', async () => {
    const r = await keywordJudge().evaluate({ user: 'u', output: 'x', calls: [], rubric: 'be nice' })
    expect(r.pass).toBe(true)
  })

  it('llmJudge parses a fenced JSON verdict', async () => {
    const j = llmJudge(async () => '```json\n{"score": 0.9, "reason": "good"}\n```')
    const r = await j.evaluate({ user: 'u', output: 'x', calls: [], rubric: 'r' })
    expect(r.score).toBe(0.9)
    expect(r.pass).toBe(true)
  })

  it('llmJudge clamps out-of-range scores', async () => {
    const j = llmJudge(async () => '{"score": 5, "reason": "enthusiastic"}')
    expect((await j.evaluate({ user: 'u', output: 'x', calls: [], rubric: 'r' })).score).toBe(1)
  })

  it('llmJudge fails closed on unparseable output instead of throwing', async () => {
    const j = llmJudge(async () => 'I think it was pretty good actually')
    const r = await j.evaluate({ user: 'u', output: 'x', calls: [], rubric: 'r' })
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
    expect(r.reason).toMatch(/unparseable/)
  })
})

describe('runSuite and reporters', () => {
  const passing: Scenario = {
    name: 'refund-happy',
    turns: [{ user: 'refund 123', expect: { includes: ['refund_order'] } }],
  }
  const failing: Scenario = {
    name: 'refund-guarded',
    turns: [{ user: 'refund 123', expect: { ordering: [['lookup_order', 'refund_order']] } }],
  }

  async function suite(gate?: Parameters<typeof runSuite>[1]['gate']) {
    return runSuite([passing, failing], {
      runs: 2,
      gate,
      agent: () => ({
        send: async () => ({ calls: [c('refund_order'), c('lookup_order')], finalContent: 'ok' }),
      }),
    })
  }

  it('gates the suite on the failing scenario', async () => {
    const r = await suite()
    expect(r.ok).toBe(false)
    expect(r.totals.scenarios).toBe(2)
    expect(r.totals.passedScenarios).toBe(1)
  })

  it('can require stability as well as passing', async () => {
    let n = 0
    const r = await runSuite([{ name: 'wobbly', turns: [{ user: 'go' }] }], {
      runs: 4,
      gate: { requireStable: true },
      agent: () => ({
        send: async () => ({ calls: n++ % 2 ? [c('a')] : [c('b')], finalContent: 'x' }),
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.scenarios[0]!.gateReasons[0]).toMatch(/bimodal|drifting/)
  })

  it('reports progress through onScenario', async () => {
    const seen: string[] = []
    await runSuite([passing], {
      runs: 1,
      agent: scriptedAgent([{ calls: [c('refund_order')], finalContent: 'ok' }]),
      onScenario: (o) => seen.push(o.scenario),
    })
    expect(seen).toEqual(['refund-happy'])
  })

  it('formats a console report', async () => {
    const out = formatConsole(await suite())
    expect(out).toContain('agent-vcr reliability suite')
    expect(out).toContain('refund-guarded')
    expect(out).toContain('must precede')
  })

  it('formats a PR comment with collapsible detail', async () => {
    const md = formatMarkdown(await suite(), { commit: 'abcdef1234' })
    expect(md).toContain('| | Scenario | Runs | Behaviour | Notes |')
    expect(md).toContain('<details><summary>What broke</summary>')
    expect(md).toContain('abcdef1')
    expect(md).toMatch(/^### ❌/)
  })

  it('formats machine-readable JSON', async () => {
    const parsed = JSON.parse(formatJson(await suite()))
    expect(parsed.ok).toBe(false)
    expect(parsed.scenarios).toHaveLength(2)
    expect(parsed.scenarios[1].failures.length).toBeGreaterThan(0)
    expect(parsed.totals.judgeCalls).toBe(0)
  })
})
