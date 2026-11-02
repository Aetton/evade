# EvaDE architecture

## Purpose
EvaDE is an independent task tracker, with a native desktop shell and its own database. EvaTeam is an external synchronization provider, never the live backend of the UI.

## Components
- `desktop/`: Tauri 2 + React. Compact lists, side-panel details, comments, status, assignee, quick entry.
- `backend/`: FastAPI + SQLAlchemy. User-scoped API tokens, tasks, projects, comments, immutable activity, sync outbox.
- PostgreSQL in deployment; SQLite for quick development.

## Data ownership
Local UUIDs are authoritative; external IDs are kept in `external_links`. The local core never reuses EvaTeam IDs as primary keys. Provider-specific fields belong in the connector or an extension table.

## Synchronization design (not yet implemented)
- On local mutations: write data, activity and outbox in one transaction.
- Outbound worker must use the *actor's* EvaTeam credential, never accidentally attribute the action to a service account.
- Inbound reconciliation must retain the last externally observed snapshot, detect conflicts and avoid loops.
- Outbox retries require idempotency and deliberate conflict handling. Comments are especially dangerous to retry without external deduplication.
- If the EvaTeam API cannot expose changed-since filtering or reliable authorship, the connector must explicitly document its limitations.

## MVP security and known limitations
- API personal tokens are SHA-256 hashed at rest; created with `backend/create_user.py`. No shared default admin secret.
- Server must be behind HTTPS in production; token provisioning/rotation UI and scoped permissions are future work.
- All authenticated users currently have access to all projects and tasks. **Do not expose to untrusted multi-tenant users.**
- No EvaTeam connector or key vault yet; outbox records are *pending*, not delivered.
- Backend schema currently uses `create_all` for development; add Alembic migrations before production.
- Client token is kept in memory only. Restart requires logging in again. Never persist an Eva key in localStorage.
- Desktop CSP currently allows only local API; configure `connect-src` and TLS appropriately for a remote API.
- Views currently load at most 500 tasks; server pagination and list virtualization come before large-team rollout.
