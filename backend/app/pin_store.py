"""Exact leaf-certificate pinning for one configured EvaTeam HTTPS hostname.

The fingerprint is checked in urllib3's HTTPS connection establishment,
before it can send the Authorization header. Never preflight then use
verify=False in a separate connection: that would be vulnerable to TOCTOU.
"""
import hashlib
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
from cryptography.x509.oid import ExtensionOID, ExtendedKeyUsageOID
from .ca_store import CertificateError

PIN_PATH = Path(os.environ.get("EVADE_PIN_FILE", "/var/lib/evade/certs/eva-server.pem"))
MAX_PIN_BYTES = 16384
PEM = re.compile(rb"\A\s*(-----BEGIN CERTIFICATE-----\s+.+?-----END CERTIFICATE-----)\s*\Z", re.DOTALL)


def configured_host() -> str:
    raw = os.getenv("EVADE_EVA_URL", "")
    url = urlsplit(raw)
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise CertificateError("Сначала настройте EVADE_EVA_URL (HTTPS)")
    return url.hostname.lower()


def inspect(pem: bytes, host: str | None = None) -> dict:
    if not 0 < len(pem) <= MAX_PIN_BYTES:
        raise CertificateError("Ожидается один PEM-сертификат размером до 16 КиБ")
    match = PEM.fullmatch(pem)
    if not match:
        raise CertificateError("Нужен один серверный сертификат в PEM, без приватного ключа")
    try:
        cert = x509.load_pem_x509_certificate(match.group(1))
    except ValueError as exc:
        raise CertificateError("Невалидный PEM-сертификат") from exc
    now = datetime.now(timezone.utc)
    if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
        raise CertificateError("Сертификат сервера ещё не действителен или уже истёк")
    try:
        if cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value.ca:
            raise CertificateError("Это CA-сертификат. Для него используйте режим установки CA")
    except x509.ExtensionNotFound:
        pass
    try:
        eku = cert.extensions.get_extension_for_oid(ExtensionOID.EXTENDED_KEY_USAGE).value
        if ExtendedKeyUsageOID.SERVER_AUTH not in eku:
            raise CertificateError("Сертификат не предназначен для TLS Web Server Authentication")
    except x509.ExtensionNotFound:
        pass
    try:
        san = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value
        dns = [s.lower() for s in san.get_values_for_type(x509.DNSName)]
    except x509.ExtensionNotFound as exc:
        raise CertificateError("У сертификата нет Subject Alternative Name (DNS)") from exc
    target = (host or configured_host()).lower()
    # For pinning we deliberately permit only an exact DNS SAN, no wildcard.
    if target not in dns:
        raise CertificateError("DNS-имя сертификата не совпадает с адресом EvaTeam")
    digest = hashlib.sha256(cert.public_bytes(Encoding.DER)).hexdigest().upper()
    return {"installed": False, "hostname": target, "sha256": digest, "expires_at": cert.not_valid_after_utc.isoformat()}


def status() -> dict:
    if not PIN_PATH.is_file():
        return {"installed": False}
    try:
        info = inspect(PIN_PATH.read_bytes())
        return {**info, "installed": True}
    except (CertificateError, OSError):
        return {"installed": True, "warning": "Закреплённый сертификат повреждён или не соответствует EvaTeam"}


def installed_fingerprint(host: str) -> str | None:
    if not PIN_PATH.is_file():
        return None
    # Fail closed if the installed pin is malformed, mismatched or expired.
    return inspect(PIN_PATH.read_bytes(), host=host)["sha256"]


def install(pem: bytes, expected_fingerprint: str) -> dict:
    info = inspect(pem)
    if expected_fingerprint.upper().replace(":", "") != info["sha256"]:
        raise CertificateError("Подтверждённый SHA-256 не совпадает с сертификатом")
    PIN_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=PIN_PATH.parent, prefix=".pin-")
    try:
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(pem)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, PIN_PATH)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {**info, "installed": True}


def remove() -> None:
    PIN_PATH.unlink(missing_ok=True)
