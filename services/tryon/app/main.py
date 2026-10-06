"""The HTTP API. `create_app()` with no arguments is the real service (Supabase store and the
background worker, started on app startup); tests pass a fake store."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from warewise_contracts import JobAccepted, render_cache_key, verify_service_token

from app.cache import decide_render
from app.config import VERSION, engine_mode, env
from app.jobs import ready_event, to_status
from app.log import error_message, log
from app.problem import problem
from app.request import validate_render
from app.store import Store, now_iso

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def create_app(
    store: Store | None = None,
    secret: str | None = None,
    wake: Callable[[], None] | None = None,
    engine: Literal["ai", "composite"] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        worker = None
        if store is None:
            from app.store import SupabaseStore
            from app.worker import Worker

            app.state.store = SupabaseStore()
            app.state.secret = env.service_secret()
            if env.inline_worker():
                # Its own client: the worker thread never shares HTTP connections with the routes.
                worker = Worker(SupabaseStore()).start()
                app.state.wake = worker.wake
            log("info", "tryon listening", engine=engine_mode())
        yield
        if worker:
            worker.stop()
            worker.join(5)

    app = FastAPI(title="Warewise try-on", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.secret = secret
    app.state.wake = wake or (lambda: None)

    def mode() -> str:
        return engine or engine_mode()

    @app.middleware("http")
    async def service_auth(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """`Authorization: Service <token>` signed by the web app (the only caller) on /v1/*."""
        if request.url.path.startswith("/v1/"):
            check = verify_service_token(request.headers.get("authorization"), "tryon", app.state.secret)
            if not check.ok:
                return problem(401, "Unauthorized", check.reason)
            if check.iss != "web":
                return problem(403, "Forbidden", f"{check.iss} may not call the try-on service")
        return await call_next(request)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return problem(exc.status_code, "Not found" if exc.status_code == 404 else str(exc.detail))

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> JSONResponse:
        log("error", "request failed", path=request.url.path, error=error_message(exc))
        return problem(500, "Internal error")

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "service": "tryon", "version": VERSION}

    @app.post("/v1/renders")
    async def post_render(request: Request) -> Response:
        try:
            body = json.loads(await request.body())
        except ValueError:
            body = None
        ok, value = validate_render(body)
        if not ok:
            return problem(400, "Invalid render request", str(value))
        return await run_in_threadpool(_accept, value)  # the store client is synchronous

    def _accept(req: dict) -> Response:
        s: Store = app.state.store
        job_id, user_id = req["jobId"], req["userId"]
        # The engine mode is in the key: an offline composite is never served once AI is back.
        cache_key = render_cache_key(req["personImagePath"], req["avatarVersion"], req["garments"], mode())

        def accepted(status: str, cached: bool) -> JSONResponse:
            return JSONResponse(JobAccepted(job_id=job_id, status=status, cached=cached).to_json(), status_code=202)

        decision = decide_render(user_id, cache_key, req["avatarVersion"], s.get(job_id), s.cache_hits(user_id, cache_key))
        if decision.kind == "conflict":
            return problem(409, "Job id already used", "This jobId belongs to a different render request")
        if decision.kind == "existing" and decision.row:
            return accepted(decision.row["status"], bool(decision.row.get("cached_from")))

        base = {"job_id": job_id, "user_id": user_id, "cache_key": cache_key, "request": req}
        if decision.kind == "cached" and decision.row:
            # Same person photo (or avatar version) and garments: answer now, no GPU time. The
            # event still goes out so the web app handles every render the same way.
            src = decision.row
            now = now_iso()
            inserted = s.insert({
                **base, "status": "done", "render_path": src["render_path"], "texture": src.get("texture"), "note": src.get("note"),
                "cached_from": src["job_id"], "finished_at": now,
                "event": ready_event(job_id, user_id, src["render_path"], src.get("note")), "event_after": now,
            })
            if not inserted:
                return accepted((s.get(job_id) or {}).get("status", "queued"), False)
            log("info", "render cache hit", jobId=job_id, userId=user_id, **{"from": src["job_id"]})
            app.state.wake()
            return accepted("done", True)

        if not s.insert({**base, "status": "queued"}):
            return accepted((s.get(job_id) or {}).get("status", "queued"), False)
        log("info", "render queued", jobId=job_id, userId=user_id)
        app.state.wake()
        return accepted("queued", False)

    @app.get("/v1/renders/{job_id}")
    def get_render(job_id: str) -> Response:
        if not UUID.match(job_id):
            return problem(400, "Invalid job id")
        row = app.state.store.get(job_id)
        return JSONResponse(to_status(row)) if row else problem(404, "Render not found")

    @app.delete("/v1/users/{user_id}/renders")
    def delete_user(user_id: str) -> Response:
        """Account deletion: every render row and file under <userId>/tryon/."""
        if not UUID.match(user_id):
            return problem(400, "Invalid user id")
        rows, files = app.state.store.delete_user(user_id)
        log("info", "user renders deleted", userId=user_id, rows=rows, files=files)
        return Response(status_code=204)

    return app


app = create_app()
