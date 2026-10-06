"""The build job.

Engines take 1–3 minutes, so a job is resumable: it submits to the first engine that accepts the
scan, saves the engine's task (provider_ref) on the job, polls within a time budget, and if the
model isn't ready yet hands the job back to the queue to resume on a later tick without asking
the engine again. The finished GLB is checked and normalised with trimesh before it is stored.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from warewise_contracts import AvatarFailed

from .config import AiConfig, chain_for, is_multi_view, load_ai_config
from .engines import Views, download_glb, poll_3d, submit_3d
from .failure import chain_failure
from .glb import MAX_GLB_BYTES, BadModel, has_colours, has_texture, load_scene, normalise, with_texture
from .images import BadImage, alpha_mask, prepare_cutout, texture_image
from .log import error_text, log
from .measure import DEFAULT_HEIGHT_CM, Measurements, estimate_measurements
from .paint import paint_glb
from .store import JobRow, Store, iso, mesh_path, now_iso
from .versions import Built, version_contents

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_ATTEMPTS = 3  # unexpected errors (Storage down, a crash mid-tick) before giving up
POLL_EVERY_S = 3.0
RESUME_AFTER_S = 20


@dataclass
class JobDeps:
    store: Store
    config: AiConfig | None = None
    poll_budget_s: float | None = None


class Permanent(Exception):
    """The user's input can't be built; retrying won't help."""


def _later(seconds: float) -> str:
    return iso(datetime.now(UTC) + timedelta(seconds=seconds))


def load_views(store: Store, job: JobRow) -> Views:
    v = job["request"]["views"]

    def get(p: str | None) -> bytes | None:
        return prepare_cutout(store.download(p, MAX_IMAGE_BYTES)) if p else None

    return Views(front=get(v["front"]) or b"", back=get(v.get("back")), left=get(v.get("left")), right=get(v.get("right")))


def measurements_for(job: JobRow, views: Views | None) -> Measurements:
    req = job["request"]
    height, sizes = req.get("heightCm"), req.get("sizes")
    if not views:
        return estimate_measurements(height, sizes)
    side = views.left or views.right  # left first, as in the TypeScript service
    return estimate_measurements(height, sizes, front=alpha_mask(views.front), side=alpha_mask(side) if side else None)


def fail(store: Store, job: JobRow, message: str, retryable: bool) -> None:
    event = AvatarFailed(job_id=job["job_id"], user_id=job["user_id"], message=message, retryable=retryable).to_json()
    store.update_job(
        job["job_id"],
        {"status": "failed", "last_error": message, "provider_ref": None, "event": event, "event_attempts": 0, "event_after": now_iso()},
    )
    log("warn", "avatar build failed", jobId=job["job_id"], userId=job["user_id"], message=message, retryable=retryable)


def finish(store: Store, job: JobRow, built: Built, uploaded: list[str]) -> int | None:
    previous = store.latest_version(job["user_id"])
    version = store.complete_job(job, version_contents(job["kind"], previous, built))
    if version is None:
        # The user's avatar was deleted while this job ran: don't leave its files behind.
        store.remove(uploaded)
        log("info", "job deleted while running; files removed", jobId=job["job_id"], userId=job["user_id"])
        return None
    log("info", "avatar version ready", jobId=job["job_id"], userId=job["user_id"], version=version, engine=built.engine_key or "face", textured=built.textured)
    return version


def process_face(store: Store, job: JobRow) -> None:
    """A face scan: the phone made the mesh (MediaPipe); check it, add its texture, copy it under
    our prefix and attach it to a new version that keeps the previous body."""
    req = job["request"]
    glb = store.download(req["faceMesh"], MAX_GLB_BYTES)
    try:
        load_scene(glb, "The face scan")
    except BadModel as err:
        log("warn", "face mesh rejected", jobId=job["job_id"], userId=job["user_id"], error=str(err))
        raise Permanent("The face scan isn't a usable 3D model (a GLB file under 50 MB is needed). Please scan again.") from err
    uploaded: list[str] = []
    tex_path: str | None = None
    if req.get("faceTexture"):
        try:
            img, fmt = texture_image(store.download(req["faceTexture"], MAX_IMAGE_BYTES))
        except BadImage as err:
            raise Permanent("The face texture isn't a readable image") from err
        buf = io.BytesIO()
        img.save(buf, "JPEG" if fmt == "jpeg" else "PNG", **({"quality": 92} if fmt == "jpeg" else {}))
        tex_path = mesh_path(job["user_id"], job["job_id"], f"face-texture.{'jpg' if fmt == 'jpeg' else 'png'}")
        store.upload(tex_path, buf.getvalue(), f"image/{fmt}")
        uploaded.append(tex_path)
        glb = with_texture(glb, img)
        log("info", "face texture stored", jobId=job["job_id"], userId=job["user_id"], embedded=has_texture(glb))
    path = mesh_path(job["user_id"], job["job_id"], "face.glb")
    store.upload(path, glb, "model/gltf-binary")
    uploaded.append(path)
    m = measurements_for(job, None)
    finish(store, job, Built(measurements=m.values, sources=m.sources, face_mesh_path=path, face_texture_path=tex_path), uploaded)


