import json

import httpx
import pytest
from warewise_contracts import verify_service_token

from app.events import web_event_sender
from tests.conftest import ITEM, JOB, USER

SECRET = "s" * 32
EVENT = {"type": "item.processed", "jobId": JOB, "userId": USER, "itemId": ITEM, "ok": False,
         "error": {"message": "x", "userFacing": True, "retryable": False}}


def client(status: int, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_posts_with_token_for_web():
    seen = []
    web_event_sender("http://web.test", SECRET, client(204, seen))(EVENT)
    req = seen[0]
    assert str(req.url) == "http://web.test/api/internal/events"
    check = verify_service_token(req.headers["authorization"], "web", SECRET)
    assert check.ok and check.iss == "vision"
    assert json.loads(req.content) == EVENT


def test_raises_on_non_2xx():
    with pytest.raises(RuntimeError, match="503"):
        web_event_sender("http://web.test", SECRET, client(503, []))(EVENT)


def test_refuses_contract_breaking_event():
    seen = []
    with pytest.raises(ValueError):
        web_event_sender("http://web.test", SECRET, client(204, seen))({**EVENT, "jobId": "x"})
    assert not seen
