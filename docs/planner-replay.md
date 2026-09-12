# Recorded plans and deterministic router regression

`collectTrace` returns the usual version-1 trace plus optional `plannerOutputs`.
Use `AssistantTurn.planner_output` when a model adapter explicitly captures
application planner output, or opt into `capturePlannerOutput: true` when the
model's ordinary content is the planner output. This flag also works with
`recordTrace` and `collectWithCompaction`. `collectToolCalls` remains calls-only.

Each plan stores literal `text`, one-based `atStep`, zero-based `atCall` and
`callCount`, the exact number of tool calls attached to that planner turn.
JSON save/load and v1→v2 normalization retain this attribute. Arena exports the
same representation from `Step.planner_output`. Ordinary text is not silently
relabelled, missing text remains unavailable, and no private model reasoning
is requested or synthesized.

```js
import { replayPlannerRouting } from 'agent-vcr'
const report = replayPlannerRouting({
  trace,
  routerId: 'literal-router-v1',
  route: text => text === 'done' ? [] : [{ name: 'read', args: { id: text } }],
})
```

`route` is an application parser/router that must be pure and synchronous.
The API calls it twice per plan and compares snapshots to catch nondeterminism.
It returns per-plan expected/actual tool requests and PASS/UNKNOWN, with
`modelCalls: 0` and `toolCalls: 0`. It never calls a model or tool executor and
never supplies a fabricated or recorded environment return. A changed router
can diverge; that case is UNKNOWN and cannot certify a counterfactual outcome.

Missing plan text, uncovered tool spans, invalid boundaries, unsafe integer
identities, malformed/asynchronous outputs, callback errors and observed
nondeterminism produce UNKNOWN. An empty unrecorded plan suite cannot pass.
Use string identifiers when exact values exceed the safe-integer range.

This tests routing on **fixed recorded plans**. It does not claim to test a
changed model prompt, and it cannot stop caller-provided router code from
performing out-of-band work. No tool-result replay is involved. Both replay interfaces now share the full canonical digest and strict key-order/position
checks. Capture and disk loading reject precision-losing argument JSON. This validation
does not retrospectively certify data produced by a legacy lossy recorder.

Run `npm test -- tests/planner.test.ts` for zero-network regressions. The existing
CI runs all tests on pull requests and main merges, now also on merge queues.
