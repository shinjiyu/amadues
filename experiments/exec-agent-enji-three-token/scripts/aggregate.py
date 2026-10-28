#!/usr/bin/env python3
"""Aggregate usage.json from the 4 cases."""
from __future__ import annotations

import json
import sys
from pathlib import Path

CASES = ["tetris-enji", "tetris-three", "rubik-enji", "rubik-three"]
ROOT = Path(__file__).resolve().parents[1] / "results"


def main() -> int:
    rows = []
    totals = {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 0,
        "promptIncludingCache": 0,
        "llmCalls": 0,
    }
    missing = []
    for case in CASES:
        path = ROOT / case / "usage.json"
        if not path.exists():
            missing.append(case)
            rows.append({"caseId": case, "status": "missing"})
            continue
        data = json.loads(path.read_text())
        u = data.get("usage") or {}
        row = {
            "caseId": case,
            "status": "ok",
            "stopReason": data.get("stopReason"),
            "rounds": data.get("rounds"),
            "input": u.get("input", 0),
            "output": u.get("output", 0),
            "cacheRead": u.get("cacheRead", 0),
            "cacheWrite": u.get("cacheWrite", 0),
            "promptIncludingCache": u.get("promptIncludingCache", 0),
            "totalTokens": u.get("totalTokens", 0),
            "llmCalls": u.get("llmCalls", 0),
        }
        rows.append(row)
        for k in totals:
            totals[k] += int(row.get(k) or 0)

    report = {
        "model": "deepseek-flash",
        "modelLabel": "DeepSeek V4.1 Flash",
        "framework": "amadues openkuroneko exec-agent",
        "cases": rows,
        "totals": totals,
        "missing": missing,
        "notes": {
            "input": "uncached input tokens (pi-ai usage.input)",
            "output": "completion tokens (pi-ai usage.output)",
            "cacheRead": "prompt cache hits (pi-ai usage.cacheRead)",
            "promptIncludingCache": "input + cacheRead",
        },
    }
    out = ROOT / "aggregate.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"\nwrote {out}", file=sys.stderr)
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main())
