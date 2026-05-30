#!/usr/bin/env python3
"""Deploy dual WebChat stacks to kuroneko server."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile

import paramiko

EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "exports",
    "terminals",
    ".cursor",
    "apps/chat-server/data",
}
EXCLUDE_PREFIXES = (
    "packages/server/data",
    "packages/server/data-",
)


def make_tarball(src: str, dest: str) -> None:
    def filt(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        parts = info.name.replace("\\", "/").split("/")
        if parts[0] in EXCLUDE_DIRS:
            return None
        rel = "/".join(parts)
        for p in EXCLUDE_PREFIXES:
            if rel == p or rel.startswith(p):
                return None
        return info

    with tarfile.open(dest, "w:gz") as tar:
        tar.add(src, arcname=".", filter=filt)


def read_agent_secret(repo: str) -> str:
    env_path = os.path.join(repo, "deploy", "agent", "env", "kuroneko.env")
    if not os.path.isfile(env_path):
        return ""
    for line in open(env_path, encoding="utf-8", errors="replace"):
        if line.startswith("WEBCHAT_AGENT_SECRET="):
            return line.split("=", 1)[1].strip()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="43.156.244.45")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password", required=True)
    parser.add_argument("--repo", default=r"d:\kuroneko")
    parser.add_argument("--admin-emails", default="yzy.zhenyu@gmail.com")
    parser.add_argument("--nginx-conf", default=r"d:\kuroneko\deploy\nginx\kuroneko.chat.conf")
    args = parser.parse_args()

    secret = read_agent_secret(args.repo)
    if not secret:
        print("WARN: WEBCHAT_AGENT_SECRET not found in deploy/agent/env/kuroneko.env", file=sys.stderr)

    env_main = f"""MAIN_WEBCHAT_LOGIN_SERVER_URL=http://host.docker.internal:5001
MAIN_WEBCHAT_LOGIN_PAGE_URL=/login
MAIN_WEBCHAT_LOGIN_RETURN_PARAM=redirect
MAIN_WEBCHAT_ADMIN_EMAILS={args.admin_emails}
MAIN_WEBCHAT_COOKIE_SECURE=auto
MAIN_CHAT_SERVER_CORS_ORIGIN=https://kuroneko.chat
MAIN_WEBCHAT_PUBLIC_BASE_PATH=/webchat
MAIN_VITE_BASE=/webchat/
MAIN_WEBCHAT_AGENT_SECRET={secret}
MAIN_WEBCHAT_GLOBAL_THREAD_ID=global
"""
    env_lab = f"""LAB_WEBCHAT_LOGIN_SERVER_URL=http://host.docker.internal:5001
LAB_WEBCHAT_LOGIN_PAGE_URL=/login
LAB_WEBCHAT_LOGIN_RETURN_PARAM=redirect
LAB_WEBCHAT_ADMIN_EMAILS={args.admin_emails}
LAB_WEBCHAT_COOKIE_SECURE=auto
LAB_CHAT_SERVER_CORS_ORIGIN=https://kuroneko.chat
LAB_WEBCHAT_PUBLIC_BASE_PATH=/webchat-lab
LAB_VITE_BASE=/webchat-lab/
LAB_WEBCHAT_AGENT_SECRET={secret}
LAB_WEBCHAT_GLOBAL_THREAD_ID=global
"""

    with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
        tar_path = tmp.name
    print("Creating tarball (may take a minute)...")
    make_tarball(args.repo, tar_path)
    size_mb = os.path.getsize(tar_path) / (1024 * 1024)
    print(f"tarball: {tar_path} ({size_mb:.1f} MB)")

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
    print("Uploading tarball...")
    sftp.put(tar_path, "/tmp/kuroneko.tgz")
    sftp.put(args.nginx_conf, "/etc/nginx/conf.d/kuroneko.chat.conf")
    sftp.close()
    os.unlink(tar_path)

    script = f"""set -euo pipefail
rm -rf /opt/kuroneko
mkdir -p /opt/kuroneko
tar -xzf /tmp/kuroneko.tgz -C /opt/kuroneko
mkdir -p /opt/kuroneko/deploy/webchat/data-main/messages /opt/kuroneko/deploy/webchat/data-main/uploads
mkdir -p /opt/kuroneko/deploy/webchat/data-lab/messages /opt/kuroneko/deploy/webchat/data-lab/uploads
chown -R 1000:1000 /opt/kuroneko/deploy/webchat/data-main /opt/kuroneko/deploy/webchat/data-lab 2>/dev/null || true
cat > /opt/kuroneko/deploy/webchat/.env.main <<'ENVEOF'
{env_main}ENVEOF
cat > /opt/kuroneko/deploy/webchat/.env.lab <<'ENVEOF'
{env_lab}ENVEOF
chmod 600 /opt/kuroneko/deploy/webchat/.env.main /opt/kuroneko/deploy/webchat/.env.lab

nginx -t
systemctl reload nginx

cd /opt/kuroneko
docker compose -f deploy/webchat/docker-compose.webchat.dual.yml \\
  --env-file deploy/webchat/.env.main \\
  --env-file deploy/webchat/.env.lab up -d --build

for i in $(seq 1 48); do
  ok=0
  curl -sf http://127.0.0.1:8790/healthz >/dev/null 2>&1 && ok=$((ok+1))
  curl -sf http://127.0.0.1:8794/healthz >/dev/null 2>&1 && ok=$((ok+1))
  if [ "$ok" -eq 2 ]; then
    echo "both chat-servers healthy after $i checks"
    break
  fi
  echo "waiting chat-servers... ($i/48)"
  sleep 10
done

curl -s http://127.0.0.1:8790/healthz || true
echo
curl -s http://127.0.0.1:8794/healthz || true
echo
curl -skI https://127.0.0.1/webchat/ -H 'Host: kuroneko.chat' | head -6 || true
curl -skI https://127.0.0.1/webchat-lab/ -H 'Host: kuroneko.chat' | head -6 || true
docker compose -f deploy/webchat/docker-compose.webchat.dual.yml ps
"""
    stdin, stdout, stderr = client.exec_command("bash -s", timeout=1800)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(out[-25000:])
    if err.strip():
        print("STDERR:", err[-5000:], file=sys.stderr)
    client.close()
    return 0 if "both chat-servers healthy" in out else 1


if __name__ == "__main__":
    raise SystemExit(main())
