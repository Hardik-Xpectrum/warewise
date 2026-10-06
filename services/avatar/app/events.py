"""Events to the web app: POST {WEB_URL}/api/internal/events with a service token (aud "web").

The event is queued on the job row in the same write that finishes the job, then delivered here
and retried with backoff until the web app answers 2xx (it dedupes by type + jobId).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from pydantic import TypeAdapter
from warewise_contracts import ServiceEvent, sign_service_token

from .failure import event_retry_delay_s
from .log import error_text, log
from .store import Store, iso, now_iso

EVENT = TypeAdapter(ServiceEvent)

Post = Callable[[str, dict[str, str], dict[str, Any]], int]  # (url, headers, body) -> status


def _http_post(url: str, headers: dict[str, str], body: dict[str, Any]) -> int:
    with httpx.Client(timeout=15) as http:
        return http.post(url, headers=headers, json=body).status_code


def post_event(web_url: str, secret: str, event: dict[str, Any], post: Post = _http_post) -> None:
    body = EVENT.validate_python(event).to_json()  # never send something the contract rejects
    headers = {"authorization": f"Service {sign_service_token('avatar', 'web', secret)}", "content-type": "application/json"}
    status = post(f"{web_url.rstrip('/')}/api/internal/events", headers, body)
    if not 200 <= status < 300:
        raise RuntimeError(f"web answered {status}")


def deliver_events(store: Store, web_url: str, secret: str, post: Post = _http_post) -> int:
    """Sends the events that are due; returns how many were delivered."""
    sent = 0
    for job in store.due_events(10):
        ctx = {"jobId": job["job_id"], "userId": job["user_id"], "type": (job.get("event") or {}).get("type")}
        attempts = int(job.get("event_attempts") or 0) + 1
        try:
            post_event(web_url, secret, job["event"], post)
            store.update_job(job["job_id"], {"event_sent_at": now_iso(), "event_attempts": attempts})
            log("info", "event delivered", **ctx, attempts=attempts)
            sent += 1
        except Exception as err:  # noqa: BLE001
            delay = event_retry_delay_s(attempts)
            gave_up = delay is None
            log("error" if gave_up else "warn", "event given up" if gave_up else "event delivery failed", **ctx, attempts=attempts, error=error_text(err))
            # Giving up leaves event_after null: the event stays on the row for inspection but isn't due again.
            after = None if delay is None else iso(datetime.now(UTC) + timedelta(seconds=delay))
            store.update_job(job["job_id"], {"event_attempts": attempts, "event_after": after})
    return sent
