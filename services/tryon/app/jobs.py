"""Runs one claimed render: download the photos, dress the outfit, store the render (and the 3D
textures when asked), then queue the event for the web app."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
from warewise_contracts import RenderStatus

from app.cache import decide_render
from app.config import AiConfig, ModelConfig
from app.engine import EngineDeps, EngineGarment, EngineInput, RunPass, TryOnError, dress_outfit
from app.events import next_event_at, send_event
from app.log import error_message, log
from app.store import Store, now_iso
from app.texture import avatar_textures

MAX_ATTEMPTS = 3


def to_status(row: dict) -> dict:
    t = row.get("texture")
    status = RenderStatus.model_validate({
        "jobId": row["job_id"],
        "status": row["status"],
        "cacheKey": row["cache_key"],
        "renderPath": row.get("render_path"),
        "textureForAvatar": {"version": t["version"], "texturePath": t["front"], "backTexturePath": t.get("back")} if t else None,
        "note": row.get("note"),
        "error": row.get("error"),
    })
    return status.to_json()


def ready_event(job_id: str, user_id: str, render_path: str, note: str | None) -> dict:
    return {"type": "tryon.ready", "jobId": job_id, "userId": user_id, "renderPath": render_path, "note": note}


def _finished_with(event: dict) -> dict:
    now = now_iso()
    return {"event": event, "event_after": now, "finished_at": now}


def process_render(row: dict, store: Store, config: AiConfig, has_token: Callable[[ModelConfig], bool], run_pass: RunPass) -> None:
    """`config`, `has_token` and `run_pass` are the engine deps (fakes in tests)."""
    req = row["request"]
    job_id, user_id = row["job_id"], row["user_id"]
    ctx = {"jobId": job_id, "userId": user_id}

    def fail(message: str, quota: bool) -> None:
        log("warn", "render failed", **ctx, error=message, quota=quota)
        store.update(job_id, {"status": "failed", "error": message, "quota": quota,
                              **_finished_with({"type": "tryon.failed", "jobId": job_id, "userId": user_id, "message": message, "quota": quota})})

    # An identical render may have finished while this one waited in the queue.
    hit = decide_render(user_id, row["cache_key"], req.get("avatarVersion"), None, store.cache_hits(user_id, row["cache_key"]))
    if hit.kind == "cached" and hit.row:
        src = hit.row
        store.update(job_id, {"status": "done", "render_path": src["render_path"], "texture": src.get("texture"), "note": src.get("note"),
                              "cached_from": src["job_id"], **_finished_with(ready_event(job_id, user_id, src["render_path"], src.get("note")))})
        log("info", "render served from cache", **ctx, **{"from": src["job_id"]})
        return

    try:
        person = store.download(req["personImagePath"])
        if not person:
            return fail("The avatar photo was deleted", False)
        garments: list[EngineGarment] = []
        for g in req["garments"]:
            photo = store.download(g["imagePath"])
            if not photo:
                continue
            cutout = store.download(g["cutoutPath"]) if g.get("cutoutPath") else None
            garments.append(EngineGarment(id=g["itemId"], slot=g["slot"], description=g["description"], photo=photo, cutout=cutout))
        if not garments:
            return fail("Photos for this try-on are missing", False)

        def take_quota(key: str, model: ModelConfig) -> bool:
            return store.take_quota(key, model.limits.per_minute, model.limits.per_day)

        started = time.monotonic()
        result = dress_outfit(
            EngineInput(person=person, pose=req.get("pose"), garments=garments),
            EngineDeps(config=config, has_token=has_token, take_quota=take_quota, run_pass=run_pass,
                       on_attempt=lambda a: log("warn" if a.status == "error" else "info", "try-on pass", **ctx, **a.fields())),
        )

        render_path = f"{user_id}/tryon/{job_id}.webp"
        written = [render_path]
        store.upload(render_path, result.image, "image/webp")
        texture = None
        version = req.get("avatarVersion")
        if version is not None:
            front, back = avatar_textures(result.image)
            texture = {"version": version, "front": f"{user_id}/tryon/{job_id}-v{version}-front.png", "back": f"{user_id}/tryon/{job_id}-v{version}-back.png"}
            written += [texture["front"], texture["back"]]
            store.upload(texture["front"], front, "image/png")
            store.upload(texture["back"], back, "image/png")
        kept = store.update(job_id, {
            "status": "done", "render_path": render_path, "texture": texture, "note": result.note, "error": None,
            "cacheable": result.complete, **_finished_with(ready_event(job_id, user_id, render_path, result.note)),
        })
        # The user deleted their account while this ran: don't leave their render behind.
        if not kept:
            store.remove(written)
        log("info", "render done", **ctx, engine=result.engine, complete=result.complete, ms=round((time.monotonic() - started) * 1000))
    except TryOnError as err:
        fail(err.message, err.quota)
    except Exception as err:  # noqa: BLE001 - storage or network hiccup: retry the job
        log("error", "render error", **ctx, attempt=row.get("attempts"), error=error_message(err))
        attempts = int(row.get("attempts") or 1)
        if attempts >= MAX_ATTEMPTS:
            return fail("AI try-on failed. Please try again later.", False)
        # Try again in 1, then 4 minutes.
        retry_at = datetime.now(UTC) + timedelta(minutes=4 ** (attempts - 1))
        store.update(job_id, {"status": "queued", "error": error_message(err)[:300], "run_after": retry_at.isoformat()})


def deliver_events(store: Store, web_url: str, secret: str, client: httpx.Client | None = None) -> int:
    """Sends the events that are due; failed ones are retried later with backoff."""
    sent = 0
    for row in store.due_events(20):
        res = send_event(row["event"], web_url, secret, client)
        attempts = int(row.get("event_attempts") or 0) + 1
        if res.ok:
            store.update(row["job_id"], {"event_attempts": attempts, "event_sent_at": now_iso()})
            sent += 1
            continue
        nxt = next_event_at(attempts, datetime.now(UTC))
        if nxt is None:
            log("error", "event given up", jobId=row["job_id"], userId=row["user_id"], status=res.status)
        store.update(row["job_id"], {"event_attempts": attempts, "event_after": nxt.isoformat() if nxt else None})
    return sent
