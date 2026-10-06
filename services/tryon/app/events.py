"""tryon.ready / tryon.failed to the web app: POST {WEB_URL}/api/internal/events. Events are kept
on the render row (an outbox) and retried with backoff 1, 4, 16, 60 min, so a web outage or a
restart never loses one. The web app treats them as idempotent by (type, jobId)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import httpx
from pydantic import TypeAdapter
from warewise_contracts import ServiceEvent, sign_service_token

from app.log import log

BACKOFF_MIN = [1, 4, 16, 60]
_EVENT = TypeAdapter(ServiceEvent)


def next_event_at(attempts: int, now: datetime) -> datetime | None:
    """When to try again after `attempts` failed deliveries; None = give up (after 5 tries)."""
    if attempts < 1 or attempts > len(BACKOFF_MIN):
        return None
    return now + timedelta(minutes=BACKOFF_MIN[attempts - 1])


@dataclass
class Delivery:
    ok: bool
    status: int | None = None
    error: str | None = None


def send_event(event: dict, web_url: str, secret: str, client: httpx.Client | None = None) -> Delivery:
    # Never send something the web app would reject: this raises on an invalid event.
    body = _EVENT.validate_python(event).to_json()
    headers = {"content-type": "application/json", "authorization": f"Service {sign_service_token('tryon', 'web', secret)}"}
    try:
        if client is not None:
            res = client.post(f"{web_url}/api/internal/events", json=body, headers=headers, timeout=15)
        else:
            res = httpx.post(f"{web_url}/api/internal/events", json=body, headers=headers, timeout=15)
        return Delivery(ok=res.is_success, status=res.status_code)
    except httpx.HTTPError as err:
        log("warn", "event delivery failed", jobId=event.get("jobId"), error=str(err) or type(err).__name__)
        return Delivery(ok=False, error=str(err) or type(err).__name__)
