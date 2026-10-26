import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import assertion, { evidenceFromCompactedRun, type EvidenceEnvelope } from '../src/promptfoo.js'
import { collectWithCompaction } from '../src/compaction.js'

describe('Promptfoo evidence assertion', () => {
  const calls = JSON.parse(readFileSync(new URL(
    '../examples/rag-validation/traces/rag-with-citation.expected.json', import.meta.url), 'utf8')).calls
  function evidence(): EvidenceEnvelope {
    return { version: 1, complete: true, calls: structuredClone(calls),
      sources: [{ id: 'retrieved', kind: 'state', value: { ids: ['doc_1', 'doc_2'] }, availableBefore: 2 }],
      citations: [{ call: 2, argument: 'sourceIds', source: 'retrieved', path: 'ids' }],
      transformations: [] }
  }
  const config = { grounding: [{ tool: 'cite_sources', arguments: ['sourceIds'] }] }
  it('checks the existing rag-validation trace, including changed and future citations', () => {
    const data = evidence()
    const context = { config, providerResponse: { metadata: { vcrEvidence: data } } }
    expect(assertion('', context).pass).toBe(true)
    data.calls[2]!.args.sourceIds = ['invented']
    expect(assertion('', context).metadata.status).toBe('fail')
    data.calls = calls
    data.sources[0]!.availableBefore = 3
    expect(assertion('', context).pass).toBe(false)
  })
  it('never passes absent, truncated, malformed or unexercised evidence', () => {
    expect(assertion('', { config }).metadata.status).toBe('unsupported')
    for (const data of [{ ...evidence(), complete: false }, { ...evidence(), version: 9 }]) {
      expect(assertion('', { config, providerResponse: { metadata: { vcrEvidence: data } } }).pass).toBe(false)
    }
    expect(assertion('', { config: {}, providerResponse: { metadata: { vcrEvidence: evidence() } } }).pass).toBe(false)
    const data = { ...evidence(), calls: [] }
    expect(assertion('', { config, providerResponse: { metadata: { vcrEvidence: data } } }).metadata.status).toBe('fail')
  })
  it('captures actual before/after context including retained messages', async () => {
    let step = 0
    const run = await collectWithCompaction({
      system: 'Keep reference R-42.', user: 'Process this item.', captureEvidence: true,
      llm: { complete: async () => ++step === 1
        ? { content: null, tool_calls: [{ id: 'x', type: 'function',
          function: { name: 'lookup', arguments: '{}' } }] }
        : { content: 'done' } },
      executeTool: async () => 'lookup complete',
      compaction: { shouldCompact: ctx => ctx.step === 2,
        summarize: async () => 'short summary', keepRecentTurns: 0 },
    })
    const data = evidenceFromCompactedRun(run)
    const survival = { survival: [{ id: 'reference', fact: 'R-42' }] }
    const context = { config: survival, providerResponse: { metadata: { vcrEvidence: data } } }
    expect(assertion('', context).pass).toBe(true)
    data.transformations[0]!.after = 'reference lost'
    expect(assertion('', context).pass).toBe(false)
    delete run.compactions[0]!.effectiveBefore
    expect(() => evidenceFromCompactedRun(run)).toThrow()
  })
})
