import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient

from app import ca_store
from app.database import SessionLocal
from app.main import app
from app.models import User


def ca_pem(*, is_ca=True):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test internal CA")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=is_ca, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def test_ca_storage_and_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(ca_store, "CA_PATH", tmp_path / "certs" / "eva-ca.pem")
    pem = ca_pem()
    assert ca_store.install(pem.encode())["certificates"] == 1
    assert ca_store.status()["installed"] is True
    assert ca_store.verify_context()
    with pytest.raises(ca_store.CertificateError):
        ca_store.install(ca_pem(is_ca=False).encode())
    assert ca_store.CA_PATH.read_bytes() == pem.encode()
    with pytest.raises(ca_store.CertificateError):
        ca_store.install(b"not a certificate")
    assert ca_store.CA_PATH.read_bytes() == pem.encode()
    ca_store.remove()
    assert not ca_store.status()["installed"]


def test_ca_management_requires_admin(tmp_path, monkeypatch):
    monkeypatch.setattr(ca_store, "CA_PATH", tmp_path / "eva-ca.pem")
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(name="CA Admin", is_admin=True, token_hash=hashlib.sha256(b"ca-admin-token").hexdigest()))
            db.add(User(name="CA User", is_admin=False, token_hash=hashlib.sha256(b"ca-user-token").hexdigest()))
            db.commit()
        admin = {"Authorization": "Bearer ca-admin-token"}
        user = {"Authorization": "Bearer ca-user-token"}
        assert client.get("/admin/eva/ca").status_code == 401
        assert client.get("/admin/eva/ca", headers=user).status_code == 403
        assert client.put("/admin/eva/ca", json={"pem": ca_pem()}, headers=user).status_code == 403
        assert client.delete("/admin/eva/ca", headers=user).status_code == 403
        assert client.put("/admin/eva/ca", json={"pem": "bad"}, headers=admin).status_code == 422
        result = client.put("/admin/eva/ca", json={"pem": ca_pem()}, headers=admin)
        assert result.status_code == 200, result.text
        assert result.json()["certificates"] == 1
        assert client.get("/admin/eva/ca", headers=admin).json()["installed"] is True
        assert client.delete("/admin/eva/ca", headers=admin).status_code == 204
        assert client.get("/admin/eva/ca", headers=admin).json()["installed"] is False
