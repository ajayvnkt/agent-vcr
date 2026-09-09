# Generic replay and context measurement

## 11. Counterfactual tool-return replay

`counterfactualReplay({prompt, recording, model, system?, maxSteps?})` accepts a changed prompt,
ordered `{name,args,result}` records, and the existing `LlmComplete` interface. A record/replay
system must capture actual returns; a trace containing only names/arguments is insufficient.
The recorder/gateway correspondence is a caller-supplied prerequisite, not a claim this function verifies.

Every requested call must match the next recorded name and complete parsed arguments exactly.
Object key order is ignored; array order, omitted/extra fields and types are not. Divergence,
unknown calls, early completion, missing results, malformed requests, callback failures and
step exhaustion return **INCONCLUSIVE**. An entire tool-request batch is checked before any of
its results are released. There is no live tool executor or fallback on this API.
COMPLETE means the recorded path was consumed and the model terminated; it does not prove outcome quality.

Tool replay costs no tool invocations. Changed prompts still require model inference: offline
callbacks can be free, but remote callbacks may incur charges. Reusing the original model
completion does not test a changed prompt. The simulator also cannot establish the outcome
of a genuinely different tool path; that case remains inconclusive, by design.

The divergence test grid covers tool names, argument values, array order, extra fields,
reordered calls, multi-call batches, early termination, excess calls, absent results and
mutable callback history. Example: after `npm run build`, run
`node examples/eval-integrity/counterfactual.mjs` for a zero-network matched and divergent pair.

## 12. Token-attributed context diff

`diffContext(beforeComponents, afterComponents, {tokenizerId, encode})` reports added, removed
and changed literal prompt components with measured token counts, signed deltas and before/after
text. The caller supplies the actual tokenizer and a versioned identity; no character proxy or
silent tokenizer substitution is used. Token IDs must be nonnegative integers.
Component sums exclude provider framing and cross-component token merges, so they are not
automatically whole-request usage. Token reductions are measurements, never cost savings;
measure a changed configuration end to end before making a spend claim.

Known token arrays validate each count and delta, including added/removed/unchanged components.
Example: `node examples/eval-integrity/context-diff.mjs` uses an explicitly synthetic exact-token
vocabulary, not a claim about a provider tokenizer. Production callers should supply their
model's tokenizer and record its version in the experiment contract.
