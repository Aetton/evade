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
        if method == "User.getCurrentUser":
            return {"id": "User:auth-a", "login": "evatester-a"}
        if method == "CmfPerson.list":
            return [{"id": "Person:own-1", "name": "Eva Tester A", "login": "evatester-a"}]
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
        identity = client.get("/eva/me", headers=auth_a)
        assert identity.status_code == 200, identity.text
        assert identity.json()["id"] == "Person:own-1"
        assert client.get("/eva/tasks", headers=auth_a).status_code == 422
        first = client.get("/eva/tasks?responsible=Person:own-1&project=project-id&limit=50", headers=auth_a)
        assert first.status_code == 200, first.text
        assert first.json()["items"][0]["code"] == "DEV-1"
        assert calls[-1][0] == "eva-key-a"
        assert calls[-1][1] == "CmfTask.list"
        assert calls[-1][2]["filter"] == [["responsible", "==", "Person:own-1"], ["project_id", "==", "project-id"]]
        assert calls[-1][2]["slice"] == [0, 50]

        assert client.get("/eva/tasks?responsible=Person:other-2", headers=auth_b).status_code == 200
        assert calls[-1][2]["filter"] == ["responsible", "==", "Person:other-2"]
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
        edited = client.patch("/eva/tasks/DEV-1", headers=auth_a, json={
            "name": "Updated", "text": "Detailed description",
            "status": "IN REVIEW", "responsible": "Person:other-2",
        })
        assert edited.status_code == 200, edited.text
        assert calls[-1][1] == "CmfTask.update"
        assert calls[-1][2] == {"name": "Updated", "text": "Detailed description",
                                 "status": "IN REVIEW", "responsible": "Person:other-2"}
        bad_assignee = client.patch("/eva/tasks/DEV-1", headers=auth_a,
                                    json={"responsible": "Just a Name"})
        assert bad_assignee.status_code == 422

        commented = client.post("/eva/tasks/DEV-1/comments", headers=auth_a,
                                json={"text": "<script>alert(1)</script>"})
        assert commented.status_code == 201
        assert calls[-1][1] == "CmfComment.create"
        assert calls[-1][2]["parent"] == "DEV-1"
        assert "&lt;script&gt;" in calls[-1][2]["text"]
        assert "<script>" not in calls[-1][2]["text"]
        assert client.get("/eva/tasks?responsible=Person:own-1&limit=101", headers=auth_a).status_code == 422
        assert client.get("/eva/tasks?responsible=bad", headers=auth_a).status_code == 422
        assert client.get("/eva/tasks/hello%20bad", headers=auth_a).status_code == 422


def test_current_user_rpc_unavailable_allows_manual_selection(monkeypatch):
    from app.eva_client import EvaError
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    def fake_call(key, method, *, kwargs=None, args=None):
        if method == "User.getCurrentUser":
            raise EvaError("RPC method unavailable", status=422)
        if method == "CmfPerson.list":
            return [{"id": "Person:one", "name": "Tester", "login": "tester"}]
        if method == "CmfTask.list":
            return []
        return []
    monkeypatch.setattr(eva_tasks, "eva_call", fake_call)
    with TestClient(app) as client:
        with SessionLocal() as db:
            u = User(name="Fallback Tester", token_hash=hashlib.sha256(b"eva-fallback-user").hexdigest())
            db.add(u)
            db.flush()
            store(db, u.id, "eva-token-fallback")
            db.commit()
        headers = {"Authorization": "Bearer eva-fallback-user"}
        result = client.get("/eva/me", headers=headers)
        assert result.status_code == 200
        assert result.json()["requires_selection"] is True
        assert result.json()["id"] is None
        directory = client.get("/eva/people", headers=headers)
        assert directory.status_code == 200
        assert directory.json()["items"][0]["id"] == "Person:one"
        tasks = client.get("/eva/tasks?responsible=Person:one", headers=headers)
        assert tasks.status_code == 200


