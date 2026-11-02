import httpx
import pytest
from app import eva_client

def test_rpc_bearer_and_result(monkeypatch):
    monkeypatch.setenv("EVADE_EVA_URL", "https://example.test/api/")
    seen = {}
    def handler(request):
        seen["method"] = request.json() if hasattr(request, "json") else __import__("json").loads(request.content)
        seen["authorization"] = request.headers["Authorization"]
        return httpx.Response(200, json={"jsonrpc":"2.2", "result": [], "callid":seen["method"]["callid"]})
    class Client:
        def __init__(self, **kwargs): self.ctx = httpx.Client(transport=httpx.MockTransport(handler))
        def __enter__(self): return self.ctx
        def __exit__(self, *args): self.ctx.close()
        def post(self, *args, **kwargs): return self.ctx.post(*args, **kwargs)
    monkeypatch.setattr(eva_client.httpx, "Client", Client)
    eva_client.probe("personal-token")
    assert seen["authorization"] == "Bearer personal-token"
    assert seen["method"]["jsonrpc"] == "2.2"
    assert seen["method"]["method"] == "CmfTask.list"

def test_rpc_error_is_failure(monkeypatch):
    monkeypatch.setenv("EVADE_EVA_URL", "https://example.test")
    def handler(_):
        return httpx.Response(200, json={"jsonrpc":"2.2", "error":{"code":401,"message":"Denied"}})
    real_client = httpx.Client
    monkeypatch.setattr(eva_client.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler)))
    with pytest.raises(eva_client.EvaError):
        eva_client.probe("bad-token")

def test_http_endpoint_must_be_https(monkeypatch):
    monkeypatch.setenv("EVADE_EVA_URL", "http://insecure.example/api/")
    with pytest.raises(eva_client.EvaError):
        eva_client.endpoint()
