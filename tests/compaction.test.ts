import { describe, expect, it } from 'vitest'

import {
  collectWithCompaction,
  compactAtTokenBudget,
  tailFromRecentAssistantTurns,
} from '../src/compaction.js'
import { analyzeStability, firstDivergence } from '../src/stability.js'
import { ablateSummary } from '../src/ablation.js'
import { assistantText, assistantWithTools, toolCall } from '../src/loop.js'
import { parseTraceFile } from '../src/schema.js'
import type { CompactedRun } from '../src/compaction.js'
import type { AssistantTurn, ChatMessage, ToolCallRecord } from '../src/types.js'

function run(calls: ToolCallRecord[], compactAt: number[] = []): CompactedRun {
  return {
    calls,
    compactions: compactAt.map((atCall, i) => ({
      atCall,
      atStep: atCall + 1,
      summary: `s${i}`,
      droppedMessages: 10,
      keptRecentTurns: 2,
      tokensBefore: 8000,
      tokensAfter: 900,
    })),
    steps: calls.length + 1,
    finalContent: 'done',
  }
}

const c = (name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ name, args })

describe('tailFromRecentAssistantTurns', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [toolCall('a', {}, 'id_a')] },
    { role: 'tool', tool_call_id: 'id_a', content: 'ra' },
    { role: 'assistant', content: null, tool_calls: [toolCall('b', {}, 'id_b')] },
    { role: 'tool', tool_call_id: 'id_b', content: 'rb' },
  ]

  it('anchors on assistant turns so no tool result is orphaned', () => {
    const tail = tailFromRecentAssistantTurns(messages, 1)
    expect(tail).toHaveLength(2)
    expect(tail[0]!.role).toBe('assistant')
    expect(tail[1]!.role).toBe('tool')
  })

  it('never starts a slice on a bare tool message', () => {
    for (let k = 1; k <= 4; k++) {
      const tail = tailFromRecentAssistantTurns(messages, k)
      if (tail.length > 0) expect(tail[0]!.role).toBe('assistant')
    }
  })

  it('returns nothing when asked to keep nothing', () => {
    expect(tailFromRecentAssistantTurns(messages, 0)).toEqual([])
  })
})

describe('collectWithCompaction', () => {
  it('records the cut and keeps executing afterwards', async () => {
    const turns: AssistantTurn[] = [
      assistantWithTools([toolCall('search', { q: 'logs' }, 't1')]),
      assistantWithTools([toolCall('read_file', { path: 'a.ts' }, 't2')]),
      assistantWithTools([toolCall('read_file', { path: 'b.ts' }, 't3')]),
      assistantWithTools([toolCall('read_file', { path: 'c.ts' }, 't4')]),
      assistantWithTools([toolCall('patch', { path: 'a.ts' }, 't5')]),
      assistantText('fixed'),
    ]
    let i = 0

    const result = await collectWithCompaction({
      system: 'you are an agent',
      user: 'fix the bug',
      llm: { complete: async () => turns[i++]! },
      executeTool: async () => 'x'.repeat(4000),
      compaction: {
        shouldCompact: compactAtTokenBudget(3000),
        summarize: async () => 'looked at logs\nread a.ts',
        keepRecentTurns: 1,
      },
    })

    expect(result.calls.map((x) => x.name)).toEqual([
      'search',
      'read_file',
      'read_file',
      'read_file',
      'patch',
    ])
    expect(result.compactions.length).toBeGreaterThan(0)
    expect(result.finalContent).toBe('fixed')

    const cut = result.compactions[0]!
    expect(cut.summary).toContain('read a.ts')
    expect(cut.tokensAfter).toBeLessThan(cut.tokensBefore)
    expect(cut.atCall).toBeGreaterThan(0)
    expect(cut.droppedMessages).toBeGreaterThan(0)
  })

  it('surfaces a cut that failed to reduce the context', async () => {
    // keepRecentTurns preserves a turn whose tool result alone exceeds the budget,
    // so the "compaction" costs a summarizer call and buys nothing. Worth catching:
    // the event records both sides, so tokensAfter >= tokensBefore is detectable.
    const turns: AssistantTurn[] = [
      assistantWithTools([toolCall('dump_logs', {}, 't1')]),
      assistantWithTools([toolCall('retry', {}, 't2')]),
      assistantText('done'),
    ]
    let i = 0

    const result = await collectWithCompaction({
      user: 'go',
      llm: { complete: async () => turns[i++]! },
      executeTool: async () => 'x'.repeat(8000),
      compaction: {
        shouldCompact: compactAtTokenBudget(500),
        summarize: async () => 'dumped the logs',
        keepRecentTurns: 4,
      },
    })

    const cut = result.compactions[0]!
    expect(cut.tokensAfter).toBeGreaterThanOrEqual(cut.tokensBefore)
  })

  it('does not compact when the budget is never reached', async () => {
    const turns: AssistantTurn[] = [
      assistantWithTools([toolCall('ping', {}, 't1')]),
      assistantText('pong'),
    ]
    let i = 0
    let summarizeCalls = 0

    const result = await collectWithCompaction({
      user: 'ping',
      llm: { complete: async () => turns[i++]! },
      executeTool: async () => 'ok',
      compaction: {
        shouldCompact: compactAtTokenBudget(1_000_000),
        summarize: async () => {
          summarizeCalls++
          return 'never'
        },
      },
    })

    expect(result.compactions).toEqual([])
    expect(summarizeCalls).toBe(0)
    expect(result.calls).toHaveLength(1)
  })
})

