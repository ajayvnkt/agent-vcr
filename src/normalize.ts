/**
 * @fileoverview Stable serialization for argument objects (order-independent keys).
 */

/**
 * Recursively sort object keys for deterministic JSON comparison.
 * Arrays preserve order; non-plain objects stringify via JSON.stringify (best-effort).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const inner = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')
  return `{${inner}}`
}

export function callsEqual(a: { name: string; args: Record<string, unknown> }, b: { name: string; args: Record<string, unknown> }): boolean {
  if (a.name !== b.name) return false
  return stableStringify(a.args) === stableStringify(b.args)
}
