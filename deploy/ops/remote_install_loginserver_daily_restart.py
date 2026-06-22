#!/usr/bin/env python3
"""Install loginserver daily-restart cron on kuroneko CVM."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import paramiko

REPO = Path(__file__).resolve().parents[2]


def read_password(repo: Path) -> tuple[str, str, str]:
    host, user, password = "43.156.244.45", "root", ""
    env_path = repo / ".local" / "kuroneko.env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("KURONEKO_SSH_HOST="):
                host = line.split("=", 1)[1].strip()
            elif line.startswith("KURONEKO_SSH_USER="):
                user = line.split("=", 1)[1].strip()
            elif line.startswith("KURONEKO_SSH_PASSWORD="):
                password = line.split("=", 1)[1].strip()
    if not password:
        print("ERROR: set KURONEKO_SSH_PASSWORD in .local/kuroneko.env", file=sys.stderr)
        sys.exit(2)
    return host, user, password


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password")
    args = parser.parse_args()

    host, user, password = read_password(REPO)
    if args.host:
        host = args.host
    if args.user:
        user = args.user
    if args.password:
        password = args.password

    restart_sh = REPO / "deploy" / "ops" / "loginserver-daily-restart.sh"
    install_sh = REPO / "deploy" / "ops" / "install-loginserver-daily-restart.sh"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30)

    sftp = client.open_sftp()
    sftp.put(str(restart_sh), "/tmp/loginserver-daily-restart.sh")
    sftp.put(str(install_sh), "/tmp/install-loginserver-daily-restart.sh")
    sftp.close()

    stdin, stdout, stderr = client.exec_command(
        "bash /tmp/install-loginserver-daily-restart.sh /tmp/loginserver-daily-restart.sh",
        timeout=60,
    )
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    print(out)
    if err.strip():
        print("STDERR:", err, file=sys.stderr)

    client.close()
    return 0 if "Installed" in out else 1


if __name__ == "__main__":
    raise SystemExit(main())
