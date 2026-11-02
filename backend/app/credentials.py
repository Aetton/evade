"""User-owned EvaTeam credential vault.

Fernet key must be persistent across restarts and provided outside the database.
No tokens are returned by the public API.
"""
import os
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy.orm import Session
from .models import EvaCredential

def cipher() -> Fernet:
    key = os.getenv("EVADE_CREDENTIAL_KEY", "").strip()
    if not key:
        raise HTTPException(503, "Eva credential vault is not configured")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise RuntimeError("Invalid EVADE_CREDENTIAL_KEY") from exc

def store(db: Session, user_id: str, token: str) -> None:
    encrypted = cipher().encrypt(token.encode("utf-8")).decode("ascii")
    row = db.get(EvaCredential, user_id)
    if row:
        row.ciphertext = encrypted
    else:
        db.add(EvaCredential(user_id=user_id, ciphertext=encrypted))

def retrieve(db: Session, user_id: str) -> str | None:
    row = db.get(EvaCredential, user_id)
    if row is None:
        return None
    try:
        return cipher().decrypt(row.ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Could not decrypt Eva credential; verify encryption key") from exc
