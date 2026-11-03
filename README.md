# EvaDE 🍎

**Eva Desktop Edition**. A unified desktop-first EvaTeam task workspace with per-user read-through cache and remote write-through operations.

> _Из Рая выгнали. Зато задачи открываются._

## What works now

- FastAPI backend: projects, tasks, sub-tasks, assignees, statuses, comments and per-user activity.
- A local PostgreSQL/SQLite database with independently generated UUIDs.
- Sync-ready `external_links` and transactional `sync_outbox` models.
- Tauri + React desktop UI: compact task list, quick search/create, detail panel, comments, activity, status and assignee edits.
- Individual API tokens (hashes stored in database).

**Still pending:** reconciliation/migration of pre-existing local-only tasks and their `sync_outbox`, production-ready task-level access controls, schema migrations, and unattended signed desktop releases. Do not treat old local outbox items as already synchronized.

## Run the backend locally

Requires Python 3.11+.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e '.[test]'
python create_user.py "Your Name" --admin
uvicorn app.main:app --reload --port 8000
```

Copy the printed personal token. Database is `backend/evade.db` in this development mode.

API docs: http://127.0.0.1:8000/docs

Run API tests:

```bash
cd backend
pytest -q
```

## Run the desktop

Requires Node.js 20+, npm, Rust, and the OS dependencies for Tauri 2.

```bash
cd desktop
npm install
npm run tauri dev
```

Enter `http://127.0.0.1:8000` and your personal token in the login screen.

For browser-only UI development (same React application):

```bash
cd desktop
npm run dev
```

## Server with PostgreSQL

```bash
export POSTGRES_PASSWORD='replace-this'
docker compose up -d --build
docker compose exec api python create_user.py "Your Name" --admin
```

The API binds to localhost:8000 on the host. Put it behind TLS and configure CORS + the Tauri CSP before making it remotely accessible.

## Architecture

See [docs/architecture.md](docs/architecture.md).

- The unified task workspace reads and writes through EvaTeam. An isolated, per-user local snapshot supports a limited offline task list.
- No integration to Arachne or Forgejo.
- Author attribution is recorded locally for every create/update/comment.
- Every EvaTeam write uses the authenticated user's encrypted EvaTeam credential. Legacy local data requires explicit reconciliation before migration.

## Connect your personal EvaTeam key

Generate a server-side Fernet encryption key once (do not commit it):

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Set `EVADE_CREDENTIAL_KEY` in the environment before starting FastAPI, or in Compose's environment. Keep this key backed up independently from the database: if lost, stored EvaTeam credentials cannot be recovered.

Open **Settings / EvaTeam** in the desktop sidebar and paste your own EvaTeam API key. It is encrypted at rest, associated with your authenticated EvaDE user, and never returned from the server. The setting is persisted and can be rotated or removed. Set `EVADE_EVA_URL=https://your-eva-host/api/` on the backend and use **Проверить подключение** to check the personal token with a read-only `CmfTask.list` query. This probes task-list permission, not every API permission. The unified task interface now writes through to EvaTeam and maintains a local cache. Historical local-only tasks still require explicit reconciliation.

For release setup and update limitations see [docs/updates.md](docs/updates.md).

## EvaTeam JSON-RPC transport

The configured server endpoint is HTTPS only. The bridge sends JSON-RPC `2.2` to `/api/` with a per-user `Authorization: Bearer <token>` header. Both HTTP errors and RPC `error`/`abort` payloads are failures. TLS verification stays enabled. See `backend/app/eva_client.py`.

## One-command deployment (Docker + Just)

Requires `git`, `docker` with Compose v2, and `just`. Docker daemon access must be configured for your user.

```bash
git clone https://github.com/Aetton/evade.git
cd evade
just run
just token
```

The first run creates a private `.env` (database password and encryption key), starts PostgreSQL, FastAPI and an Nginx-hosted browser UI, and creates a first **EvaDE** admin account. Its API token is saved only in `.secrets/admin-token` (0600). Paste that token into the EvaDE login screen. These are **not** EvaTeam credentials: each user adds their own EvaTeam token via Settings.

- Browser UI (loopback only): http://127.0.0.1:8080
- API docs: http://127.0.0.1:8000/docs
- `just logs`, `just status`, `just stop`, `just restart`
- Set your corporate `EVADE_EVA_URL=https://your-domain/api/` in `.env`, then `just restart` for EvaTeam connection probes.
- Use `just desktop` for the native Tauri development client (requires Rust/Tauri system packages on the host).

**The web and API ports bind to localhost by design.** For remote teammates deploy HTTPS reverse proxy, access controls, and a trusted hostname. Do not directly expose this early-stage backend to untrusted users; task-level authorization is not implemented yet.

### Backend auto-updates

`just enable-updates` registers a daily host-level `systemd --user` timer. The updater checks fast-forward changes on `main`, refuses a dirty tree, takes a PostgreSQL dump to `.backups/`, builds and restarts Compose services, and rolls back source + images if startup fails. It never automatically restores the database (schema migrations require manual care). Inspect logs with `journalctl --user -u evade-update.service` and disable via `just disable-updates`.

