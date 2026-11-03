import hashlib
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import reconciliation
from app.credentials import store
from app.database import SessionLocal
from app.main import app
from app.models import User, Task, SyncOutbox, EvaTaskCache, ExternalLink


def test_reconciliation_preview_inspect_and_link_guards(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    remote = {"id": "abc-123", "code": "DEV-42", "name": "Existing remote task",
              "text": "Remote content", "status": {"code": "IN PROGRESS"},
              "priority": 3, "cmf_modified_at": "2026-11-03T10:00:00Z"}
    calls = []
    def fake_call(token, method, *, kwargs=None, args=None):
        calls.append((token, method, kwargs))
        assert method == "CmfTask.get", "Reconciliation must never write to EvaTeam"
        assert token == "eva-owner-key"
        return remote.copy()
    monkeypatch.setattr(reconciliation, "eva_call", fake_call)

    with TestClient(app) as client:
        with SessionLocal() as db:
            owner = User(name="Migration owner", token_hash=hashlib.sha256(b"migration-owner").hexdigest())
            outsider = User(name="Migration outsider", token_hash=hashlib.sha256(b"migration-outsider").hexdigest())
            db.add_all([owner, outsider])
            db.flush()
            store(db, owner.id, "eva-owner-key")
            task = Task(title="Local legacy task", description="Local body",
                        status="new", priority=1, created_by=owner.id)
            db.add(task)
            db.flush()
            outbox = SyncOutbox(entity_type="task", entity_id=task.id,
                                actor_id=owner.id, operation="create",
                                payload={"title": task.title}, state="pending")
            db.add(outbox)
            db.add(EvaTaskCache(user_id=owner.id, remote_id="CmfTask:abc-123",
                                responsible_id="Person:owner", snapshot={
                                    "id":"CmfTask:abc-123", "code":"DEV-42", "name":"Local legacy task"}))
            db.commit()
            task_id = task.id
            outbox_id = outbox.id

        owner_auth = {"Authorization": "Bearer migration-owner"}
        outsider_auth = {"Authorization": "Bearer migration-outsider"}
        assert client.get("/eva/reconcile/preview").status_code == 401
        other = client.get("/eva/reconcile/preview", headers=outsider_auth)
        assert other.status_code == 200
        assert all(t["local_id"] != task_id for t in other.json()["items"])
        assert client.post(f"/eva/reconcile/{task_id}/inspect", headers=outsider_auth,
                           json={"remote_code": "DEV-42", "expected_digest": "0"*64}).status_code == 404

        preview = client.get("/eva/reconcile/preview", headers=owner_auth)
        assert preview.status_code == 200, preview.text
        item = next(t for t in preview.json()["items"] if t["local_id"] == task_id)
        assert item["pending_operations"] == 1
        assert item["candidates"][0]["code"] == "DEV-42"
        assert preview.json()["remote_search_complete"] is False
        digest = item["digest"]

        check = client.post(f"/eva/reconcile/{task_id}/inspect", headers=owner_auth,
                            json={"remote_code": "DEV-42", "expected_digest": digest})
        assert check.status_code == 200, check.text
        remote_digest = check.json()["remote_digest"]
        assert "title" in check.json()["differences"]
        assert "description" in check.json()["differences"]

        payload = {"remote_code": "DEV-42", "expected_digest": digest,
                   "expected_remote_digest": remote_digest}
        assert client.post(f"/eva/reconcile/{task_id}/link", headers=owner_auth, json=payload).status_code == 409
        assert client.post(f"/eva/reconcile/{task_id}/link", headers=owner_auth,
                           json={**payload, "expected_digest": "0"*64, "confirm_differences": True}).status_code == 409
        remote["text"] = "changed remotely"
        assert client.post(f"/eva/reconcile/{task_id}/link", headers=owner_auth,
                           json={**payload, "confirm_differences": True}).status_code == 409
        remote["text"] = "Remote content"

        linked = client.post(f"/eva/reconcile/{task_id}/link", headers=owner_auth,
                             json={**payload, "confirm_differences": True})
        assert linked.status_code == 200, linked.text
        assert linked.json()["linked"] is True
        assert linked.json()["pending_outbox_preserved"] is True
        repeated = client.post(f"/eva/reconcile/{task_id}/link", headers=owner_auth,
                               json={**payload, "confirm_differences": True})
        assert repeated.status_code == 200
        assert repeated.json()["idempotent"] is True

        with SessionLocal() as db:
            rows = list(db.scalars(select(ExternalLink).where(ExternalLink.local_id == task_id)))
            assert len(rows) == 1
            assert rows[0].external_id == "CmfTask:abc-123"
            assert db.get(SyncOutbox, outbox_id).state == "pending"
            assert db.get(Task, task_id).title == "Local legacy task"
        assert all(method == "CmfTask.get" for _, method, _ in calls)


def test_reconciliation_rejects_reuse_of_remote_task(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(reconciliation, "eva_call", lambda *args, **kwargs: {
        "id": "existing", "code": "ANOTHER-1", "name": "Remote", "text": "x"})
    with TestClient(app) as client:
        with SessionLocal() as db:
            user = User(name="Migration reuse", token_hash=hashlib.sha256(b"migration-reuse").hexdigest())
            db.add(user); db.flush()
            store(db, user.id, "reuse-token")
            first = Task(title="One", created_by=user.id)
            second = Task(title="Two", created_by=user.id)
            db.add_all([first,second]); db.flush()
            first_id, second_id = first.id, second.id
            db.commit()
        auth = {"Authorization":"Bearer migration-reuse"}
        previews = client.get("/eva/reconcile/preview",headers=auth).json()["items"]
        d = {r["local_id"]:r["digest"] for r in previews}
        def link(task_id):
            inspected = client.post(f"/eva/reconcile/{task_id}/inspect", headers=auth,
                json={"remote_code":"ANOTHER-1","expected_digest":d[task_id]}).json()
            return client.post(f"/eva/reconcile/{task_id}/link",headers=auth,json={
                "remote_code":"ANOTHER-1","expected_digest":d[task_id],
                "expected_remote_digest":inspected["remote_digest"],"confirm_differences":True})
        assert link(first_id).status_code == 200
        assert link(second_id).status_code == 409
