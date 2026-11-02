import hashlib
import os
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select
from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import EvaCredential, User
from app.credentials import retrieve

def test_each_user_has_private_eva_key(monkeypatch):
    monkeypatch.setenv("EVADE_CREDENTIAL_KEY", Fernet.generate_key().decode())
    with TestClient(app) as client:
        with SessionLocal() as db:
            one = User(name="Eva Alice", token_hash=hashlib.sha256(b"alice-secret").hexdigest())
            two = User(name="Eva Bob", token_hash=hashlib.sha256(b"bob-secret").hexdigest())
            db.add_all([one, two]); db.commit()
            alice_id, bob_id = one.id, two.id
        a = {"Authorization": "Bearer alice-secret"}
        b = {"Authorization": "Bearer bob-secret"}
        assert client.get("/integrations/eva", headers=a).json()["connected"] is False
        assert client.put("/integrations/eva", headers=a, json={"token": "alice-evateam-secret"}).status_code == 200
        assert client.put("/integrations/eva", headers=b, json={"token": "bob-evateam-secret"}).status_code == 200
        assert "alice-evateam-secret" not in str(client.get("/integrations/eva", headers=a).json())
        with SessionLocal() as db:
            assert retrieve(db, alice_id) == "alice-evateam-secret"
            assert retrieve(db, bob_id) == "bob-evateam-secret"
            assert "alice-evateam-secret" not in db.get(EvaCredential, alice_id).ciphertext
        assert client.delete("/integrations/eva", headers=a).status_code == 204
        assert client.get("/integrations/eva", headers=a).json()["connected"] is False
        assert client.get("/integrations/eva", headers=b).json()["connected"] is True

def test_missing_vault_key_fails_closed(monkeypatch):
    monkeypatch.delenv("EVADE_CREDENTIAL_KEY", raising=False)
    with TestClient(app) as client:
        with SessionLocal() as db:
            u = User(name="Eva Charlie", token_hash=hashlib.sha256(b"charlie-secret").hexdigest())
            db.add(u); db.commit()
        r = client.put("/integrations/eva", headers={"Authorization":"Bearer charlie-secret"}, json={"token":"some-long-secret"})
        assert r.status_code == 503
