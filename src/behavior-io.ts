/**
 * @fileoverview Read and write the files a behaviour check works from: the
 * approved-paths file, the policy file and the fingerprint file.
 *
 * All three are committed to the repository and edited by hand, so each loader
 * validates shape and fails with a message that names the file and the problem.
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { TraceAssertion } from './assert.js'
import type { ToolCallRecord } from './types.js'
import type { Variant, VariantFileV1 } from './variants.js'
import type { BehaviorFingerprintV1 } from './fingerprint.js'
import { parseFingerprint } from './fingerprint.js'
import { policyHasRules } from './behavior.js'
import { exactSnapshot, parseExactArguments } from './replay-identity.js'

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8')
  try {
    return parseExactArguments(raw)
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseCalls(value: unknown, where: string): ToolCallRecord[] {
  if (!Array.isArray(value)) throw new Error(`${where}: "calls" must be an array`)
  return value.map((c, i) => {
    if (!isPlainObject(c) || typeof c['name'] !== 'string' || !isPlainObject(c['args'])) {
      throw new Error(`${where}: call ${i} must be { "name": string, "args": object }`)
    }
    return { name: c['name'], args: c['args'] }
  })
}

/** Validate an approved-paths file. */
export function parseVariantFile(data: unknown, where = 'variants file'): VariantFileV1 {
  if (!isPlainObject(data)) throw new Error(`${where}: expected an object`)
  if (data['version'] !== 1) throw new Error(`${where}: expected "version": 1`)
  if (!Array.isArray(data['variants'])) throw new Error(`${where}: "variants" must be an array`)
  const names = new Set<string>()
  const variants: Variant[] = data['variants'].map((v, i) => {
    if (!isPlainObject(v) || typeof v['name'] !== 'string' || v['name'] === '') {
      throw new Error(`${where}: variant ${i} needs a non-empty "name"`)
    }
    if (names.has(v['name'])) throw new Error(`${where}: duplicate variant name "${v['name']}"`)
    names.add(v['name'])
    if (v['note'] !== undefined && typeof v['note'] !== 'string') {
      throw new Error(`${where}: variant "${v['name']}" has a non-string "note"`)
    }
    return {
      name: v['name'],
      calls: parseCalls(v['calls'], `${where}: variant "${v['name']}"`),
      ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
    }
  })
  return {
    version: 1,
    ...(typeof data['scenario'] === 'string' ? { scenario: data['scenario'] } : {}),
    variants,
  }
}

export async function loadVariantFile(path: string): Promise<VariantFileV1> {
  return parseVariantFile(await readJson(path), path)
}

