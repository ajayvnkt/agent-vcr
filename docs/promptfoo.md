# Evidence assertions for Promptfoo

Use the narrow provenance and transformation-survival checks inside your existing evaluator.
This checkout exposes `dist/promptfoo.js` and the `./promptfoo` package subpath. The adapter
is unreleased; examples below use a local build rather than assuming a registry package.

```sh
rtk npm run build
```

In Promptfoo's configuration, use its documented JavaScript assertion route:

```yaml
assert:
  - type: javascript
    value: file:///absolute/path/to/agent-vcr/dist/promptfoo.js
    config:
      grounding:
        - tool: privileged_write
          arguments: [owner_id]
      survival:
        - id: owner_reference
          fact: owner-42
          transformation: compact
          neededBy: privileged_write
```

Your trusted custom provider returns `metadata.vcrEvidence` alongside `output`:

```json
{
  "output": "Completed",
  "metadata": {
    "vcrEvidence": {
      "version": 1,
      "complete": true,
      "calls": [{"name": "privileged_write", "args": {"owner_id": "owner-42"}}],
      "sources": [{"id": "state-0", "kind": "state", "value": {"owner": "owner-42"}, "availableBefore": 0}],
      "citations": [{"call": 0, "argument": "owner_id", "source": "state-0", "path": "owner"}],
      "transformations": [{"id": "cut-0", "kind": "compact", "atCall": 0,
        "before": "Owner is owner-42", "after": "Owner is owner-42"}]
    }
  }
}
```

This is an evidence contract, not instrumentation supplied by Promptfoo. Capture sources and
effective contexts in trusted application code. Never accept an envelope invented in model output.
The assertion intentionally ignores output text and generic trace bodies; truncated spans cannot
establish complete evidence. Missing, malformed or incomplete envelopes return `pass: false`,
`score: 0`, and `metadata.status: unsupported`. Violations return `fail`; empty or unexercised
contracts cannot pass. A literal citation proves provenance, not authorization or semantic correctness.

For VCR's compaction collector, set `captureEvidence: true`, then use
`evidenceFromCompactedRun(run, sources, citations)` from `dist/promptfoo.js`. Capture is opt-in
because full context may be sensitive. It includes retained messages on both sides of the cut;
the summarizer's output alone is insufficient. Runs without captured context are rejected by
the conversion helper when they contain a compaction.

Validation: the existing `rag-validation` trace exercises valid/invalid/prior-state grounding.
The existing `compaction-stability` example exercises actual collector capture, preserved facts
and a deliberate lost-fact negative control. Its user input now explicitly supplies the reference
being preserved, so the summarizer does not invent it. Run `npm run example:compaction-stability`.
The adapter tests call the documented assertion interface directly; a live Promptfoo runtime
compatibility test remains outstanding. There is no claim of a native arbitrary assertion-type
plugin registry. [Promptfoo JavaScript interface](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)

These checks can inspect bounded evidence within an open-ended agent, but do not assess the
quality of its research or prose. Mechanical outcome generation, outcome calibration and
cost-per-success require a deterministic policy-to-state oracle and binary resolution predicate.
