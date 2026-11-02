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

Open **Settings / EvaTeam** in the desktop sidebar and paste your own EvaTeam API key. It is encrypted at rest, associated with your authenticated EvaDE user, and never returned from the server. The setting is persisted and can be rotated or removed. **The credentials are not verified against EvaTeam yet and no sync happens until the EvaTeam adapter is implemented.**

For release setup and update limitations see [docs/updates.md](docs/updates.md).
