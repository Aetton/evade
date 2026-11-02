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
