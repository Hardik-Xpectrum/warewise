"""RFC 7807 problem details, the error body of every service (contract: Problem)."""

from __future__ import annotations

from fastapi.responses import JSONResponse
from warewise_contracts import Problem


def problem(status: int, type_: str, title: str, detail: str | None = None) -> JSONResponse:
    # "/errors/<slug>", the same convention as the web app and the other services.
    body = Problem(type=f"/errors/{type_.removeprefix('/errors/')}", title=title, status=status, detail=detail).to_json()
    if detail is None:
        body.pop("detail", None)
    return JSONResponse(body, status_code=status, media_type="application/problem+json")
