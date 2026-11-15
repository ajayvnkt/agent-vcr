# Python client acceptance, fixed before implementation

Implement a standard-library thin client over the existing offline Node CLI; do not duplicate policy semantics or add model calls. Existing v1 traces represent tool names and JSON arguments, not success/result/ownership. Record only observed dispatches; a model proposal is not execution.

Pass requires: Python trace consumed by native validator/check; native pass/review/fail/error preserved (strict review defaults to refusal); malformed/missing report, unavailable executable and timeout never pass; empty policy-only trace remains error; OpenTelemetry import delegates to existing parser and rejects chat-only exports; shell metacharacters in paths do not execute; outputs never replace preexisting evidence; nonfinite/invalid arguments rejected. Linux Python 3.11/3.13 plus full existing Node CI. No Python release, no external provider, no new evaluator.

No native Python replay engine, live provider instrumentation, async recording, result assertions or malicious executable sandbox. Caller trusts the configured executable. Node is required. Source install only; Python distribution name is provisional.
