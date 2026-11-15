# Python client (source install; Node required)

Install with `python -m pip install ./python` from this checkout. Build the pinned
Node engine with `npm ci --include=dev && npm run build`. This is a thin offline
client of the existing engine, not another policy implementation. No package has
been released. Python 3.11+, Node 18+.

```python
from agent_vcr import Client, Recorder
r = Recorder("support lookup")
# Call after the executor actually dispatches the tool, not after model proposal.
r.record("lookup", {"account": "synthetic-1"})
r.write("new-trace.json")  # refuses overwrite
client = Client(("node", "/absolute/checkout/dist/cli.js"), timeout=30)
result = client.check("suite.json")  # existing VCR suite schema
assert result.passed, result.report
client.from_otel("spans.json", "new-trace-from-spans.json")
```

`check` returns the full native report with counts and verdict, including review,
policy failure and scenario errors. Strict review refusal is the default. Missing
engine/report and timeout raise `ClientError`; they never become a pass. Caller
chooses a trusted pinned executable; there is no automatic download or model call.
Outputs use exclusive creation. Check reports are returned in memory; persist them
explicitly if needed. Recording snapshots caller JSON, preserving dispatch order.

V1 contains tool names and arguments only: no results, success, identity proof,
replay of side effects, or authorization enforcement. A Python wrapper around
provider proposals does not prove execution. For actual results/state assertions,
use independent executor/backend observation. Python live-provider adapters and a
native Python replay engine are not included. Policy evaluation still uses Node.

Offline checks: `PYTHONPATH=python/src python -m unittest discover -s python/tests`.
