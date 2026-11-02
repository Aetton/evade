#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/init.sh
export EVADE_BUILD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo local)"
docker compose up -d --build --wait
umask 077
if [[ ! -f .secrets/admin-token ]]; then
  output="$(docker compose exec -T api python bootstrap_admin.py)"
  if [[ "$output" == CREATED_ADMIN_TOKEN=* ]]; then
    printf '%s\n' "${output#CREATED_ADMIN_TOKEN=}" > .secrets/admin-token
    chmod 600 .secrets/admin-token
    echo "[+] Initial admin created; token stored in .secrets/admin-token (mode 0600)."
  elif [[ "$output" == "EXISTING_ADMIN" ]]; then
    echo "[=] Admin already exists; its token cannot be retrieved. Existing credentials unchanged."
  else
    echo "[!] Unexpected bootstrap response: ${output}" >&2
    exit 1
  fi
fi
echo
echo "[+] EvaDE is running at http://127.0.0.1:$(sed -n 's/^EVADE_WEB_PORT=//p' .env | head -1)"
echo "[+] API: http://127.0.0.1:8000/docs"
echo "[+] Admin token: just token  (never paste it into shared logs)"
echo "[=] For server auto-updates: just enable-updates"
