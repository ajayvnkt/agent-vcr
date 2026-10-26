/** Fail-closed identity boundary shared by both replay interfaces. */
import { createHash } from 'node:crypto'
import { stableStringify } from './normalize.js'

export function exactSnapshot<T>(input: T, optionalRootKeys: readonly string[] = []): T {
  const active = new Set<object>()
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) return value
    if (!value || typeof value !== 'object' || active.has(value) || Object.getOwnPropertySymbols(value).length) {
      throw new Error('inexact JSON value')
    }
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('plain JSON required')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (array && (Object.keys(descriptors).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(descriptors, i)))) {
      throw new Error('dense JSON array required')
    }
    active.add(value)
    const result: Record<string, unknown> | unknown[] = array ? [] : {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('JSON data properties required')
      if (value === input && descriptor.value === undefined && optionalRootKeys.includes(key)) continue
      Object.defineProperty(result, key, { value: visit(descriptor.value), enumerable: true, writable: true, configurable: true })
    }
    active.delete(value)
    return result
  }
  return visit(input) as T
}

// Compare decimal values before JSON.parse can round a distinct numeric literal.
function decimal(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!
  let digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '')
  if (!digits) return '0'
  let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length)
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++ }
  return `${match[1]}${digits}e${exponent}`
}

export function parseExactArguments(text: string): Record<string, unknown> {
  if (typeof text !== 'string') throw new Error('argument JSON text required')
  let at = 0
  const whitespace = () => { while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length) at++ }
  const string = (): string => {
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '\\') at++
      else if (char === '"') return JSON.parse(text.slice(start, at)) as string
    }
    throw new Error('unterminated string')
  }
  const value = (): unknown => {
    whitespace()
    if (text[at] === '"') return string()
    if (text[at] === '{') {
      at++; whitespace()
      const object: Record<string, unknown> = {}; const keys: string[] = []
      if (text[at] === '}') { at++; return object }
      while (true) {
        whitespace(); if (text[at] !== '"') throw new Error('object key required')
        const key = string()
        if (keys.includes(key)) throw new Error('duplicate argument key')
        keys.push(key); whitespace()
        if (text[at++] !== ':') throw new Error('colon required')
        Object.defineProperty(object, key, { value: value(), enumerable: true, writable: true, configurable: true })
        whitespace(); const separator = text[at++]
        if (separator === '}') break
        if (separator !== ',') throw new Error('object separator required')
      }
      if (JSON.stringify(keys) !== JSON.stringify(Object.keys(object))) throw new Error('key order cannot be preserved')
      return object
    }
    if (text[at] === '[') {
      at++; whitespace(); const array: unknown[] = []
      if (text[at] === ']') { at++; return array }
      while (true) {
        array.push(value()); whitespace(); const separator = text[at++]
        if (separator === ']') return array
        if (separator !== ',') throw new Error('array separator required')
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return result }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0]
    if (!token) throw new Error('JSON value required')
    at += token.length
    const number = Number(token)
    exactSnapshot(number)
    if (decimal(token) !== decimal(String(number))) throw new Error('numeric argument loses precision')
    return number
  }
  const parsed = value(); whitespace()
  if (at !== text.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('complete argument object required')
  }
  return parsed as Record<string, unknown>
}

/** Tool-call argument text. Providers send "" for zero-argument tools, which means {}. */
export function parseToolArguments(text: string): Record<string, unknown> {
  if (typeof text === 'string' && text.trim() === '') return {}
  return parseExactArguments(text)
}

export function callIdentity(call: { name: string; args: Record<string, unknown> }, position: number) {
  const snapshot = exactSnapshot(call)
  if (typeof snapshot.name !== 'string' || !snapshot.name.trim() || !snapshot.args ||
      typeof snapshot.args !== 'object' || Array.isArray(snapshot.args)) throw new Error('named call with argument object required')
  return {
    digest: createHash('sha256').update(stableStringify({ position, name: snapshot.name, args: snapshot.args })).digest('hex'),
    // Deliberately stricter than canonical object equality: reordered keys are inconclusive.
    order: JSON.stringify(snapshot.args),
  }
}

export function sameIdentity(a: ReturnType<typeof callIdentity>, b: ReturnType<typeof callIdentity>): boolean {
  return a.digest === b.digest && a.order === b.order
}
