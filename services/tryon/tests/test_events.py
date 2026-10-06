from datetime import UTC, datetime

import httpx
import pytest
from pydantic import ValidationError
from warewise_contracts import verify_service_token

from app.events import next_event_at, send_event

SECRET = "s" * 40
EV = {"type": "tryon.ready", "jobId": "22222222-2222-4222-8222-222222222222", "userId": "11111111-1111-4111-8111-111111111111",
      "renderPath": "11111111-1111-4111-8111-111111111111/tryon/x.webp", "note": None}


def test_backs_off_1_4_16_60_minutes_then_gives_up():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    assert [(next_event_at(n, now) - now).total_seconds() / 60 for n in (1, 2, 3, 4)] == [1, 4, 16, 60]
    assert next_event_at(5, now) is None


def test_posts_a_signed_valid_event():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(204)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        res = send_event(EV, "http://web", SECRET, client)
    assert (res.ok, res.status) == (True, 204)
    assert str(seen[0].url) == "http://web/api/internal/events"
    check = verify_service_token(seen[0].headers["authorization"], "web", SECRET)
    assert check.ok and check.iss == "tryon"


def test_reports_failures_instead_of_raising():
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("ECONNREFUSED")

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert send_event(EV, "http://web", SECRET, client).ok is False


def test_never_sends_an_invalid_event():
    with pytest.raises(ValidationError):
        send_event({**EV, "renderPath": "not-a-user-path"}, "http://web", SECRET)
