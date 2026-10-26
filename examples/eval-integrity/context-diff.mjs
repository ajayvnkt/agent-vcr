import { diffContext } from '../../dist/index.js'

// Synthetic exact-token vocabulary, not a provider tokenizer or character-count estimate.
const vocabulary = { 'write after check': [1, 2, 3], 'checked write': [4, 1] }
console.log(diffContext({ system: 'write after check' }, { system: 'checked write' }, {
  tokenizerId: 'synthetic-vocabulary-v1', encode: text => vocabulary[text],
}))
