import hashlib
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import eva_tasks
from app.credentials import store
from app.database import SessionLocal
from app.main import app
from app.models import User


def test_eva_tasks_are_user_scoped_and_mutations_use_documented_methods(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    calls = []

    def fake_call(key, method, *, kwargs=None, args=None):
        calls.append((key, method, kwargs, args))
        if method == "CmfTask.list":
            return [{"code": "DEV-1", "name": "Task", "id": "abc", "parent_id": "project-id"}]
        if method == "CmfTask.get":
            return {"code": "DEV-1", "name": "Task", "id": "abc", "text": ""}
        if method in ("CmfProject.list", "CmfPerson.list"):
            return []
        return {"ok": True}

    monkeypatch.setattr(eva_tasks, "eva_call", fake_call)

    with TestClient(app) as client:
        with SessionLocal() as db:
            for name, login, token in [("Eva Tester A", "evatester-a", "eva-key-a"),
                                       ("Eva Tester B", "evatester-b", "eva-key-b")]:
                u = User(name=name, token_hash=hashlib.sha256(login.encode()).hexdigest())
                db.add(u)
                db.flush()
                store(db, u.id, token)
            db.commit()
        auth_a = {"Authorization": "Bearer evatester-a"}
        auth_b = {"Authorization": "Bearer evatester-b"}

        assert client.get("/eva/tasks").status_code == 401
        first = client.get("/eva/tasks?project=project-id&limit=50", headers=auth_a)
        assert first.status_code == 200, first.text
        assert first.json()["items"][0]["code"] == "DEV-1"
        assert calls[-1][0] == "eva-key-a"
        assert calls[-1][1] == "CmfTask.list"
        assert calls[-1][2]["filter"] == ["parent_id", "==", "project-id"]
        assert calls[-1][2]["slice"] == [0, 50]

        assert client.get("/eva/tasks", headers=auth_b).status_code == 200
        assert calls[-1][0] == "eva-key-b"
        assert client.get("/eva/tasks/DEV-1", headers=auth_a).status_code == 200
        assert calls[-1][1] == "CmfTask.get"
        assert client.post("/eva/tasks", headers=auth_a,
                           json={"name": "New Task", "project": "DEV", "text": "Body"}).status_code == 201
        assert calls[-1][1] == "CmfTask.create"
        assert calls[-1][2]["parent"] == "DEV"
        updated = client.patch("/eva/tasks/DEV-1", headers=auth_a, json={"status": "closed"})
        assert updated.status_code == 200, updated.text
        assert calls[-1][1] == "CmfTask.update"
        assert calls[-1][3] == ["CmfTask:abc"]
        assert calls[-1][2] == {"status": "closed"}
        commented = client.post("/eva/tasks/DEV-1/comments", headers=auth_a,
                                json={"text": "<script>alert(1)</script>"})
        assert commented.status_code == 201
        assert calls[-1][1] == "CmfComment.create"
        assert calls[-1][2]["parent"] == "DEV-1"
        assert "&lt;script&gt;" in calls[-1][2]["text"]
        assert "<script>" not in calls[-1][2]["text"]
        assert client.get("/eva/tasks?limit=101", headers=auth_a).status_code == 422
        assert client.get("/eva/tasks/hello%20bad", headers=auth_a).status_code == 422