describe('firstDivergence', () => {
  it('finds the first differing call', () => {
    expect(firstDivergence([c('a'), c('b'), c('c')], [c('a'), c('b'), c('z')])).toBe(2)
  })

  it('reports null for identical traces', () => {
    expect(firstDivergence([c('a'), c('b')], [c('a'), c('b')])).toBeNull()
  })

  it('treats a truncated trace as diverging at the cut-off', () => {
    expect(firstDivergence([c('a'), c('b')], [c('a')])).toBe(1)
  })

  it('compares args, not just names', () => {
    expect(firstDivergence([c('refund', { amt: 10 })], [c('refund', { amt: 99 })])).toBe(0)
  })
})

describe('analyzeStability', () => {
  it('calls identical runs stable', () => {
    const runs = [run([c('a'), c('b')]), run([c('a'), c('b')]), run([c('a'), c('b')])]
    const r = analyzeStability(runs)
    expect(r.verdict).toBe('stable')
    expect(r.distinctTraces).toBe(1)
    expect(r.modalShare).toBe(1)
    expect(r.summary).toContain('identical')
  })

  it('flags a split population as bimodal', () => {
    const good = [c('lookup'), c('verify'), c('refund')]
    const bad = [c('lookup'), c('refund')]
    const runs = [run(good), run(good), run(good), run(bad), run(bad), run(bad)]
    const r = analyzeStability(runs)
    expect(r.verdict).toBe('bimodal')
    expect(r.distinctTraces).toBe(2)
    expect(r.summary).toContain('bimodal')
  })

  it('attributes divergence to a cut that precedes it closely', () => {
    const base = [c('a'), c('b'), c('c'), c('d')]
    const drift = [c('a'), c('b'), c('c'), c('zzz')]
    // cut lands at call 3, divergence at call 3 → attributable
    const runs = [run(base), run(base), run(drift, [3])]
    const r = analyzeStability(runs, { attributionWindow: 5 })
    const d = r.divergences.find((x) => x.runIndex === 2)!
    expect(d.firstDivergenceCall).toBe(3)
    expect(d.nearestPriorCompaction).toBe(3)
    expect(d.attributable).toBe(true)
    expect(r.compactionAttributableShare).toBe(1)
  })

  it('does not attribute a divergence that happened long after the cut', () => {
    const base = [c('a'), c('b'), c('c'), c('d'), c('e'), c('f'), c('g'), c('h')]
    const drift = [c('a'), c('b'), c('c'), c('d'), c('e'), c('f'), c('g'), c('X')]
    const runs = [run(base), run(base), run(drift, [0])]
    const r = analyzeStability(runs, { attributionWindow: 2 })
    const d = r.divergences.find((x) => x.runIndex === 2)!
    expect(d.callsSinceCompaction).toBe(7)
    expect(d.attributable).toBe(false)
    expect(r.compactionAttributableShare).toBe(0)
  })

  it('reports no attribution when nothing compacted', () => {
    const runs = [run([c('a')]), run([c('b')])]
    const r = analyzeStability(runs)
    expect(r.compactionAttributableShare).toBe(0)
    expect(r.summary).toContain('No compactions')
  })

  it('rejects an empty run set', () => {
    expect(() => analyzeStability([])).toThrow(/at least one run/)
  })
})

