#!/usr/bin/env python3
"""Aggregate base-node done/capped tool-call stats from bot2 pi-mono logs."""
import json
import glob
import statistics
from pathlib import Path

root = Path(r"d:\kuroneko\packages\server\data-bot2\workspaces")
done = []
capped = []

for path in glob.glob(str(root / "**" / ".run" / "pi-mono" / "logs" / "*.jsonl"), recursive=True):
    task = Path(path).parts[Path(path).parts.index("workspaces") + 1]
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("module") != "base-node":
                continue
            ev = o.get("event")
            d = o.get("data", {})
            row = {**d, "task": task, "ts": o.get("ts")}
            if ev == "done":
                done.append(row)
            elif ev == "safety_cap":
                capped.append(row)


def percentile(arr, p):
    if not arr:
        return None
    s = sorted(arr)
    k = (len(s) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


tools = [x["tools"] for x in done if "tools" in x]
rounds = [x["rounds"] for x in done if "rounds" in x]

print("=== SUCCESS (base-node done) ===")
print(f"count: {len(done)}")
if tools:
    print(
        f"tools: min={min(tools)} p25={percentile(tools,25):.0f} "
        f"median={statistics.median(tools):.0f} p75={percentile(tools,75):.0f} "
        f"p90={percentile(tools,90):.0f} max={max(tools)} mean={statistics.mean(tools):.1f}"
    )
if rounds:
    print(
        f"rounds: min={min(rounds)} p25={percentile(rounds,25):.0f} "
        f"median={statistics.median(rounds):.0f} p75={percentile(rounds,75):.0f} "
        f"p90={percentile(rounds,90):.0f} max={max(rounds)} mean={statistics.mean(rounds):.1f}"
    )
for cap in (10, 15, 20, 30):
    n = sum(1 for t in tools if t <= cap)
    print(f"  tools<={cap}: {n}/{len(tools)} ({100*n/len(tools):.0f}%)")

print("\n=== CAPPED (safety_cap @ 50 rounds) ===")
print(f"count: {len(capped)}")

print("\n--- successful nodes (sorted by tools) ---")
for x in sorted(done, key=lambda z: z.get("tools", 0)):
    tid = x.get("task", "?")[:24]
    nid = x.get("nodeInstId", "?")[:22]
    print(f"  {tid:24} {nid:22} rounds={x.get('rounds', '?'):>2} tools={x.get('tools', '?'):>2}")

print("\n--- tool count buckets (success) ---")
bounds = [(1, 3), (4, 6), (7, 10), (11, 15), (16, 20), (21, 30), (31, 40), (41, 50), (51, 9999)]
for lo, hi in bounds:
    c = sum(1 for t in tools if lo <= t <= hi)
    print(f"  {lo:2}-{hi if hi<100 else '+':>2}: {c:2} {'#' * c}")

# Playwright/browser-ish vs other heuristic by node id keywords
browser_kw = ("pw", "playwright", "browser", "create", "publish", "writer", "fanqie", "probe", "http", "api", "js", "script", "form")
browser_done = [x for x in done if any(k in x.get("nodeInstId", "").lower() for k in browser_kw)]
other_done = [x for x in done if x not in browser_done]
print("\n--- browser/automation-ish success (heuristic by node id) ---")
bt = [x["tools"] for x in browser_done if "tools" in x]
if bt:
    print(f"count={len(bt)} median_tools={statistics.median(bt):.0f} mean={statistics.mean(bt):.1f} max={max(bt)}")
    print(f"tools<=10: {sum(1 for t in bt if t<=10)}/{len(bt)}")
print("--- other success ---")
ot = [x["tools"] for x in other_done if "tools" in x]
if ot:
    print(f"count={len(ot)} median_tools={statistics.median(ot):.0f} mean={statistics.mean(ot):.1f} max={max(ot)}")
