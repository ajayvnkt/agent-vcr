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