describe('ablateSummary', () => {
  const baseline = [c('lookup_order', { id: '123' }), c('refund_order', { id: '123', amount: 10 })]

  it('separates the load-bearing fact from the prose', async () => {
    const summary = [
      'user was polite',
      'order id is 123',
      'refund amount agreed at $10',
      'conversation started at 09:14',
    ].join('\n')

    const report = await ablateSummary({
      baseline,
      summary,
      // The agent can only re-issue the right calls if it still knows the order id.
      replay: async (mutated) =>
        mutated.includes('order id is 123')
          ? baseline
          : [c('ask_user', { field: 'order_id' })],
    })

    expect(report.loadBearing).toEqual(['order id is 123'])
    expect(report.droppable).toHaveLength(3)
    expect(report.compactionSchema).toBe('- order id is 123')
    expect(report.signalRatio).toBeCloseTo(0.25)
    expect(report.summary).toContain('load-bearing')
  })

  it('marks every fact load-bearing when each one moves behaviour', async () => {
    const report = await ablateSummary({
      baseline,
      summary: 'a\nb',
      replay: async () => [c('something_else')],
    })
    expect(report.loadBearing).toHaveLength(2)
    expect(report.droppable).toEqual([])
    expect(report.summary).toContain('All 2 facts are load-bearing')
  })

  it('warns when nothing in the summary mattered', async () => {
    const report = await ablateSummary({
      baseline,
      summary: 'a\nb',
      replay: async () => baseline,
    })
    expect(report.loadBearing).toEqual([])
    expect(report.compactionSchema).toBe('')
    expect(report.summary).toContain('too short to be sensitive')
  })

  it('counts diverging replays across repeats', async () => {
    let n = 0
    const report = await ablateSummary({
      baseline,
      summary: 'only fact',
      repeats: 3,
      replay: async () => (++n === 2 ? [c('drifted')] : baseline),
    })
    expect(report.facts[0]!.replays).toBe(3)
    expect(report.facts[0]!.divergedReplays).toBe(1)
    expect(report.facts[0]!.loadBearing).toBe(true)
  })

  it('refuses an empty summary', async () => {
    await expect(
      ablateSummary({ baseline, summary: '   \n  ', replay: async () => baseline }),
    ).rejects.toThrow(/no facts to ablate/)
  })
})

describe('trace schema v2', () => {
  it('reads a v1 file as v2 with no compactions', () => {
    const parsed = parseTraceFile({
      version: 1,
      scenario: 'refund',
      calls: [{ name: 'lookup_order', args: { orderId: '123' } }],
    })
    expect(parsed.version).toBe(2)
    expect(parsed.compactions).toEqual([])
    expect(parsed.calls).toHaveLength(1)
  })

  it('reads a v2 file with compaction events', () => {
    const parsed = parseTraceFile({
      version: 2,
      scenario: 'long-debug',
      calls: [{ name: 'grep', args: {} }],
      compactions: [{ atCall: 1, atStep: 12, summary: 'checked config' }],
    })
    expect(parsed.compactions[0]!.summary).toBe('checked config')
    expect(parsed.compactions[0]!.tokensBefore).toBe(0)
  })
})
