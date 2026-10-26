/** Component token measurements; no inference about end-to-end spend. */
export type ContextComponents = Record<string, string>
export type ContextTokenizer = {
  tokenizerId: string
  encode: (text: string) => ArrayLike<number>
}
export type ComponentDelta = {
  component: string
  change: 'added' | 'removed' | 'changed'
  before: string | null
  after: string | null
  tokensBefore: number
  tokensAfter: number
  tokenDelta: number
}
export type ContextDiff = {
  tokenizerId: string
  components: ComponentDelta[]
  sumComponentTokensBefore: number
  sumComponentTokensAfter: number
  tokenDelta: number
  scope: string
}

export function diffContext(before: ContextComponents, after: ContextComponents,
  tokenizer: ContextTokenizer): ContextDiff {
  if (!tokenizer.tokenizerId?.trim()) throw new Error('named tokenizer/version required')
  for (const input of [before, after]) {
    if (!input || Array.isArray(input) || typeof input !== 'object' ||
      Object.entries(input).some(([key, value]) => !key || typeof value !== 'string')) {
      throw new Error('components must map nonempty names to literal text')
    }
  }
  const count = (text: string): number => {
    const encoded = tokenizer.encode(text)
    if (!encoded || !Number.isSafeInteger(encoded.length) || encoded.length < 0) {
      throw new Error('tokenizer must return token IDs')
    }
    const tokens = Array.from(encoded)
    if (tokens.some(t => !Number.isSafeInteger(t) || t < 0)) throw new Error('invalid token ID')
    return tokens.length
  }
  const components: ComponentDelta[] = []
  let sumComponentTokensBefore = 0
  let sumComponentTokensAfter = 0
  for (const component of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const had = Object.prototype.hasOwnProperty.call(before, component)
    const has = Object.prototype.hasOwnProperty.call(after, component)
    const a = had ? before[component]! : null
    const b = has ? after[component]! : null
    const tokensBefore = a === null ? 0 : count(a)
    const tokensAfter = b === null ? 0 : count(b)
    sumComponentTokensBefore += tokensBefore
    sumComponentTokensAfter += tokensAfter
    if (a !== b) components.push({ component, change: !had ? 'added' : !has ? 'removed' : 'changed',
      before: a, after: b, tokensBefore, tokensAfter, tokenDelta: tokensAfter - tokensBefore })
  }
  return { tokenizerId: tokenizer.tokenizerId, components, sumComponentTokensBefore,
    sumComponentTokensAfter, tokenDelta: sumComponentTokensAfter - sumComponentTokensBefore,
    scope: 'Measured with the supplied tokenizer; component sums exclude framing and cross-component token merges. No end-to-end cost conclusion.' }
}
