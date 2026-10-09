#!/usr/bin/python3
"""
Amadues 审计收集器 — ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §6 监控隔离

以独立系统用户（_amaudit）运行，agent 进程（运行于人类用户）只能向 Unix socket 追加事件，
无法读取、改写或删除日志，也无法杀掉本进程。

- 每条事件由收集器（而非 agent）计算哈希链：hash = sha256(prev | seq | recv_at | canonical(entry))
- 每个来源一条链，链头持久化在 <log>/<source>/HEAD，重启后续接
- 来源超过 --gap-seconds 未发任何事件（含心跳）→ 写 audit.gap；恢复后写 audit.resume

只依赖 Python 标准库，由 root 拥有的 /usr/bin/python3 执行。
"""
import argparse
import asyncio
import datetime
import hashlib
import json
import os
import re
import sys
import time

GENESIS = "0" * 64
MAX_LINE = 256 * 1024


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def chain_hash(prev, seq, recv_at, entry):
    h = hashlib.sha256()
    h.update(f"{prev}|{seq}|{recv_at}|".encode("utf-8"))
    h.update(canonical(entry).encode("utf-8"))
    return h.hexdigest()


def safe_source(name):
    s = re.sub(r"[^A-Za-z0-9._-]", "_", str(name or "unknown"))[:64]
    return s or "unknown"


def utc_now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


class Chain:
    def __init__(self, log_root, source):
        self.dir = os.path.join(log_root, source)
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.head_path = os.path.join(self.dir, "HEAD")
        self.seq, self.prev = 0, GENESIS
        try:
            with open(self.head_path, "r", encoding="utf-8") as f:
                head = json.load(f)
            self.seq, self.prev = int(head["seq"]), str(head["hash"])
        except (OSError, ValueError, KeyError):
            pass

    def append(self, entry):
        self.seq += 1
        recv_at = utc_now_iso()
        digest = chain_hash(self.prev, self.seq, recv_at, entry)
        record = {"seq": self.seq, "recv_at": recv_at, "prev": self.prev, "hash": digest, "entry": entry}
        day = recv_at[:10]
        with open(os.path.join(self.dir, f"{day}.jsonl"), "a", encoding="utf-8") as f:
            f.write(canonical(record) + "\n")
        self.prev = digest
        tmp = self.head_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"seq": self.seq, "hash": digest, "at": recv_at}, f)
        os.replace(tmp, self.head_path)


class Collector:
    def __init__(self, log_root, gap_seconds):
        self.log_root = log_root
        self.gap_seconds = gap_seconds
        self.chains = {}
        self.last_seen = {}
        self.in_gap = set()
        # 重启后从链头恢复各来源的最后活动时间，重启前就已失联的来源同样会被标记静默
        for source in os.listdir(log_root):
            if source.startswith("_"):
                continue
            try:
                with open(os.path.join(log_root, source, "HEAD"), "r", encoding="utf-8") as f:
                    at = json.load(f)["at"]
                self.last_seen[source] = datetime.datetime.fromisoformat(at).timestamp()
            except (OSError, ValueError, KeyError):
                pass

    def chain(self, source):
        c = self.chains.get(source)
        if c is None:
            c = self.chains[source] = Chain(self.log_root, source)
        return c

    def ingest(self, raw):
        try:
            entry = json.loads(raw)
            if not isinstance(entry, dict):
                entry = {"kind": "audit.malformed", "raw": raw[:2000]}
        except ValueError:
            entry = {"kind": "audit.malformed", "raw": raw[:2000]}
        source = safe_source(entry.get("agent"))
        if source in self.in_gap:
            self.in_gap.discard(source)
            self.chain(source).append(
                {"kind": "audit.resume", "silent_for_s": round(time.time() - self.last_seen.get(source, time.time()))}
            )
        self.last_seen[source] = time.time()
        self.chain(source).append(entry)

    def check_gaps(self):
        now = time.time()
        for source, seen in list(self.last_seen.items()):
            if source not in self.in_gap and now - seen > self.gap_seconds:
                self.in_gap.add(source)
                self.chain(source).append(
                    {"kind": "audit.gap", "silent_for_s": round(now - seen), "threshold_s": self.gap_seconds}
                )


async def handle(collector, reader, writer):
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            text = line[:MAX_LINE].decode("utf-8", errors="replace").strip()
            if text:
                collector.ingest(text)
    except (ConnectionError, asyncio.LimitOverrunError, ValueError):
        pass
    finally:
        writer.close()


async def gap_loop(collector):
    interval = max(1, min(30, collector.gap_seconds // 2))
    while True:
        await asyncio.sleep(interval)
        try:
            collector.check_gaps()
        except Exception as e:  # noqa: BLE001 — 静默检测不能因单次异常整体停掉
            print(f"[audit] gap check failed: {e!r}", file=sys.stderr, flush=True)


async def main_async(args):
    log_root = os.path.join(args.root, "log")
    run_dir = os.path.join(args.root, "run")
    os.makedirs(log_root, mode=0o700, exist_ok=True)
    os.makedirs(run_dir, exist_ok=True)
    # umask 077 下 makedirs 的 mode 会被屏蔽；run/ 必须对 agent 用户可穿越才能连 socket
    os.chmod(run_dir, 0o755)
    sock = os.path.join(run_dir, "audit.sock")
    try:
        os.unlink(sock)
    except FileNotFoundError:
        pass
    collector = Collector(log_root, args.gap_seconds)
    server = await asyncio.start_unix_server(
        lambda r, w: handle(collector, r, w), path=sock, limit=MAX_LINE
    )
    os.chmod(sock, 0o666)
    collector.chain("_collector").append({"kind": "audit.collector_start", "pid": os.getpid(), "uid": os.getuid()})
    print(f"[audit] listening on {sock}, logs -> {log_root}", flush=True)
    # 事件循环只弱引用 task，必须持有引用，否则静默检测可能被回收
    gap_task = asyncio.ensure_future(gap_loop(collector))
    async with server:
        await asyncio.gather(server.serve_forever(), gap_task)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, help="包含 log/ 与 run/ 的根目录")
    p.add_argument("--gap-seconds", type=int, default=180)
    args = p.parse_args()
    os.umask(0o077)
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
