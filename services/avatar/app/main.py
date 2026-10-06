"""HTTP API (contract: BuildAvatarRequest, JobAccepted, AvatarCurrent, AvatarVersion) and the
in-process worker. Run: `uvicorn app.main:app --port 7860`."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from warewise_contracts import AvatarCurrent, JobAccepted

from .auth import service_auth
from .config import read_env
from .log import error_text, log, route_library_logs
from .problem import problem
from .store import Store, SupabaseStore, to_version
from .validate import validate_build

VERSION = "0.2.0"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SIGNED_URL_S = 3600


def _bad_user() -> JSONResponse:
    return problem(400, "bad-request", "Bad user id", "userId must be a UUID")


def create_app(store: Store, secret: str, on_start: Callable[[], Callable[[], None] | None] | None = None) -> FastAPI:
    """`on_start` starts the worker and returns its stop function (tests pass nothing)."""

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # noqa: ANN202
        stop = on_start() if on_start else None
        yield
        if stop:
            stop()

    app = FastAPI(title="Warewise avatar service", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.middleware("http")(service_auth(secret))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> Response:
        if exc.status_code == 404:
            return problem(404, "not-found", "Not found")
        if exc.status_code == 405:
            return problem(405, "method-not-allowed", "Method not allowed")
        return problem(exc.status_code, "error", str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> Response:
        return problem(400, "bad-request", "Invalid request", str(exc.errors())[:300])

    @app.exception_handler(Exception)
    async def crash(request: Request, exc: Exception) -> Response:
        log("error", "request failed", path=request.url.path, error=error_text(exc))
        return problem(500, "internal", "Something went wrong")

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": "avatar", "version": VERSION}

    @app.post("/v1/avatars/build", status_code=202)
    async def build(request: Request) -> Response:
        try:
            body = json.loads(await request.body() or b"null")
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None
        v = validate_build(body)
        if not v.ok or v.req is None:
            return problem(400, "bad-request", "Invalid build request", v.detail)
        req = v.req
        job = await run_in_threadpool(store.enqueue, req)
        # Same jobId, different user or scan: a client bug, not a retry.
        if job["user_id"] != req.user_id or job["kind"] != req.kind:
            return problem(409, "conflict", "jobId already used", "This jobId belongs to another build")
        log("info", "build accepted", jobId=job["job_id"], userId=job["user_id"], kind=job["kind"], status=job["status"])
        return JSONResponse(JobAccepted(job_id=job["job_id"], status=job["status"], cached=False).to_json(), status_code=202)

    @app.get("/v1/avatars/{user_id}")
    def current(user_id: str) -> Response:
        if not UUID.match(user_id):
            return _bad_user()
        row, building = store.latest_version(user_id), store.building(user_id)
        if not row:
            return problem(404, "not-found", "No avatar yet", "The first build is in progress" if building else None)
        v = to_version(row)
        urls = store.signed_urls([p for p in (v.mesh_path, v.face_mesh_path, v.face_texture_path) if p], SIGNED_URL_S)
        body = AvatarCurrent(
            **v.model_dump(),
            mesh_url=urls.get(v.mesh_path) if v.mesh_path else None,
            face_mesh_url=urls.get(v.face_mesh_path) if v.face_mesh_path else None,
            face_texture_url=urls.get(v.face_texture_path) if v.face_texture_path else None,
            building=building,
        )
        return JSONResponse(body.to_json())

    @app.get("/v1/avatars/{user_id}/versions")
    def versions(user_id: str) -> Response:
        if not UUID.match(user_id):
            return _bad_user()
        return JSONResponse([to_version(r).to_json() for r in store.versions(user_id)])

    @app.delete("/v1/avatars/{user_id}", status_code=204)
    def delete(user_id: str) -> Response:
        if not UUID.match(user_id):
            return _bad_user()
        files = store.delete_user(user_id)
        log("info", "avatar deleted", userId=user_id, files=files)
        return Response(status_code=204)

    return app


def _production_app() -> FastAPI:
    from .worker import Worker

    route_library_logs()
    env = read_env()

    def start() -> Callable[[], None]:
        # The worker gets its own Supabase client (its HTTP connections stay off the request path).
        worker = Worker(SupabaseStore(str(env.supabase_url), env.supabase_secret_key, env.storage_bucket), env).start()
        log("info", "avatar service started", port=env.port, version=VERSION)
        return worker.stop

    return create_app(SupabaseStore(str(env.supabase_url), env.supabase_secret_key, env.storage_bucket), env.service_secret, on_start=start)


def __getattr__(name: str) -> Any:
    # `uvicorn app.main:app` builds the real app lazily, so importing this module (tests) needs no env.
    if name == "app":
        globals()["app"] = _production_app()
        return globals()["app"]
    raise AttributeError(name)
