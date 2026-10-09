#!/usr/bin/python3
"""
校验审计日志哈希链并汇总。需要读取 _amaudit 拥有的日志，因此以 sudo 运行——
只运行安装到 root 目录的副本：仓库里的副本 agent 可写，sudo 执行它等于把 root 交给 agent。

  sudo /usr/local/libexec/amadues-audit/audit_verify.py --root /private/var/amadues-audit
  sudo /usr/local/libexec/amadues-audit/audit_verify.py --root /private/var/amadues-audit --source Aki --tail 20
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit_collector import GENESIS, chain_hash  # noqa: E402


def verify_source(src_dir):
    files = sorted(glob.glob(os.path.join(src_dir, "*.jsonl")))
    prev, expect_seq = GENESIS, 1
    breaks, kinds, gaps, records = [], {}, [], []
    for fp in files:
        with open(fp, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                where = f"{os.path.basename(fp)}:{lineno}"
                try:
                    rec = json.loads(line)
                except ValueError:
                    breaks.append(f"{where} 非 JSON")
                    continue
                if rec.get("seq") != expect_seq:
                    breaks.append(f"{where} seq={rec.get('seq')} 期望 {expect_seq}（缺行或插行）")
                if rec.get("prev") != prev:
                    breaks.append(f"{where} prev 不衔接（被删改）")
                digest = chain_hash(rec.get("prev"), rec.get("seq"), rec.get("recv_at"), rec.get("entry"))
                if digest != rec.get("hash"):
                    breaks.append(f"{where} hash 不符（内容被改）")
                prev = rec.get("hash")
                expect_seq = (rec.get("seq") or expect_seq) + 1
                entry = rec.get("entry") or {}
                kind = entry.get("kind", "?")
                kinds[kind] = kinds.get(kind, 0) + 1
                if kind == "audit.gap":
                    gaps.append(f"{rec.get('recv_at')} 静默 {entry.get('silent_for_s')}s")
                records.append(rec)
    head_ok = None
    try:
        with open(os.path.join(src_dir, "HEAD"), "r", encoding="utf-8") as f:
            head = json.load(f)
        head_ok = head.get("hash") == prev
    except (OSError, ValueError):
        pass
    return {"files": len(files), "count": len(records), "breaks": breaks, "kinds": kinds,
            "gaps": gaps, "head_ok": head_ok, "records": records}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--source", help="只看某个来源（agent 名）")
    p.add_argument("--tail", type=int, default=0, help="打印最近 N 条事件")
    args = p.parse_args()
    log_root = os.path.join(args.root, "log")
    sources = sorted(d for d in os.listdir(log_root) if os.path.isdir(os.path.join(log_root, d)))
    if args.source:
        sources = [s for s in sources if s == args.source]
    bad = False
    for s in sources:
        r = verify_source(os.path.join(log_root, s))
        status = "OK" if not r["breaks"] and r["head_ok"] is not False else "TAMPERED"
        bad = bad or status != "OK"
        print(f"== {s}: {status}  events={r['count']} files={r['files']} head_ok={r['head_ok']}")
        print("   kinds: " + ", ".join(f"{k}={v}" for k, v in sorted(r["kinds"].items())))
        for b in r["breaks"][:20]:
            print(f"   ! {b}")
        for g in r["gaps"][-10:]:
            print(f"   gap {g}")
        for rec in r["records"][-args.tail:] if args.tail else []:
            e = rec["entry"]
            data = json.dumps(e.get("data", {}), ensure_ascii=False)[:300]
            print(f"   {rec['recv_at']} {e.get('kind')} {data}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
