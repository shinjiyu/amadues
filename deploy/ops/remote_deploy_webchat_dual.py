#!/usr/bin/env python3
"""Deploy dual WebChat stacks to kuroneko server."""
from __future__ import annotations

import argparse
import os
import re
import sys
import tarfile
import tempfile
from pathlib import Path

import paramiko

EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "exports",
    "terminals",
    ".cursor",
    ".local",
    "apps/chat-server/data",
}
EXCLUDE_PREFIXES = (
    "packages/server/data",
    "packages/server/data-",
)


def should_exclude(arcname: str) -> bool:
    norm = arcname.replace("\\", "/").lstrip("./")
    parts = norm.split("/")
    if not parts or parts[0] in EXCLUDE_DIRS:
        return True
    if "node_modules" in parts or ".git" in parts or ".local" in parts:
        return True
    for p in EXCLUDE_PREFIXES:
        if norm == p or norm.startswith(p):
            return True
    return False


def make_tarball(src: str, dest: str) -> None:
    src_path = Path(src)
    with tarfile.open(dest, "w:gz") as tar:
        for root, dirs, files in os.walk(src):
            rel_root = Path(root).relative_to(src_path)
            rel_s = str(rel_root).replace("\\", "/")
            if should_exclude(rel_s):
                dirs.clear()
                continue
            dirs[:] = [
                d for d in dirs
                if d not in EXCLUDE_DIRS and d not in (".git", "node_modules", ".local")
                and not should_exclude(f"{rel_s}/{d}".strip("/"))
            ]
            for name in files:
                full = Path(root) / name
                arc = str(rel_root / name).replace("\\", "/")
                if should_exclude(arc):
                    continue
                try:
                    tar.add(full, arcname=arc, recursive=False)
                except OSError as e:
                    print(f"WARN: skip {arc}: {e}", file=sys.stderr)


