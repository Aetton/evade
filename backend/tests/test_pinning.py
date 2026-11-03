import hashlib
import json
import os
import socket
import ssl
import threading
from datetime import datetime, timedelta, timezone

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

from app import eva_client, pin_store
from app.ca_store import CertificateError


def leaf(host="localhost"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    cert = (x509.CertificateBuilder()
        .subject_name(subject).issuer_name(subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=14))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
    return pem, key_pem


def test_pin_persistence_expiry_and_hostname(monkeypatch, tmp_path):
    monkeypatch.setattr(pin_store, "PIN_PATH", tmp_path / "server.pem")
    monkeypatch.setenv("EVADE_EVA_URL", "https://localhost/api/")
    pem, _ = leaf()
    info = pin_store.inspect(pem)
    assert info["hostname"] == "localhost"
    assert len(info["sha256"]) == 64
    with pytest.raises(CertificateError):
        pin_store.install(pem, "0" * 64)
    assert not pin_store.PIN_PATH.exists()
    assert pin_store.install(pem, info["sha256"])["installed"]
    assert pin_store.installed_fingerprint("localhost") == info["sha256"]
    with pytest.raises(CertificateError):
        pin_store.installed_fingerprint("different.example")
    assert pin_store.status()["installed"]
    with pytest.raises(CertificateError):
        pin_store.inspect(pem + b"PRIVATE KEY")
    pin_store.remove()
    assert pin_store.installed_fingerprint("localhost") is None


def test_pin_is_checked_before_sending_bearer(monkeypatch, tmp_path):
    monkeypatch.setattr(pin_store, "PIN_PATH", tmp_path / "server.pem")
    cert, private_key = leaf()
    (tmp_path / "cert.pem").write_bytes(cert)
    (tmp_path / "key.pem").write_bytes(private_key)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    received = []
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(3)
    listener.settimeout(5)
    port = listener.getsockname()[1]

    def serve():
        for _ in range(2):
            try:
                incoming, _addr = listener.accept()
                with incoming:
                    try:
                        with context.wrap_socket(incoming, server_side=True) as sock:
                            sock.settimeout(2)
                            data = sock.recv(32768)
                            if data:
                                received.append(data)
                                if b"POST /api/" in data:
                                    payload = json.dumps({"jsonrpc": "2.2", "result": []}).encode()
                                    sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: " +
                                                 str(len(payload)).encode() + b"\r\nConnection: close\r\n\r\n" + payload)
                    except (ssl.SSLError, ConnectionError, OSError):
                        pass
            except socket.timeout:
                break
        listener.close()

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    monkeypatch.setenv("EVADE_EVA_URL", f"https://localhost:{port}/api/")
    expected = pin_store.inspect(cert)["sha256"]
    pin_store.install(cert, expected)
    # Wrong pin is already validated on storage, so simulate an unrelated
    # HTTPS endpoint presenting a different certificate from our stored pin.
    other, other_key = leaf()
    other_file = tmp_path / "other.pem"
    key_file = tmp_path / "other-key.pem"
    other_file.write_bytes(other)
    key_file.write_bytes(other_key)
    # Server's presented cert differs from the uploaded/pinned one.
    context.load_cert_chain(str(other_file), str(key_file))
    with pytest.raises(eva_client.EvaError):
        eva_client.probe("secret-bearer")
    # Switch back to actual certificate. A request should now pass.
    context.load_cert_chain(str(tmp_path / "cert.pem"), str(tmp_path / "key.pem"))
    eva_client.probe("secret-bearer")
    server.join(timeout=6)
    assert len(received) == 1, "Mismatched certificate must not receive an HTTP request"
    assert b"Authorization: Bearer secret-bearer" in received[0]


def test_pin_api_is_admin_only(monkeypatch, tmp_path):
    import hashlib
    from fastapi.testclient import TestClient
    from app.database import SessionLocal
    from app.main import app
    from app.models import User

    monkeypatch.setattr(pin_store, "PIN_PATH", tmp_path / "pin.pem")
    monkeypatch.setenv("EVADE_EVA_URL", "https://localhost/api/")
    pem, _ = leaf()
    with TestClient(app) as client:
        with SessionLocal() as db:
            db.add(User(name="Pin administrator", is_admin=True,
                        token_hash=hashlib.sha256(b"pin-admin").hexdigest()))
            db.add(User(name="Pin ordinary", is_admin=False,
                        token_hash=hashlib.sha256(b"pin-user").hexdigest()))
            db.commit()
        admin = {"Authorization": "Bearer pin-admin"}
        ordinary = {"Authorization": "Bearer pin-user"}
        assert client.get("/admin/eva/pin").status_code == 401
        assert client.post("/admin/eva/pin/inspect", json={"pem": pem.decode()}, headers=ordinary).status_code == 403
        assert client.put("/admin/eva/pin", json={"pem": pem.decode(), "sha256": "0" * 64},
                          headers=ordinary).status_code == 403
        info = client.post("/admin/eva/pin/inspect", json={"pem": pem.decode()}, headers=admin)
        assert info.status_code == 200, info.text
        bad = client.put("/admin/eva/pin", headers=admin, json={"pem": pem.decode(), "sha256": "0" * 64})
        assert bad.status_code == 422
        good = client.put("/admin/eva/pin", headers=admin,
                          json={"pem": pem.decode(), "sha256": info.json()["sha256"]})
        assert good.status_code == 200, good.text
        assert client.get("/admin/eva/pin", headers=admin).json()["installed"]
        assert client.delete("/admin/eva/pin", headers=admin).status_code == 204
