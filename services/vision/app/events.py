"""Events to the web app: POST {WEB_URL}/api/internal/events."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin

import httpx
from warewise_contracts import ItemProcessed, sign_service_token

from app.jobs import event_json

SendEvent = Callable[[dict[str, Any]], None]


def web_event_sender(web_url: str, secret: str, client: httpx.Client | None = None, timeout_s: float = 15.0) -> SendEvent:
    """Raises unless the web app answers 2xx; the worker schedules the retries. The event is
    validated first, so a bad shape fails here, loudly, rather than at the receiver."""
    url = urljoin(web_url, "/api/internal/events")
    http = client or httpx.Client(timeout=timeout_s)

    def send(event: dict[str, Any]) -> None:
        body = event_json(ItemProcessed.model_validate(event))
        res = http.post(url, json=body, headers={"authorization": f"Service {sign_service_token('vision', 'web', secret)}"})
        if not res.is_success:
            raise RuntimeError(f"web answered {res.status_code}")

    return send
