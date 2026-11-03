"""Signed, revocable, expiring web sessions without schema migrations.

The cookie never contains the user's personal bearer token. Its signature
is bound to the current user token hash, so rotating a token revokes sessions.
"""
import hashlib
import hmac
import os
import time

SESSION_COOKIE = "evade_session"
SESSION_TTL = 30 * 24 * 60 * 60


def _signature(payload: str, token_hash: str) -> str:
    key = os.environ.get("EVADE_CREDENTIAL_KEY")
    if not key:
        raise RuntimeError("EVADE_CREDENTIAL_KEY must be set")
    message = ("evade-web-session-v1:" + payload + ":" + token_hash).encode()
    return hmac.new(key.encode(), message, hashlib.sha256).hexdigest()


def create(user) -> str:
    payload = f"{user.id}:{int(time.time())}"
    return payload + ":" + _signature(payload, user.token_hash)


def verify(cookie: str, get_user):
    try:
        user_id, issued, signature = cookie.split(":")
        created = int(issued)
        now = int(time.time())
        if created > now + 60 or created < now - SESSION_TTL:
            return None
        user = get_user(user_id)
        if user is None:
            return None
        expected = _signature(f"{user_id}:{issued}", user.token_hash)
        return user if hmac.compare_digest(signature, expected) else None
    except (ValueError, RuntimeError, AttributeError):
        return None
