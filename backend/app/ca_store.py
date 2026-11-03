"""Server-managed extra trust anchors for the EvaTeam connection only."""
import os
import re
import ssl
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import ExtensionOID

MAX_PEM_BYTES = 65536
CA_PATH = Path(os.environ.get("EVADE_CA_FILE", "/var/lib/evade/certs/eva-ca.pem"))
PEM_RE = re.compile(rb"-----BEGIN CERTIFICATE-----\s+.+?-----END CERTIFICATE-----", re.DOTALL)


class CertificateError(ValueError):
    pass


def _validate(pem: bytes) -> int:
    if not pem or len(pem) > MAX_PEM_BYTES:
        raise CertificateError("Размер CA-файла должен быть от 1 байта до 64 КиБ")
    blocks = PEM_RE.findall(pem)
    if not blocks or len(blocks) > 16:
        raise CertificateError("Нужен PEM-файл с 1–16 сертификатами CA")
    if re.sub(rb"\s+", b"", PEM_RE.sub(b"", pem)):
        raise CertificateError("Файл должен содержать только PEM-сертификаты, без ключей")
    now = datetime.now(timezone.utc)
    for block in blocks:
        try:
            cert = x509.load_pem_x509_certificate(block)
            basic = cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS).value
            if not basic.ca:
                raise CertificateError("Сертификат не является CA")
            if cert.not_valid_before_utc > now or cert.not_valid_after_utc < now:
                raise CertificateError("Сертификат CA ещё не действителен или уже истёк")
        except (ValueError, x509.ExtensionNotFound) as exc:
            raise CertificateError("Невалидный PEM или отсутствует CA BasicConstraints") from exc
    try:
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cadata=pem.decode("ascii"))
    except (ValueError, UnicodeError, ssl.SSLError) as exc:
        raise CertificateError("Не удалось загрузить CA в TLS-хранилище") from exc
    return len(blocks)


def status() -> dict:
    if not CA_PATH.is_file():
        return {"installed": False, "certificates": 0}
    try:
        return {"installed": True, "certificates": _validate(CA_PATH.read_bytes())}
    except (CertificateError, OSError):
        return {"installed": True, "certificates": None, "warning": "CA-файл повреждён"}


def install(pem: bytes) -> dict:
    count = _validate(pem)
    CA_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=CA_PATH.parent, prefix=".ca-")
    try:
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(pem)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, CA_PATH)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return {"installed": True, "certificates": count}


def remove() -> None:
    CA_PATH.unlink(missing_ok=True)


def verify_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if CA_PATH.is_file():
        ctx.load_verify_locations(cafile=str(CA_PATH))
    return ctx
