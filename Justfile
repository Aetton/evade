# EvaDE deployment shortcuts. Run from the repository root.
set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# First run: create secrets, build containers, bootstrap admin.
run:
    @bash scripts/run.sh

# Rebuild and restart with current checkout.
restart:
    @docker compose up -d --build --wait

# Follow API and web logs.
logs:
    @docker compose logs -f --tail=100 api web

# Show service state.
status:
    @docker compose ps

# Print first-run admin token locally. Don't forward this output.
token:
    @test -f .secrets/admin-token || { echo "No first-run token file found"; exit 1; }
    @cat .secrets/admin-token

# Print stack URLs.
urls:
    @echo "Web: http://127.0.0.1:$$(sed -n 's/^EVADE_WEB_PORT=//p' .env | head -1)"
    @echo "API: http://127.0.0.1:8000/docs"

# Stop containers without deleting any data.
stop:
    @docker compose down

# Fetch, backup and safely update only fast-forward main.
update:
    @bash scripts/update.sh

# Enable an unattended daily check via host systemd user timer.
enable-updates:
    @bash scripts/enable-updates.sh

disable-updates:
    @systemctl --user disable --now evade-update.timer

# Native desktop client for local developers (Rust + Tauri prerequisites).
desktop:
    @cd desktop && npm install && npm run tauri dev

# Run backend unit tests inside the API container.
test:
    @docker compose exec -T api python -m pytest -q
