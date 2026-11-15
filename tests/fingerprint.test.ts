import { describe, it, expect } from 'vitest'
import { changedComponents, fingerprintInputs, parseFingerprint } from '../src/fingerprint.js'
import { parsePolicyFile, parseVariantFile } from '../src/behavior-io.js'

const tools = [
  { name: 'lookup_order', description: 'Look up', parameters: { type: 'object', properties: { orderId: { type: 'string' } } } },
  { name: 'refund_order', description: 'Refund', parameters: { type: 'object', properties: { orderId: { type: 'string' } } } },
]
const base = { system: 'Verify before refunding.', user: 'Refund 4471', model: 'gpt-4o-mini', tools, policy: { forbid: ['delete_account'] } }

describe('fingerprintInputs', () => {
  it('is deterministic and independent of object key order', () => {
    const a = fingerprintInputs(base)
    const b = fingerprintInputs({ policy: base.policy, tools, model: base.model, user: base.user, system: base.system })
    expect(a).toEqual(b)
    expect(a.components['system']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names exactly the component that changed', () => {
    const a = fingerprintInputs(base)
    expect(changedComponents(a, fingerprintInputs({ ...base, system: 'Refund quickly.' }))).toEqual(['system'])
    expect(changedComponents(a, fingerprintInputs({ ...base, model: 'gpt-4o' }))).toEqual(['model'])
    expect(changedComponents(a, fingerprintInputs({ ...base, policy: { forbid: [] } }))).toEqual(['policy'])
    expect(changedComponents(a, fingerprintInputs(base))).toEqual([])
  })

  it('treats a tool description edit and a tool reorder as changes', () => {
    const a = fingerprintInputs(base)
    const edited = [{ ...tools[0]!, description: 'Look up an order' }, tools[1]!]
    expect(changedComponents(a, fingerprintInputs({ ...base, tools: edited }))).toEqual(['tools'])
    expect(changedComponents(a, fingerprintInputs({ ...base, tools: [tools[1]!, tools[0]!] }))).toEqual(['tools'])
  })

  it('reports added and removed components', () => {
    const a = fingerprintInputs(base)
    const withParams = fingerprintInputs({ ...base, params: { temperature: 0 }, extra: { router: 'v2' } })
    expect(changedComponents(a, withParams)).toEqual(['extra.router', 'params'])
    expect(changedComponents(withParams, a)).toEqual(['extra.router', 'params'])
  })

  it('stores hashes only, never the prompt text', () => {
    expect(JSON.stringify(fingerprintInputs(base))).not.toContain('Verify before refunding')
  })

  it('round-trips through parseFingerprint and rejects malformed files', () => {
    const fp = fingerprintInputs(base)
    expect(parseFingerprint(JSON.parse(JSON.stringify(fp)))).toEqual(fp)
    expect(() => parseFingerprint({ version: 2, components: {}, combined: '' })).toThrow(/version/)
    expect(() => parseFingerprint({ version: 1, components: { system: 'abc' }, combined: '' })).toThrow(/sha256/)
    expect(() => parseFingerprint([])).toThrow(/object/)
  })
})

describe('parsePolicyFile', () => {
  it('accepts a valid policy', () => {
    const p = parsePolicyFile({ requires: [['refund_order', 'verify_order']], forbid: ['delete_account'], maxCalls: 8 })
    expect(p.requires).toEqual([['refund_order', 'verify_order']])
  })

  it('refuses a misspelt rule instead of enforcing nothing', () => {
    expect(() => parsePolicyFile({ forbidden: ['delete_account'] })).toThrow(/unknown rule "forbidden"/)
  })

  it('refuses malformed rules', () => {
    expect(() => parsePolicyFile({ requires: [['refund_order']] })).toThrow(/pairs/)
    expect(() => parsePolicyFile({ forbid: 'delete_account' })).toThrow(/array of tool names/)
    expect(() => parsePolicyFile({ maxCalls: -1 })).toThrow(/non-negative integer/)
    expect(() => parsePolicyFile({ sequence: [{ args: {} }] })).toThrow(/pattern/)
    expect(() => parsePolicyFile(null)).toThrow(/object/)
  })
})

describe('parseVariantFile', () => {
  it('accepts a valid file and keeps notes', () => {
    const f = parseVariantFile({ version: 1, scenario: 's', variants: [{ name: 'a', calls: [{ name: 't', args: {} }], note: 'why' }] })
    expect(f.variants[0]).toEqual({ name: 'a', calls: [{ name: 't', args: {} }], note: 'why' })
    expect(f.scenario).toBe('s')
  })

  it('refuses duplicates and malformed calls', () => {
    const call = { name: 't', args: {} }
    expect(() => parseVariantFile({ version: 1, variants: [{ name: 'a', calls: [call] }, { name: 'a', calls: [call] }] })).toThrow(/duplicate/)
    expect(() => parseVariantFile({ version: 1, variants: [{ name: 'a', calls: [{ name: 't' }] }] })).toThrow(/call 0/)
    expect(() => parseVariantFile({ version: 1, variants: [{ name: '', calls: [] }] })).toThrow(/non-empty/)
    expect(() => parseVariantFile({ version: 2, variants: [] })).toThrow(/version/)
  })
})