def store_body(store: Store, job: JobRow, glb: bytes, engine_key: str, views: Views) -> None:
    """Checks, normalises (height, feet on y = 0, centred) and stores the engine's model."""
    req = job["request"]
    height_m = (req.get("heightCm") or DEFAULT_HEIGHT_CM) / 100
    ctx = {"jobId": job["job_id"], "userId": job["user_id"], "engine": engine_key}
    if not has_texture(glb) and (views.back or views.left or views.right):
        # A bare shape from a 360° scan: colour it from the scan's own photos. Best effort; a
        # grey model is still a usable body.
        try:
            named = {"front": views.front, "back": views.back, "left": views.left, "right": views.right}
            glb, report = paint_glb(glb, {k: v for k, v in named.items() if v})
            log("info", "model painted from the scan", **ctx, **report.as_log())
        except Exception as err:  # noqa: BLE001
            log("warn", "painting the model failed; keeping it grey", **ctx, error=error_text(err))
    out, before, after = normalise(glb, height_m, "The 3D service")
    path = mesh_path(job["user_id"], job["job_id"], "body.glb")
    store.upload(path, out, "model/gltf-binary")
    log("info", "model stored", **ctx, before=before.as_log(), after=after.as_log())
    m = measurements_for(job, views)
    built = Built(measurements=m.values, sources=m.sources, mesh_path=path, engine_key=engine_key, textured=has_texture(out) or has_colours(out))
    finish(store, job, built, [path])


def process_job(job: JobRow, deps: JobDeps) -> None:
    store = deps.store
    config = deps.config or load_ai_config()
    ctx = {"jobId": job["job_id"], "userId": job["user_id"]}
    try:
        if job["kind"] == "face":
            return process_face(store, job)

        views: Views | None = None
        ref = job.get("provider_ref")
        # 1. Submit to the first engine that accepts the scan (unless a previous tick already did).
        if not ref:
            try:
                views = load_views(store, job)
            except BadImage as err:
                raise Permanent(str(err)) from err
            seen: list[str] = []
            for key, engine in chain_for(job["kind"], config):
                if is_multi_view(engine) and not (views.back or views.left or views.right):
                    continue
                if not store.take_quota(key, engine.limits.per_day):
                    seen.append(f"{key}: daily quota used")
                    continue
                started = time.monotonic()
                try:
                    ref = submit_3d(key, engine, views)
                    log("info", "engine accepted the scan", **ctx, engine=key, ms=round((time.monotonic() - started) * 1000), note=ref.get("note"))
                    store.update_job(job["job_id"], {"provider_ref": ref})
                    break
                except Exception as err:  # noqa: BLE001
                    seen.append(f"{key}: {error_text(err)}")
                    log("warn", "engine submit failed", **ctx, engine=key, ms=round((time.monotonic() - started) * 1000), error=seen[-1])
            if not ref:
                message, retryable = chain_failure(seen)
                return fail(store, job, message, retryable)

        # 2. Poll until done within this tick's budget; otherwise resume on a later tick.
        engine = config.engines.get(ref["engineKey"])
        if engine is None:
            return fail(store, job, f"Engine {ref['engineKey']} is no longer configured", True)
        budget = deps.poll_budget_s if deps.poll_budget_s is not None else config.poll_budget_ms / 1000
        started = time.monotonic()
        while True:
            r = poll_3d(engine, ref)
            if r.state == "failed":
                return fail(store, job, (r.error or "The 3D service failed")[:300], True)
            if r.state == "done":
                try:
                    glb = r.glb if r.glb is not None else download_glb(r.glb_url or "")
                    if views is None:
                        views = load_views(store, job)
                    return store_body(store, job, glb, ref["engineKey"], views)
                except BadModel as err:
                    # The engine's file is unusable; asking for it again gives the same file.
                    return fail(store, job, f"The 3D service returned an unusable model: {err}"[:300], True)
            if time.monotonic() - started > budget:
                store.update_job(job["job_id"], {"status": "running", "run_after": _later(RESUME_AFTER_S)})
                return None
            time.sleep(POLL_EVERY_S)
    except Permanent as err:
        return fail(store, job, str(err), False)
    except Exception as err:  # noqa: BLE001
        attempts = int(job.get("attempts") or 0) + 1
        log("error", "avatar job error", **ctx, attempts=attempts, error=error_text(err))
        if attempts >= MAX_ATTEMPTS:
            return fail(store, job, "Building the avatar failed. Please try again later.", True)
        # Back off, then resume (a saved provider_ref means the engine isn't asked twice).
        store.update_job(job["job_id"], {"attempts": attempts, "last_error": error_text(err)[:500], "run_after": _later(attempts * 60)})
    return None
