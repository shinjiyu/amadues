#!/usr/bin/env bash
set -euo pipefail

echo '=== fix nginx default server ==='
if [ -f /etc/nginx/nginx.conf ]; then
  sed -i 's/listen       80 default_server;/listen       80;/' /etc/nginx/nginx.conf || true
  sed -i 's/listen       \[::\]:80 default_server;/listen       [::]:80;/' /etc/nginx/nginx.conf || true
fi

cat > /etc/nginx/conf.d/kuroneko.chat.conf <<'NGINXEOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name kuroneko.chat www.kuroneko.chat;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name kuroneko.chat www.kuroneko.chat;

    ssl_certificate     /etc/letsencrypt/live/kuroneko.chat/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kuroneko.chat/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    client_max_body_size 30m;

    location ^~ /api/auth/ {
        proxy_pass         http://127.0.0.1:5001/api/auth/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location = /auth-health {
        proxy_pass http://127.0.0.1:5001/health;
    }

    location ^~ /_nuxt/ {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location = /login {
        proxy_pass         http://127.0.0.1:3000/login;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location = /register {
        proxy_pass         http://127.0.0.1:3000/register;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # 根路径 → loginserver 首页（登录 / 注册入口）
    location = / {
        proxy_pass         http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location / {
        return 302 /login;
    }
}
NGINXEOF

nginx -t
systemctl reload nginx
echo 'nginx reloaded'

echo '=== docker compose build & up ==='
cd /opt/loginserver
docker compose -f docker-compose.prod.yml --env-file docker.env.prod up -d --build

echo '=== wait for backend health ==='
for i in $(seq 1 36); do
  if curl -sf http://127.0.0.1:5001/health >/dev/null 2>&1; then
    echo "backend healthy after ${i} checks"
    break
  fi
  echo "waiting backend... ($i/36)"
  sleep 10
done

curl -s http://127.0.0.1:5001/health || true
echo
curl -sI http://127.0.0.1:3000/login | head -5 || true
curl -sk https://127.0.0.1/auth-health -H 'Host: kuroneko.chat' || true
echo
docker compose -f docker-compose.prod.yml ps

echo '=== daily restart cron ==='
if [ -f /tmp/loginserver-daily-restart.sh ] && [ -f /tmp/install-loginserver-daily-restart.sh ]; then
  bash /tmp/install-loginserver-daily-restart.sh /tmp/loginserver-daily-restart.sh
elif [ -f /opt/kuroneko/deploy/ops/install-loginserver-daily-restart.sh ]; then
  bash /opt/kuroneko/deploy/ops/install-loginserver-daily-restart.sh
else
  echo 'WARN: daily-restart scripts not found; skip cron install'
fi
