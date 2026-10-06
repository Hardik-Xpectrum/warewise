"""Service-to-service auth: every endpoint but /health needs `Authorization: Service <token>`
signed with the shared SERVICE_SECRET for audience "avatar", from an allowed sender.

The web app builds and deletes; the try-on service may read avatars to re-texture them.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable

from fastapi import Request, Response
from warewise_contracts import verify_service_token

from .problem import problem

READERS = ("web", "tryon")
WRITERS = ("web",)


def allowed_callers(method: str) -> tuple[str, ...]:
    return READERS if method in ("GET", "HEAD") else WRITERS


def check_caller(authorization: str | None, secret: str, allow: Iterable[str]) -> Response | None:
    """None when the caller may go on; otherwise the 401/403 problem to answer."""
    result = verify_service_token(authorization, "avatar", secret)
    if not result.ok:
        return problem(401, "unauthorized", "Service token rejected", result.reason)
    if result.iss not in allow:
        return problem(403, "forbidden", "Caller not allowed", f"{result.iss} may not call this endpoint")
    return None


def service_auth(secret: str, prefix: str = "/v1/") -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """HTTP middleware guarding every path under `prefix`."""

    async def middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        if request.url.path.startswith(prefix):
            denied = check_caller(request.headers.get("authorization"), secret, allowed_callers(request.method))
            if denied is not None:
                return denied
        return await call_next(request)

    return middleware
