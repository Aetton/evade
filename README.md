# EvaDE 🍎

**Eva Desktop Edition**. A fast desktop-first task tracker, with an independent data model and a planned bi-directional EvaTeam sync adapter.

> _Из Рая выгнали. Зато задачи открываются._

## What works now

- FastAPI backend: projects, tasks, sub-tasks, assignees, statuses, comments and per-user activity.
- A local PostgreSQL/SQLite database with independently generated UUIDs.
- Sync-ready `external_links` and transactional `sync_outbox` models.
- Tauri + React desktop UI: compact task list, quick search/create, detail panel, comments, activity, status and assignee edits.
- Individual API tokens (hashes stored in database).

**Not yet built:** EvaTeam adapter, synchronization workers, production-ready access controls, migrations, automated desktop packaging and unattended signed releases. Outbox entries are not delivered anywhere yet.

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

- No runtime dependency on EvaTeam in core task operations.
- No integration to Arachne or Forgejo.
- Author attribution is recorded locally for every create/update/comment.
- Future EvaTeam writes must use a user-to-Eva credential mapping, with explicit reconciliation.

## Connect your personal EvaTeam key

Generate a server-side Fernet encryption key once (do not commit it):

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Set `EVADE_CREDENTIAL_KEY` in the environment before starting FastAPI, or in Compose's environment. Keep this key backed up independently from the database: if lost, stored EvaTeam credentials cannot be recovered.

Open **Settings / EvaTeam** in the desktop sidebar and paste your own EvaTeam API key. It is encrypted at rest, associated with your authenticated EvaDE user, and never returned from the server. The setting is persisted and can be rotated or removed. Set `EVADE_EVA_URL=https://your-eva-host/api/` on the backend and use **Проверить подключение** to check the personal token with a read-only `CmfTask.list` query. This probes task-list permission, not every API permission. **No bidirectional sync happens yet.**

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
