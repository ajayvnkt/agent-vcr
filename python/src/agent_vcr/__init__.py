"""Offline trace writing and checks using the authoritative Agent VCR Node CLI.

No model calls, shell execution, install-on-demand or policy reimplementation.
V1 captures observed tool dispatch names/arguments, not outcomes or ownership.
"""
from dataclasses import dataclass
import json
import hashlib
import math
from pathlib import Path
import subprocess
import tempfile
from typing import Any, Sequence


class ClientError(RuntimeError):
    """Engine unavailable, timed out or returned invalid evidence; never a pass."""


def _json(value):
    # Freeze caller-owned data and reject non-JSON values / nonfinite numbers.
    def validate(v):
        if v is None or type(v) in (str, bool, int): return
        if type(v) is float and math.isfinite(v): return
        if type(v) is list:
            for item in v: validate(item)
            return
        if type(v) is dict and all(type(k) is str for k in v):
            for item in v.values(): validate(item)
            return
        raise ValueError("finite JSON values and string keys required")
    validate(value)
    return json.dumps(value, allow_nan=False, ensure_ascii=True)


def _scenario(case, expected):
    required = {"name", "status", "class", "variant", "reason", "calls", "failures", "divergence", "inputs"}
    if not isinstance(case, dict) or not required <= case.keys(): return False
    if case["name"] != expected.get("name") or not isinstance(case["name"], str): return False
    if not isinstance(case["reason"], str) or case["status"] not in {"pass", "review", "fail", "error"}: return False
    if case["class"] not in {None, "golden", "accepted", "unreviewed", "regression", "error"}: return False
    if case["variant"] is not None and not isinstance(case["variant"], str): return False
    if case["divergence"] is not None and not isinstance(case["divergence"], dict): return False
    if any(not isinstance(case[k], list) for k in ("calls", "failures", "inputs")): return False
    for call in case["calls"]:
        if not isinstance(call, dict) or not isinstance(call.get("name"), str) or not isinstance(call.get("args"), dict): return False
    for item in case["inputs"]:
        if not isinstance(item, dict) or any(not isinstance(item.get(k), str) for k in ("role", "path", "sha256")): return False
        if len(item["sha256"]) != 64 or any(c not in "0123456789abcdef" for c in item["sha256"]): return False
    _json(case)
    return True


class Recorder:
    """Append observed dispatches in order. No tools are executed by this class."""
    def __init__(self, scenario: str | None = None):
        if scenario is not None and not isinstance(scenario, str):
            raise ValueError("scenario must be a string")
        self.scenario = scenario
        self._calls = []

    def record(self, name: str, arguments: dict[str, Any]) -> None:
        if not isinstance(name, str) or not name.strip() or type(arguments) is not dict:
            raise ValueError("nonempty tool name and argument object required")
        self._calls.append(json.loads(_json({"name": name, "args": arguments})))

    def write(self, path: str | Path) -> Path:
        data = {"version": 1, "calls": self._calls}
        if self.scenario is not None: data["scenario"] = self.scenario
        text = _json(data)
        path = Path(path)
        with path.open("x", encoding="utf-8") as f: f.write(text + "\n")
        return path


@dataclass(frozen=True)
class CheckResult:
    report: dict[str, Any]
    exit_code: int

    @property
    def passed(self) -> bool:
        # A review is not a pass, even if caller selected non-strict engine exit.
        return self.exit_code == 0 and self.report["verdict"] == "pass"


class Client:
    """Uses an installed/pinned CLI, e.g. ('node', '/checkout/dist/cli.js').

    Timeout bounds the child process; command is trusted local code. No npx or
    automatic package download. Methods accept existing files; no live commands.
    """
    def __init__(self, command: Sequence[str] = ("agent-vcr",), *, timeout: float = 30):
        if isinstance(command, (str, bytes)) or not command or any(not isinstance(x, str) or not x for x in command):
            raise ValueError("command must be a nonempty argv sequence")
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        self.command, self.timeout = tuple(command), timeout

    def _run(self, *args):
        try:
            return subprocess.run([*self.command, *args], capture_output=True,
                                  text=True, timeout=self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
            raise ClientError("VCR engine unavailable, timed out, or emitted invalid text") from exc

    def check(self, suite: str | Path, *, strict: bool = True) -> CheckResult:
        if type(strict) is not bool: raise ValueError("strict must be boolean")
        try:
            suite_path = Path(suite).resolve()
            suite_bytes = suite_path.read_bytes()
            suite_hash = hashlib.sha256(suite_bytes).hexdigest()
            expected_cases = json.loads(suite_bytes)["scenarios"]
            if not isinstance(expected_cases, list) or not expected_cases:
                raise ValueError("nonempty suite required")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ClientError("suite unavailable or invalid") from exc
        with tempfile.TemporaryDirectory(prefix="agent-vcr-check-") as tmp:
            args = ["check", "--suite", str(Path(suite).resolve()), "--out-dir", tmp]
            if strict: args.append("--strict")
            proc = self._run(*args)
            try:
                report = json.loads((Path(tmp) / "results.json").read_text(encoding="utf-8"))
                counts = report["counts"]
                cases = report["scenarios"]
                valid = (type(report["version"]) is int and report["version"] == 1 and report["verdict"] in ("pass", "review", "fail")
                         and isinstance(report.get("tool"), str) and report["tool"].startswith("agent-vcr")
                         and isinstance(report.get("generatedAt"), str) and bool(report["generatedAt"])
                         and report["suite"]["path"] == str(suite_path)
                         and report["suite"]["sha256"] == suite_hash
                         and isinstance(report["suite"].get("name"), str)
                         and suite_path.read_bytes() == suite_bytes
                         and isinstance(cases, list) and len(cases) == len(expected_cases)
                         and all(_scenario(c, e) for c, e in zip(cases, expected_cases))
                         and set(counts) == {"pass", "review", "fail", "error"}
                         and all(type(n) is int and n >= 0 for n in counts.values())
                         and sum(counts.values()) == len(cases)
                         and all(sum(c.get("status") == k for c in cases) == counts[k] for k in counts))
                expected = "fail" if counts["fail"] + counts["error"] else "review" if counts["review"] else "pass"
                code = 1 if expected == "fail" or (strict and expected == "review") else 0
                if not valid or report["verdict"] != expected or proc.returncode != code:
                    raise ValueError("inconsistent report")
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                raise ClientError("VCR did not produce a valid consistent check report") from exc
            return CheckResult(report, proc.returncode)

    def from_otel(self, source: str | Path, destination: str | Path, *, names_only: bool = False) -> Path:
        if type(names_only) is not bool: raise ValueError("names_only must be boolean")
        args = ["from-otel", str(Path(source).resolve())]
        if names_only: args.append("--names-only")
        proc = self._run(*args)
        if proc.returncode != 0:
            raise ClientError("OpenTelemetry import refused: " + proc.stderr.strip())
        try:
            trace = json.loads(proc.stdout)
            if trace["version"] != 1 or not isinstance(trace["calls"], list) or not trace["calls"]:
                raise ValueError("empty trace")
            recorder = Recorder(trace.get("scenario"))
            for call in trace["calls"]: recorder.record(call["name"], call["args"])
        except (ValueError, KeyError, TypeError) as exc:
            raise ClientError("VCR returned an invalid trace") from exc
        return recorder.write(destination)
