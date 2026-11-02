#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required" >&2; exit 1; }
mkdir -p .secrets .backups

if [[ ! -f .env ]]; then
  # No shell interpretation of secrets. Alphabet avoids Compose interpolation metacharacters.
  password="$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)"
  key="$(docker run --rm python:3.12-slim python -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
  cat > .env <<EOF
POSTGRES_PASSWORD=${password}
EVADE_CREDENTIAL_KEY=${key}
EVADE_EVA_URL=
EVADE_WEB_PORT=8080
EOF
  chmod 600 .env
  echo "[+] Created .env with persistent random database and encryption keys."
else
  echo "[=] Using existing .env (credentials preserved)."
fi