export async function saveVariantFile(path: string, file: VariantFileV1): Promise<void> {
  const snapshot = exactSnapshot(parseVariantFile(JSON.parse(JSON.stringify(file)) as unknown, path))
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

const POLICY_KEYS = ['sequence', 'includes', 'forbid', 'ordering', 'requires', 'maxCalls', 'maxCallsPerTool']
/** Rules that need run-time evidence objects and so cannot be written in a file. */
const LIBRARY_ONLY_KEYS = ['grounding', 'survival']
const MATCHER_KEYS = ['equals', 'contains', 'matches', 'oneOf', 'exists', 'absent']

/**
 * Validate a policy file: a JSON `TraceAssertion`.
 *
 * Anything not understood is refused instead of ignored, at every level. A
 * misspelt rule ("forbidden" for "forbid", or "arg" for "args" inside a pattern)
 * would otherwise enforce nothing and report success. For the same reason a
 * policy with no rules in it is an error.
 */
export function parsePolicyFile(data: unknown, where = 'policy file'): TraceAssertion {
  if (!isPlainObject(data)) throw new Error(`${where}: expected an object`)
  const libraryOnly = Object.keys(data).filter((k) => LIBRARY_ONLY_KEYS.includes(k))
  if (libraryOnly.length > 0) {
    throw new Error(`${where}: ${libraryOnly.map((k) => `"${k}"`).join(', ')} cannot be set in a policy file; pass it to runBehaviorCheck from code`)
  }
  const unknown = Object.keys(data).filter((k) => !POLICY_KEYS.includes(k))
  if (unknown.length > 0) {
    throw new Error(`${where}: unknown rule ${unknown.map((k) => `"${k}"`).join(', ')}. Known rules: ${POLICY_KEYS.join(', ')}`)
  }
  const pairs = (key: string): void => {
    const v = data[key]
    if (v === undefined) return
    const ok = Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string'))
    if (!ok) throw new Error(`${where}: "${key}" must be an array of [string, string] pairs`)
  }
  const strings = (key: string): void => {
    const v = data[key]
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      throw new Error(`${where}: "${key}" must be an array of tool names`)
    }
  }
  const patterns = (key: string): void => {
    const v = data[key]
    if (v === undefined) return
    if (!Array.isArray(v)) throw new Error(`${where}: "${key}" must be an array of tool names or { "name", "args" } patterns`)
    v.forEach((x, i) => {
      if (typeof x === 'string') return
      const at = `${where}: "${key}" entry ${i}`
      if (!isPlainObject(x) || typeof x['name'] !== 'string') {
        throw new Error(`${at} must be a tool name or a { "name", "args" } pattern`)
      }
      const extra = Object.keys(x).filter((k) => k !== 'name' && k !== 'args')
      if (extra.length > 0) throw new Error(`${at} has unknown key ${extra.map((k) => `"${k}"`).join(', ')}; a pattern has only "name" and "args"`)
      if (x['args'] === undefined) return
      if (!isPlainObject(x['args'])) throw new Error(`${at}: "args" must be an object of argument name to expected value or matcher`)
      for (const [arg, matcher] of Object.entries(x['args'])) {
        if (!isPlainObject(matcher)) continue // a bare value means { equals: value }
        const keys = Object.keys(matcher)
        // An object with exactly one known matcher key is a matcher; any other object is a literal value to equal.
        if (keys.length === 1 && keys[0] === 'matches') {
          if (typeof matcher['matches'] !== 'string') throw new Error(`${at}: arg "${arg}": "matches" must be a regular expression string`)
          try {
            new RegExp(matcher['matches'])
          } catch {
            throw new Error(`${at}: arg "${arg}": "matches" is not a valid regular expression`)
          }
        }
        if (keys.length === 1 && keys[0] === 'contains' && typeof matcher['contains'] !== 'string') {
          throw new Error(`${at}: arg "${arg}": "contains" must be a string`)
        }
        if (keys.length === 1 && keys[0] === 'oneOf' && !Array.isArray(matcher['oneOf'])) {
          throw new Error(`${at}: arg "${arg}": "oneOf" must be an array`)
        }
        const near = keys.filter((k) => !MATCHER_KEYS.includes(k) && MATCHER_KEYS.some((m) => m.toLowerCase() === k.toLowerCase()))
        if (near.length > 0) throw new Error(`${at}: arg "${arg}": unknown matcher "${near[0]}"; matchers are ${MATCHER_KEYS.join(', ')}`)
      }
    })
  }
  const count = (key: string): void => {
    const v = data[key]
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
      throw new Error(`${where}: "${key}" must be a non-negative integer`)
    }
  }
  pairs('ordering')
  pairs('requires')
  strings('forbid')
  patterns('sequence')
  patterns('includes')
  count('maxCalls')
  count('maxCallsPerTool')
  if (!policyHasRules(data as TraceAssertion)) {
    throw new Error(`${where}: contains no rules, so it would enforce nothing. Add a rule or drop the policy.`)
  }
  return data as TraceAssertion
}

export async function loadPolicyFile(path: string): Promise<TraceAssertion> {
  return parsePolicyFile(await readJson(path), path)
}

export async function loadFingerprintFile(path: string): Promise<BehaviorFingerprintV1> {
  try {
    return parseFingerprint(await readJson(path))
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function saveFingerprintFile(path: string, fingerprint: BehaviorFingerprintV1): Promise<void> {
  await writeFile(path, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8')
}
