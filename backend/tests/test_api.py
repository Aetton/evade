import hashlib
import os
import tempfile
from pathlib import Path

# Unique DB must be set before importing the application.
_db = Path(tempfile.mkdtemp()) / "test.sqlite3"
os.environ["DATABASE_URL"] = f"sqlite:///{_db}"
from fastapi.testclient import TestClient
from app.database import SessionLocal
from app.main import app
from app.models import User

def test_task_comments_and_activity():
    with TestClient(app) as client:
        assert client.get("/tasks").status_code == 401
        with SessionLocal() as db:
            db.add(User(name="Tester", token_hash=hashlib.sha256(b"test-secret").hexdigest()))
            db.commit()
        headers = {"Authorization": "Bearer test-secret"}
        user = client.get("/me", headers=headers).json()
        project = client.post("/projects", headers=headers, json={"name": "Infrastructure"})
        assert project.status_code == 201
        task = client.post("/tasks", headers=headers, json={"title": "Fix DNS", "project_id": project.json()["id"]})
        assert task.status_code == 201
        task_id = task.json()["id"]
        child = client.post("/tasks", headers=headers, json={"title": "Check runner", "parent_id": task_id})
        assert child.status_code == 201
        assert client.patch(f"/tasks/{task_id}", headers=headers, json={"status": "in_progress"}).status_code == 200
        assert client.patch(f"/tasks/{task_id}", headers=headers, json={"parent_id": child.json()["id"]}).status_code == 422
        comment = client.post(f"/tasks/{task_id}/comments", headers=headers, json={"body": "Investigating"})
        assert comment.status_code == 201
        assert comment.json()["author_id"] == user["id"]
        assert len(client.get(f"/tasks/{task_id}/activity", headers=headers).json()) == 3
        assert len(client.get(f"/tasks/{task_id}/comments", headers=headers).json()) == 1

def test_persistent_web_session_and_admin_permissions(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", "test-only-long-random-signing-key")
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(name="Cookie Admin", is_admin=True,
                        token_hash=hashlib.sha256(b"cookie-admin-token").hexdigest()))
            db.commit()
        auth = {"Authorization": "Bearer cookie-admin-token"}
        response = client.post("/auth/session", headers=auth)
        assert response.status_code == 200
        cookie_header = response.headers["set-cookie"]
        assert "httponly" in cookie_header.lower()
        assert "samesite=lax" in cookie_header.lower()
        assert "cookie-admin-token" not in cookie_header
        assert client.get("/me").json()["is_admin"] is True
        assert client.get("/admin/eva/ca").status_code == 200
        assert client.post("/projects", json={"name": "Wrong Origin"}, headers={"Origin": "https://attacker.test"}).status_code == 403
        assert client.post("/projects", json={"name": "Cookie Authorized"}, headers={"Origin": "http://testserver"}).status_code == 201
        assert client.delete("/auth/session").status_code == 204
        assert client.get("/me").status_code == 401


def test_web_session_tampering_and_token_revocation(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", "test-only-long-random-signing-key")
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(name="Cookie User", token_hash=hashlib.sha256(b"cookie-user-token").hexdigest()))
            db.commit()
        response = client.post("/auth/session", headers={"Authorization": "Bearer cookie-user-token"})
        assert response.status_code == 200
        original_cookie = client.cookies.get("evade_session")
        assert original_cookie
        client.cookies.set("evade_session", original_cookie[:-1] + ("0" if original_cookie[-1] != "0" else "1"))
        assert client.get("/me").status_code == 401
        client.cookies.set("evade_session", original_cookie)
        assert client.get("/me").status_code == 200
        with SessionLocal() as db:
            user = db.scalar(__import__("sqlalchemy").select(User).where(User.name == "Cookie User"))
            user.token_hash = hashlib.sha256(b"new-user-token").hexdigest()
            db.commit()
        assert client.get("/me").status_code == 401
