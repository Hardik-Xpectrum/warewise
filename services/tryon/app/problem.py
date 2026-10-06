"""RFC 7807 problem details, the error body of every endpoint. Types are "/errors/<slug>", the same
convention as the web app and the other services."""

from __future__ import annotations

from fastapi.responses import JSONResponse
from warewise_contracts import Problem

SLUG = {400: "bad-request", 401: "unauthorized", 403: "forbidden", 404: "not-found", 405: "method-not-allowed", 409: "conflict", 500: "internal"}


def problem(status: int, title: str, detail: str | None = None) -> JSONResponse:
    body = Problem(type=f"/errors/{SLUG.get(status, 'error')}", title=title, status=status, detail=detail)
    return JSONResponse(body.model_dump(by_alias=True, exclude_none=True), status_code=status, media_type="application/problem+json")
