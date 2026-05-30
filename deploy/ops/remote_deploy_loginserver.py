#!/usr/bin/env python3
"""Upload loginserver tarball + env + bootstrap script to kuroneko server."""
from __future__ import annotations

import argparse
import os
import secrets
import sys

import paramiko


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="43.156.244.45")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password", required=True)
    parser.add_argument("--tarball", required=True)
    parser.add_argument("--bootstrap-sh", required=True)
    args = parser.parse_args()

    secret_key = secrets.token_hex(32)
    jwt_key = secrets.token_hex(32)
    mongo_pass = secrets.token_urlsafe(24)
    env_content = (
        "FLASK_ENV=production\n"
        f"SECRET_KEY={secret_key}\n"
        f"JWT_SECRET_KEY={jwt_key}\n"
        "MONGO_USERNAME=admin\n"
        f"MONGO_PASSWORD={mongo_pass}\n"
        "MONGODB_DB_NAME=auth_system\n"
        "TZ=Asia/Shanghai\n"
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
    print("uploading tarball...")
    sftp.put(args.tarball, "/tmp/loginserver.tgz")
    print("uploading bootstrap script...")
    sftp.put(args.bootstrap_sh, "/tmp/bootstrap-loginserver.sh")
    sftp.close()

    setup = f"""set -euo pipefail
rm -rf /opt/loginserver
mkdir -p /opt/loginserver
tar -xzf /tmp/loginserver.tgz -C /opt/loginserver
cat > /opt/loginserver/docker.env.prod <<'ENVEOF'
{env_content}ENVEOF
chmod 600 /opt/loginserver/docker.env.prod
bash /tmp/bootstrap-loginserver.sh
"""
    stdin, stdout, stderr = client.exec_command("bash -s", timeout=900)
    stdin.write(setup)
    stdin.channel.shutdown_write()
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    print(out)
    if err.strip():
        print("STDERR:", err, file=sys.stderr)

    secrets_path = os.path.join(os.environ.get("TEMP", "/tmp"), "kuroneko-loginserver-secrets.txt")
    with open(secrets_path, "w", encoding="utf-8") as f:
        f.write(f"Server: {args.host}\n")
        f.write("Path: /opt/loginserver/docker.env.prod\n\n")
        f.write(env_content)
    print(f"Secrets saved to {secrets_path}")

    client.close()
    return 0 if "backend healthy" in out or '"status":"healthy"' in out else 1


if __name__ == "__main__":
    raise SystemExit(main())