def test_person_name_search_filters_upstream_before_pagination(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    calls = []

    def fake_call(key, method, *, kwargs=None, args=None):
        calls.append((method, kwargs))
        if method == "CmfPerson.list":
            return [{"id": "Person:someone", "name": "Иван Иванов", "login": "ivan"}]
        return []

    monkeypatch.setattr(eva_tasks, "eva_call", fake_call)
    with TestClient(app) as client:
        with SessionLocal() as db:
            user = User(name="Search Tester", token_hash=hashlib.sha256(b"eva-people-search").hexdigest())
            db.add(user)
            db.flush()
            store(db, user.id, "search-token")
            db.commit()
        headers = {"Authorization": "Bearer eva-people-search"}
        response = client.get("/eva/people?name=Иван&offset=10&limit=20", headers=headers)
        assert response.status_code == 200, response.text
        assert calls[-1][0] == "CmfPerson.list"
        assert calls[-1][1]["filter"] == ["name", "LIKE", "%Иван%"]
        assert calls[-1][1]["slice"] == [10, 30]
        account = client.get("/eva/people?name=kirill.nechaev", headers=headers)
        assert account.status_code == 200
        assert calls[-1][1]["filter"] == ["login", "==", "kirill.nechaev"]
        response = client.get("/eva/people?offset=0", headers=headers)
        assert response.status_code == 200
        assert "filter" not in calls[-1][1]
        for invalid in ("%", "_", "a"):
            response = client.get("/eva/people", headers=headers, params={"name": invalid})
            assert response.status_code == 422


def test_remote_task_cache_is_scoped_idempotent_and_never_writes_legacy_tasks(monkeypatch):
    from app.models import EvaTaskCache, Task, SyncOutbox
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    calls = []
    def upstream(token, method, *, kwargs=None, args=None):
        calls.append((token, method, kwargs))
        if method == "CmfTask.list":
            start, end = kwargs["slice"]
            if start:
                return []
            return [{"id":"CmfTask:abc-123", "code":"DEV-123", "name":"From EvaTeam",
                     "status":{"code":"TO DO","name":"TO DO"}, "cache_status_type":"OPEN"}]
        return []
    monkeypatch.setattr(eva_tasks, "eva_call", upstream)
    with TestClient(app) as client:
        with SessionLocal() as db:
            identities = []
            for local_name, key in (("Sync User 1", "sync-key-1"), ("Sync User 2", "sync-key-2")):
                bearer = "local-" + key
                row = User(name=local_name, token_hash=hashlib.sha256(bearer.encode()).hexdigest())
                db.add(row)
                db.flush()
                store(db, row.id, key)
                identities.append((row.id, bearer))
            db.commit()
        for user_id, bearer in identities:
            headers = {"Authorization":"Bearer " + bearer}
            for _ in range(2):
                response = client.get("/eva/tasks?responsible=Person:test-1", headers=headers)
                assert response.status_code == 200, response.text
                assert response.json()["items"][0]["code"] == "DEV-123"
            sync = client.post("/eva/sync", headers=headers, json={"responsible":["Person:test-1"]})
            assert sync.status_code == 200, sync.text
            assert sync.json()["synced"] == 1
            status = client.get("/eva/sync/status", headers=headers)
            assert status.status_code == 200
            assert status.json()["cached"] == 1
        with SessionLocal() as db:
            for user_id, _ in identities:
                cache = db.scalars(select(EvaTaskCache).where(EvaTaskCache.user_id == user_id)).all()
                assert len(cache) == 1
                assert cache[0].remote_id == "CmfTask:abc-123"
            assert db.scalar(select(Task).where(Task.title == "From EvaTeam")) is None
        headers = {"Authorization":"Bearer " + identities[0][1]}
        assert client.post("/eva/sync",headers=headers,json={"responsible":["anything"]}).status_code == 422
        cached = client.get("/eva/tasks/cached?responsible=Person:test-1", headers=headers)
        assert cached.status_code == 200
        assert cached.json()["cached"] is True
        assert cached.json()["items"][0]["name"] == "From EvaTeam"


def test_eva_project_hierarchy_and_task_section_metadata(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    calls = []
    def fake_call(token, method, *, kwargs=None, args=None):
        calls.append((method, kwargs))
        if method == "CmfProject.list":
            return [{"id": "CmfProject:sub", "code": "SUB",
                     "name": "Nested section", "parent_id": "CmfProject:root"}]
        if method == "CmfTask.list":
            return [{"id": "CmfTask:task", "code": "SUB-1", "name": "Nested item",
                     "project_id": "CmfProject:sub",
                     "lists": [{"id": "CmfList:sprint", "name": "Sprint 7"}],
                     "parent_task_id": "CmfTask:parent"}]
        return []

    monkeypatch.setattr(eva_tasks, "eva_call", fake_call)
    with TestClient(app) as client:
        with SessionLocal() as db:
            user = User(name="Hierarchy tester",
                        token_hash=hashlib.sha256(b"hierarchy-tester").hexdigest())
            db.add(user)
            db.flush()
            store(db, user.id, "hierarchy-key")
            db.commit()
        headers = {"Authorization": "Bearer hierarchy-tester"}
        projects = client.get("/eva/projects?offset=0&limit=100", headers=headers)
        assert projects.status_code == 200, projects.text
        assert projects.json()["items"][0]["parent_id"] == "CmfProject:root"
        assert "parent_id" in calls[-1][1]["fields"]
        assert calls[-1][1]["slice"] == [0, 100]
        tasks = client.get("/eva/tasks?responsible=Person:tester", headers=headers)
        assert tasks.status_code == 200, tasks.text
        assert "lists" in calls[-1][1]["fields"]
        assert "parent_task_id" in calls[-1][1]["fields"]
        assert "project_id" in calls[-1][1]["fields"]
        assert tasks.json()["items"][0]["lists"][0]["name"] == "Sprint 7"
