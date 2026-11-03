"""Minimal EvaTeam JSON-RPC 2.2 transport.

All network requests target the server configured by the administrator.
Never accept a caller-supplied URL or disable TLS verification.
"""
import os
from uuid import uuid4
from urllib.parse import urlsplit
import httpx
from .ca_store import verify_context

class EvaError(Exception):
    def __init__(self, message: str, *, status: int = 502, code=None):
        super().__init__(message)
        self.status = status
        self.code = code

def endpoint() -> str:
    raw = os.getenv("EVADE_EVA_URL", "").strip().rstrip("/")
    if not raw:
        raise EvaError("EvaTeam endpoint is not configured", status=503)
    parts = urlsplit(raw)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise EvaError("EVADE_EVA_URL must be an HTTPS origin (optionally ending in /api)", status=503)
    if parts.path not in ("", "/", "/api", "/api/"):
        raise EvaError("EVADE_EVA_URL has an unsupported path", status=503)
    return f"{parts.scheme}://{parts.netloc}/api/"

def call(token: str, method: str, *, kwargs: dict | None = None, args: list | None = None) -> object:
    body = {"jsonrpc": "2.2", "method": method, "args": args or [], "kwargs": kwargs or {}, "callid": str(uuid4())}
    try:
        with httpx.Client(timeout=10.0, follow_redirects=False, trust_env=False, verify=verify_context()) as client:
            response = client.post(endpoint(), json=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    except (httpx.RequestError, OSError) as exc:
        # Never expose remote response bodies, internal addresses or credentials.
        reason = "TLS certificate verification failed" if "CERTIFICATE_VERIFY_FAILED" in str(exc) else "network connection failed"
        raise EvaError(f"EvaTeam: {reason}") from exc
    if response.status_code in (401, 403):
        raise EvaError("EvaTeam rejected the token or permissions", status=422)
    if response.status_code != 200:
        raise EvaError(f"EvaTeam HTTP {response.status_code}")
    try:
        data = response.json()
    except ValueError as exc:
        raise EvaError("EvaTeam returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise EvaError("EvaTeam returned an invalid response")
    if data.get("error"):
        err = data["error"]
        message = err.get("message", "EvaTeam RPC error") if isinstance(err, dict) else "EvaTeam RPC error"
        code = err.get("code") if isinstance(err, dict) else None
        raise EvaError(str(message), status=422, code=code)
    if data.get("abort"):
        raise EvaError("EvaTeam aborted the request", status=422)
    if "result" not in data:
        raise EvaError("EvaTeam response has no result")
    return data["result"]

def probe(token: str) -> None:
    # Deliberately query a nonexistent code; no mutations and no bulk task read.
    # This tests the token's ability to call CmfTask.list, not all future permissions.
    call(token, "CmfTask.list", kwargs={"filter": ["code", "==", "__EVADE_CONNECTION_PROBE__"]})
