/**
 * @fileoverview Fingerprint the inputs that decide an agent's behaviour.
 *
 * Live runs cost money and minutes, so they should not run on every pull
 * request. They should run when something that can change the model's decisions
 * has changed: the system prompt, the model, a tool schema, the policy, or a
 * sampling parameter. A fingerprint is a hash of each of those, committed next
 * to the golden trace. CI recomputes it, and a difference is the trigger.
 *
 * Each component is hashed separately so the report can say *what* changed
 * ("tools"), not just that something did. Only hashes are stored: a prompt can
 * be confidential, and the fingerprint file is meant to be committed.
 *
 * The order of the tool list is part of the fingerprint: reordering it is a real
 * change to what the model reads. Key order inside an object is not; values are
 * hashed in a canonical key order, so reformatting a schema does not trigger a run.
 *
 * A fingerprint covers exactly the inputs it is given. Anything left out is
 * invisible to it, so pass everything that decides the run or how it is judged.
 */

import { createHash } from 'node:crypto'
import { stableStringify } from './normalize.js'

/** The inputs worth fingerprinting. Leave out what a scenario does not have. */
export type BehaviorInputs = {
  /** System prompt. */
  system?: string
  /** The user message or scenario input that starts the run. */
  user?: string
  /** Model identifier, exactly as sent to the provider. */
  model?: string
  /** Tool definitions, in the order the model receives them. */
  tools?: unknown
  /** The policy assertions enforced on every path. */
  policy?: unknown
  /** Sampling and request parameters: temperature, max tokens, tool choice. */
  params?: Record<string, unknown>
  /** Anything else that steers behaviour: retrieved policy text, a router table, feature flags. */
  extra?: Record<string, unknown>
}

export type BehaviorFingerprintV1 = {
  version: 1
  /** Component name to sha256 hex digest. Absent components are omitted. */
  components: Record<string, string>
  /** Digest over all components, for a one-line equality check. */
  combined: string
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/** Hash each behaviour-deciding input. Components that are `undefined` are left out. */
export function fingerprintInputs(inputs: BehaviorInputs): BehaviorFingerprintV1 {
  const components: Record<string, string> = {}
  const named: [string, unknown][] = [
    ['system', inputs.system],
    ['user', inputs.user],
    ['model', inputs.model],
    ['tools', inputs.tools],
    ['policy', inputs.policy],
    ['params', inputs.params],
  ]
  for (const [name, value] of named) {
    if (value !== undefined) components[name] = digest(value)
  }
  for (const key of Object.keys(inputs.extra ?? {}).sort()) {
    const value = inputs.extra![key]
    if (value !== undefined) components[`extra.${key}`] = digest(value)
  }
  return { version: 1, components, combined: digest(components) }
}

/**
 * Names of the components that differ between two fingerprints, sorted.
 * A component present on only one side counts as changed.
 */
export function changedComponents(
  previous: BehaviorFingerprintV1,
  current: BehaviorFingerprintV1,
): string[] {
  const names = new Set([...Object.keys(previous.components), ...Object.keys(current.components)])
  return [...names].filter((n) => previous.components[n] !== current.components[n]).sort()
}

/** Validate a fingerprint read from disk. Throws with a usable message on anything else. */
export function parseFingerprint(data: unknown): BehaviorFingerprintV1 {
  const bad = (why: string): never => {
    throw new Error(`invalid fingerprint file: ${why}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return bad('expected an object')
  const d = data as Record<string, unknown>
  if (d['version'] !== 1) return bad('expected "version": 1')
  const components = d['components']
  if (components === null || typeof components !== 'object' || Array.isArray(components)) {
    return bad('expected "components" to be an object')
  }
  for (const [k, v] of Object.entries(components as Record<string, unknown>)) {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) return bad(`component "${k}" is not a sha256 hex digest`)
  }
  if (typeof d['combined'] !== 'string') return bad('expected "combined" to be a string')
  return { version: 1, components: components as Record<string, string>, combined: d['combined'] }
}
