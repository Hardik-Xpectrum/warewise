"""The vision service's HTTP API (FastAPI). `uvicorn app.main:app` reads the environment and starts
the worker on startup; tests build the app with `create_app(AppDeps(...))` and no worker."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from warewise_contracts import JobAccepted, ProcessItemRequest, verify_service_token

from app.config import VERSION
from app.jobs import public_status
from app.log import error_fields, log
from app.store import JobStore

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@dataclass
class AppDeps:
    store: JobStore
    secret: str
    on_job_queued: Callable[[], None] = field(default=lambda: None)
    # Only the web app calls this service, so other issuers are refused too.
    issuers: tuple[str, ...] = ("web",)


def problem(status: int, slug: str, title: str, detail: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"type": f"/errors/{slug}", "title": title, "status": status}
    if detail:
        body["detail"] = detail
    return JSONResponse(body, status_code=status, media_type="application/problem+json")


def parse_process_request(body: Any) -> tuple[ProcessItemRequest | None, str | None]:
    """Contract check plus the rule the schema can't express: the photo must sit in the user's own folder."""
    try:
        req = ProcessItemRequest.model_validate(body)
    except ValidationError as err:
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'body'}: {e['msg']}" for e in err.errors()[:3]
        )
        return None, detail
    if not req.image_path.startswith(f"{req.user_id}/"):
        return None, "imagePath: must be inside the user's own folder"
    if ".." in req.image_path.split("/"):
        return None, "imagePath: must not contain .."
    return req, None


def _build_from_env() -> tuple[AppDeps, Callable[[], None]]:
    """Real dependencies: Supabase store and files, the event sender, and the worker thread."""
    from app.config import load_settings
    from app.events import web_event_sender
    from app.files import SupabaseFiles
    from app.pipeline import process_item
    from app.store import SupabaseJobStore, supabase_client
    from app.worker import Worker

    env = load_settings()
    if env.model_cache_dir:
        import os

        os.environ.setdefault("MODEL_CACHE_DIR", env.model_cache_dir)
    db = supabase_client(env.supabase_url, env.supabase_secret_key)
    store = SupabaseJobStore(db)
    files = SupabaseFiles(db)
    worker = Worker(store, files, lambda job: process_item(job, files), web_event_sender(env.web_url, env.service_secret))
    worker.start()
    return AppDeps(store=store, secret=env.service_secret, on_job_queued=worker.kick), worker.stop


def create_app(deps: AppDeps | None = None) -> FastAPI:
    holder: dict[str, AppDeps] = {}
    if deps:
        holder["deps"] = deps

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        stop: Callable[[], None] | None = None
        if "deps" not in holder:
            holder["deps"], stop = _build_from_env()
            log("info", "started", version=VERSION)
        yield
        if stop:
            log("info", "shutting down")
            stop()

    app = FastAPI(title="Warewise vision", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> Response:
        if exc.status_code == 404:
            return problem(404, "not-found", "No such endpoint")
        if exc.status_code == 405:
            return problem(405, "method-not-allowed", "Method not allowed")
        return problem(exc.status_code, "error", str(exc.detail))

    @app.exception_handler(Exception)
    async def crashed(_: Request, exc: Exception) -> Response:
        log("error", "request failed", **error_fields(exc))
        return problem(500, "internal", "Something went wrong")

    @app.middleware("http")
    async def require_service(request: Request, call_next: Callable[..., Any]) -> Response:
        """Every endpoint but /health needs `Authorization: Service <token>` addressed to "vision"."""
        if request.url.path.startswith("/v1/"):
            d = holder["deps"]
            check = verify_service_token(request.headers.get("authorization"), "vision", d.secret)
            if not check.ok:
                return problem(401, "unauthorized", "Service token required", check.reason)
            if check.iss not in d.issuers:
                return problem(403, "forbidden", "This caller may not use the vision service")
        try:
            return await call_next(request)
        except Exception as exc:  # errors raised inside the middleware stack
            log("error", "request failed", **error_fields(exc))
            return problem(500, "internal", "Something went wrong")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "vision", "version": VERSION}

    @app.post("/v1/items/process")
    async def process(request: Request) -> Response:
        try:
            body = json.loads(await request.body())
        except ValueError:
            return problem(400, "bad-request", "Body must be JSON")
        req, detail = parse_process_request(body)
        if req is None:
            return problem(400, "bad-request", "Invalid request", detail)
        d = holder["deps"]
        job, created = d.store.create(req)
        # Same jobId, different work: a bug on the caller's side, not a retry.
        if (job.user_id, job.item_id, job.image_path) != (req.user_id, req.item_id, req.image_path):
            return problem(409, "conflict", "This jobId is already used for a different item")
        if created:
            log("info", "job queued", jobId=job.job_id, userId=job.user_id)
            d.on_job_queued()
        accepted = JobAccepted(job_id=job.job_id, status=job.status, cached=False)
        return JSONResponse(accepted.to_json(), status_code=202)

    @app.get("/v1/jobs/{job_id}")
    def job_status(job_id: str) -> Response:
        if not UUID_RE.match(job_id):
            return problem(400, "bad-request", "jobId must be a UUID")
        job = holder["deps"].store.get(job_id)
        if job is None:
            return problem(404, "not-found", "No such job")
        return JSONResponse(public_status(job))

    # Account deletion: this service's records only. The Storage files belong to the item, and the
    # web app removes them with the rest of the user's folder.
    @app.delete("/v1/users/{user_id}")
    def delete_user(user_id: str) -> Response:
        if not UUID_RE.match(user_id):
            return problem(400, "bad-request", "userId must be a UUID")
        removed = holder["deps"].store.delete_user(user_id)
        log("info", "user data deleted", userId=user_id, jobs=removed)
        return Response(status_code=204)

    return app


app = create_app()