**No Docker socket is mounted into an updater container.** This timer updates the **server stack** only, not the signed native desktop app, which uses a different release/updater channel.

The initial run deliberately does not enable unattended updates automatically. Opt in with `just enable-updates` after verifying your deployment.

### Network and EvaTeam configuration

Set in the generated `.env`:

```dotenv
EVADE_BIND_ADDRESS=0.0.0.0
EVADE_WEB_PORT=8080
EVADE_EVA_URL=https://eva.example.internal/api/
```

`EVADE_BIND_ADDRESS` configures the **web** listener; API port 8000 remains localhost-only. Change to `0.0.0.0` only behind a trusted network or reverse proxy with HTTPS. `EVADE_EVA_URL` is the single server-side upstream address, while each user retains an individual EvaTeam Bearer token. New installs default to `127.0.0.1`; existing `.env` is left untouched and needs the variables added manually. Apply using `just restart`.

### Corporate CA without shell access

Login as the EvaDE administrator, open **Настройки → Администратор · CA EvaTeam**, select a public PEM-encoded CA certificate (or PEM bundle), and click **Установить CA**. The API validates CA BasicConstraints, expiry, and parses the certificate bundle before atomically saving it to the persistent `evade-certs` Docker volume. It applies to new outgoing EvaTeam TLS connections immediately, without restarting the server or disabling normal system trust verification. The page is admin-only, and the backend checks `User.is_admin` on every CA operation. Existing per-user EvaTeam keys are not changed. The uploaded CA is a trust anchor, so only upload CA certificates from your organization.

### Persistent browser login

The web UI creates a signed 30-day HttpOnly, SameSite=Lax cookie after validating a user's personal EvaDE bearer token. Refreshing the browser reuses the cookie; logout clears it. The cookie contains **no bearer token** and is bound to the current user's token hash, so token rotation invalidates it. Desktop/Tauri continues to use in-memory bearer authentication, and API clients can continue to use Authorization headers. Cookie-authenticated writes require a matching same-origin Origin header. To deploy behind HTTPS set `EVADE_COOKIE_SECURE=true` in the API environment and restart the API; plain HTTP must not be used on untrusted networks.

### Pin EvaTeam server certificate (when InternalCA is unavailable)

In **Настройки → Администратор · Сертификат сервера EvaTeam**, upload the PEM leaf certificate exported from the browser, inspect and confirm its SHA-256 fingerprint against a trusted source, and select **Проверить и закрепить**. This mode uses exact leaf SHA-256 certificate matching for the configured HTTPS host, including hostname SAN and expiry checks. The fingerprint is enforced on the **actual TLS connection before sending bearer credentials** via urllib3 `assert_fingerprint`, not by disabling verification and preflighting a different connection. On certificate renewal the pin must be updated. The pin is saved in `evade-certs` volume and is admin-only. A properly signed CA is still preferable for standard rotation handling.

### Live EvaTeam task workspace

Select **EvaTeam · Задачи** in the sidebar. After connecting your personal EvaTeam token, EvaDE lists up to 50 visible tasks at a time, permits project filtering, card browsing, creating tasks, editing title, description, status code, priority and responsible user, and posting comments. The UI sends documented CmfTask.list/get/create/update and CmfComment.create JSON-RPC 2.2 operations through the server using **the current user's own token**, so remote rights remain enforced by EvaTeam. Page search is local to the currently fetched page; it is not a global EvaTeam full-text search. Project workflow status values vary: enter a valid status code accepted by EvaTeam, rather than assuming EvaDE's four local statuses apply. Task lists now populate an isolated per-user `eva_task_cache` table and can be refreshed with `/eva/sync`. Edits and comments are written to EvaTeam under the user's token. Previous locally created tasks are not automatically imported, and old outbox events are not sent to EvaTeam.


### Unified workspace and synchronization boundaries

EvaDE shows **one task workspace**, not separate EvaTeam and local task pages. EvaTeam remains authoritative for task records. The UI fetches remote lists, stores idempotent per-user snapshots in `eva_task_cache`, refreshes the current person's selection automatically every three minutes (and the current list every minute), and can refresh all followed people on demand with **Синхронизировать**. Edits, creation and comments go directly to EvaTeam using the caller's own credential; the refreshed remote list then updates the cache. If a list request fails, the last cached list can be shown explicitly as *read-only / possibly stale* with no pending write queue or false success. Sync is bounded at 2000 tasks per person and reports when that limit was reached.

**Important:** This is **not yet a completed migration of pre-existing local tasks**. The old `tasks`, `external_links` and `sync_outbox` records have not been reconciled with EvaTeam, and pushing them blindly may create duplicates or overwrite other people's changes. `GET /eva/sync/status` reports this gap; the UI shows a warning if existing local data is waiting for migration. Do not declare total bi-directional migration complete until unique remote IDs, conflict resolution, deletion semantics, and an auditable migration have been tested against the real EvaTeam instance. No automatic remote deletion is performed.
