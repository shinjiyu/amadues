#!/usr/bin/env python3
"""Deploy remote-console to kuroneko server."""
from __future__ import annotations

import argparse
import os
import sys
import tarfile
import tempfile

import paramiko


def make_tarball(src: str, dest: str) -> None:
    exclude_dirs = {
        ".git",
        "node_modules",
        "online_config",
        ".playwright-mcp",
        "mcp-server",
    }
    exclude_prefixes = (
        "server/dist",
        "web-console/dist",
    )

    def filt(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = info.name.replace("\\", "/").split("/")
        if parts[0] in exclude_dirs:
            return None
        rel = "/".join(parts)
        for p in exclude_prefixes:
            if rel == p or rel.startswith(p + "/"):
                return None
        return info

    with tarfile.open(dest, "w:gz") as tar:
        tar.add(src, arcname=".", filter=filt)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="43.156.244.45")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password", required=True)
    parser.add_argument("--src", default=r"D:\UGit\remote-console")
    parser.add_argument("--admin-emails", default="yzy.zhenyu@gmail.com")
    parser.add_argument("--nginx-conf", default=r"d:\kuroneko\deploy\nginx\kuroneko.chat.conf")
    args = parser.parse_args()

    with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
        tar_path = tmp.name
    make_tarball(args.src, tar_path)
    print(f"tarball: {tar_path} ({os.path.getsize(tar_path)} bytes)")

    env_content = (
        f"ADMIN_EMAILS={args.admin_emails}\n"
        "LOGIN_SERVER_URL=http://host.docker.internal:5001\n"
        "COOKIE_SECURE=auto\n"
        "VITE_WS_URL=wss://kuroneko.chat/remote-console/ws\n"
    )

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        args.host,
        username=args.user,
        password=args.password,
        timeout=30,
        look_for_keys=False,
        allow_agent=False,
    )

    sftp = client.open_sftp()
    sftp.put(tar_path, "/tmp/remote-console.tgz")
    sftp.put(args.nginx_conf, "/etc/nginx/conf.d/kuroneko.chat.conf")
    sftp.close()
    os.unlink(tar_path)

    script = f"""set -euo pipefail
rm -rf /opt/remote-console
mkdir -p /opt/remote-console
tar -xzf /tmp/remote-console.tgz -C /opt/remote-console
cat > /opt/remote-console/.env <<'ENVEOF'
{env_content}ENVEOF
chmod 600 /opt/remote-console/.env
mkdir -p /opt/remote-console/data/auth
chown -R 1000:1000 /opt/remote-console/data/auth 2>/dev/null || true

nginx -t
systemctl reload nginx

cd /opt/remote-console
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

for i in $(seq 1 36); do
  if curl -sf http://127.0.0.1:3003/health >/dev/null 2>&1; then
    echo "remote-console-server healthy after $i checks"
    break
  fi
  echo "waiting server... ($i/36)"
  sleep 10
done

curl -s http://127.0.0.1:3003/health || true
echo
curl -sI http://127.0.0.1:8082/ | head -5 || true
curl -skI https://127.0.0.1/remote-console/ -H 'Host: kuroneko.chat' | head -8 || true
curl -sk https://127.0.0.1/remote-console/sdk/remote-console.legacy.umd.js -H 'Host: kuroneko.chat' | head -c 80 || true
echo
docker compose -f docker-compose.prod.yml ps
"""
    stdin, stdout, stderr = client.exec_command("bash -s", timeout=900)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(out[-20000:])
    if err.strip():
        print("STDERR:", err[-4000:], file=sys.stderr)
    client.close()
    return 0 if "remote-console-server healthy" in out or '"status":"ok"' in out or '"status":"healthy"' in out else 1


if __name__ == "__main__":
    raise SystemExit(main())