def read_kv_file(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.isfile(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def read_agent_secret(repo: str) -> str:
    for rel in ("deploy/agent/env/kuroneko.env", "deploy/agent/env/yuanbao.env"):
        env_path = os.path.join(repo, rel)
        if not os.path.isfile(env_path):
            continue
        for line in open(env_path, encoding="utf-8", errors="replace"):
            if line.startswith("WEBCHAT_AGENT_SECRET="):
                return line.split("=", 1)[1].strip()
    return ""


def read_jwt_secret(repo: str, explicit: str | None, secrets_file: str | None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    candidates = [
        secrets_file,
        os.path.join(os.environ.get("TEMP", "/tmp"), "kuroneko-loginserver-secrets.txt"),
        os.path.join(repo, ".local", "kuroneko-loginserver-secrets.txt"),
    ]
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        for line in open(path, encoding="utf-8", errors="replace"):
            if line.startswith("JWT_SECRET_KEY="):
                return line.split("=", 1)[1].strip()
    return ""


def load_ssh_password(args: argparse.Namespace, repo: str) -> tuple[str, str, str]:
    host = args.host
    user = args.user
    password = args.password or ""
    if not password and args.password_file:
        kv = read_kv_file(args.password_file)
        password = kv.get("KURONEKO_SSH_PASSWORD") or kv.get("SSH_PASSWORD") or ""
        host = kv.get("KURONEKO_SSH_HOST") or kv.get("SSH_HOST") or host
        user = kv.get("KURONEKO_SSH_USER") or kv.get("SSH_USER") or user
    if not password:
        kv = read_kv_file(os.path.join(repo, ".local", "kuroneko.env"))
        password = kv.get("KURONEKO_SSH_PASSWORD", "")
        host = kv.get("KURONEKO_SSH_HOST") or host
        user = kv.get("KURONEKO_SSH_USER") or user
    if not password:
        print("ERROR: SSH password required (--password or .local/kuroneko.env)", file=sys.stderr)
        sys.exit(2)
    return host, user, password


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="43.156.244.45")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password", default="")
    parser.add_argument(
        "--password-file",
        default="",
        help="e.g. .local/kuroneko.env (KURONEKO_SSH_PASSWORD)",
    )
    parser.add_argument("--repo", default=r"d:\kuroneko")
    parser.add_argument("--admin-emails", default="yzy.zhenyu@gmail.com")
    parser.add_argument("--nginx-conf", default=r"d:\kuroneko\deploy\nginx\kuroneko.chat.conf")
    parser.add_argument("--jwt-secret", default="", help="loginserver JWT_SECRET_KEY (HS256)")
    parser.add_argument(
        "--jwt-secrets-file",
        default="",
        help="file containing JWT_SECRET_KEY=... (default: %%TEMP%%/kuroneko-loginserver-secrets.txt)",
    )
    parser.add_argument(
        "--lab-agent-user-id",
        default="yuanbao,bot1,bot2",
        help="comma-separated WEBCHAT agent allowlist for lab",
    )
    args = parser.parse_args()

    repo = args.repo
    secret = read_agent_secret(repo)
    if not secret:
        print("WARN: WEBCHAT_AGENT_SECRET not found in kuroneko.env / yuanbao.env", file=sys.stderr)

    jwt_secret = read_jwt_secret(repo, args.jwt_secret or None, args.jwt_secrets_file or None)
    if not jwt_secret:
        print("WARN: JWT secret not found locally; remote deploy will read /opt/loginserver/docker.env.prod", file=sys.stderr)

    env_main = f"""MAIN_WEBCHAT_LOGIN_SERVER_URL=http://host.docker.internal:5001
MAIN_WEBCHAT_LOGIN_JWT_SECRET={jwt_secret}
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
LAB_WEBCHAT_LOGIN_JWT_SECRET={jwt_secret}
LAB_WEBCHAT_LOGIN_PAGE_URL=/login
LAB_WEBCHAT_LOGIN_RETURN_PARAM=redirect
LAB_WEBCHAT_ADMIN_EMAILS={args.admin_emails}
LAB_WEBCHAT_COOKIE_SECURE=auto
LAB_CHAT_SERVER_CORS_ORIGIN=https://kuroneko.chat
LAB_WEBCHAT_PUBLIC_BASE_PATH=/webchat-lab
LAB_VITE_BASE=/webchat-lab/
LAB_WEBCHAT_AGENT_SECRET={secret}
LAB_WEBCHAT_AGENT_USER_ID={args.lab_agent_user_id}
LAB_WEBCHAT_GLOBAL_THREAD_ID=global
"""

    with tempfile.NamedTemporaryFile(suffix=".tgz", delete=False) as tmp:
        tar_path = tmp.name
    print("Creating tarball (may take a minute)...")
    make_tarball(repo, tar_path)
    size_mb = os.path.getsize(tar_path) / (1024 * 1024)
    print(f"tarball: {tar_path} ({size_mb:.1f} MB)")

    host, user, password = load_ssh_password(args, repo)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        username=user,
        password=password,
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

    jwt_remote_block = ""
    if not jwt_secret:
        jwt_remote_block = r"""
if [ -f /opt/loginserver/docker.env.prod ]; then
  JWT_SECRET=$(grep -E '^JWT_SECRET_KEY=' /opt/loginserver/docker.env.prod | head -1 | cut -d= -f2-)
  if [ -n "$JWT_SECRET" ]; then
    sed -i "s/^MAIN_WEBCHAT_LOGIN_JWT_SECRET=.*/MAIN_WEBCHAT_LOGIN_JWT_SECRET=${JWT_SECRET}/" /opt/kuroneko/deploy/webchat/.env.main
    sed -i "s/^LAB_WEBCHAT_LOGIN_JWT_SECRET=.*/LAB_WEBCHAT_LOGIN_JWT_SECRET=${JWT_SECRET}/" /opt/kuroneko/deploy/webchat/.env.lab
    echo "patched JWT secrets from loginserver"
  fi
fi
"""

    script = f"""set -euo pipefail
DATA_BACKUP=/tmp/kuroneko-webchat-data-backup-$$
if [ -d /opt/kuroneko/deploy/webchat/data-main ] || [ -d /opt/kuroneko/deploy/webchat/data-lab ]; then
  mkdir -p "$DATA_BACKUP"
  [ -d /opt/kuroneko/deploy/webchat/data-main ] && cp -a /opt/kuroneko/deploy/webchat/data-main "$DATA_BACKUP/main"
  [ -d /opt/kuroneko/deploy/webchat/data-lab ] && cp -a /opt/kuroneko/deploy/webchat/data-lab "$DATA_BACKUP/lab"
  echo "backed up webchat data to $DATA_BACKUP"
fi
rm -rf /opt/kuroneko
mkdir -p /opt/kuroneko
tar -xzf /tmp/kuroneko.tgz -C /opt/kuroneko
mkdir -p /opt/kuroneko/deploy/webchat/data-main/messages /opt/kuroneko/deploy/webchat/data-main/uploads
mkdir -p /opt/kuroneko/deploy/webchat/data-lab/messages /opt/kuroneko/deploy/webchat/data-lab/uploads
if [ -d "$DATA_BACKUP/main" ]; then
  rm -rf /opt/kuroneko/deploy/webchat/data-main /opt/kuroneko/deploy/webchat/data-lab
  mv "$DATA_BACKUP/main" /opt/kuroneko/deploy/webchat/data-main
  mv "$DATA_BACKUP/lab" /opt/kuroneko/deploy/webchat/data-lab
  rm -rf "$DATA_BACKUP"
  echo "restored webchat data volumes"
fi
chown -R 1000:1000 /opt/kuroneko/deploy/webchat/data-main /opt/kuroneko/deploy/webchat/data-lab 2>/dev/null || true
cat > /opt/kuroneko/deploy/webchat/.env.main <<'ENVEOF'
{env_main}ENVEOF
cat > /opt/kuroneko/deploy/webchat/.env.lab <<'ENVEOF'
{env_lab}ENVEOF
chmod 600 /opt/kuroneko/deploy/webchat/.env.main /opt/kuroneko/deploy/webchat/.env.lab
{jwt_remote_block}
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

echo "=== chat-server startup (jwt mode) ==="
docker logs utlra-chat-server 2>&1 | tail -3 || true
docker logs utlra-chat-server-lab 2>&1 | tail -3 || true

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
    jwt_local = "jwt=local" in out
    healthy = "both chat-servers healthy" in out
    return 0 if healthy and (jwt_local or jwt_secret) else (0 if healthy else 1)


if __name__ == "__main__":
    raise SystemExit(main())
