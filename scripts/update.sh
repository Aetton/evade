#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>.secrets/update.lock
flock -n 9 || { echo "[=] Another update is running"; exit 0; }
[[ -f .env ]] || { echo "Run 'just run' first" >&2; exit 1; }
branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || { echo "[!] Autoupdate requires main branch" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "[!] Working tree modified; refusing auto-update" >&2; exit 1; }
old="$(git rev-parse HEAD)"
git fetch --quiet origin main
new="$(git rev-parse origin/main)"
[[ "$old" != "$new" ]] || { echo "[=] Already up to date"; exit 0; }
git merge-base --is-ancestor "$old" "$new" || { echo "[!] main diverged; no update" >&2; exit 1; }

# Database backup before deployment; never automatically restore DB on code failure.
mkdir -p .backups
backup=".backups/evade-$(date -u +%Y%m%dT%H%M%SZ).sql"
docker compose exec -T db pg_dump -U evade -d evade > "$backup"
chmod 600 "$backup"
echo "[+] Database backup saved: $backup"

git merge --ff-only origin/main
if ! bash scripts/run.sh; then
  echo "[!] Update failed. Restoring previous code and rebuilding containers." >&2
  git reset --hard "$old"
  bash scripts/run.sh || true
  echo "[!] Database was NOT automatically reverted: backup is $backup" >&2
  exit 1
fi
echo "[+] Updated to $(git rev-parse --short HEAD)"
