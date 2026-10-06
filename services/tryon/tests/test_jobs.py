import io

import httpx
from PIL import Image

from app.config import AiConfig
from app.jobs import deliver_events, process_render
from app.request import validate_render
from tests.conftest import JOB, USER, FakeStore, render_body

OFFLINE = AiConfig.model_validate({"jobs": {"tryon": {"chain": ["composite"]}}, "models": {"composite": {"provider": "composite", "model": "pillow"}}})


def png(w: int, h: int, color: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def queued(store: FakeStore, **over: object) -> dict:
    ok, req = validate_render(render_body(**over))
    assert ok and isinstance(req, dict)
    store.insert({"job_id": JOB, "user_id": USER, "cache_key": "k", "status": "queued", "request": req})
    row = store.claim(60)
    assert row
    return row


def no_model(*_: object) -> bytes:
    raise AssertionError("no model call expected")


def files() -> dict[str, bytes]:
    return {
        f"{USER}/avatar/front.webp": png(300, 600, "#c8a080"),
        f"{USER}/clean/a.webp": png(120, 120, "#c02020"),
        f"{USER}/cutout/a.webp": png(120, 120, "#c02020"),
        f"{USER}/clean/b.webp": png(100, 140, "#2040a0"),
    }


def test_a_missing_avatar_photo_fails_with_a_tryon_failed_event():
    store = FakeStore()
    process_render(queued(store), store, OFFLINE, lambda m: True, no_model)
    row = store.rows[JOB]
    assert (row["status"], row["error"]) == ("failed", "The avatar photo was deleted")
    assert row["event"] == {"type": "tryon.failed", "jobId": JOB, "userId": USER, "message": "The avatar photo was deleted", "quota": False}


def test_the_composite_render_is_stored_with_both_textures_and_a_ready_event():
    store = FakeStore(files())
    process_render(queued(store, avatarVersion=3), store, OFFLINE, lambda m: True, no_model)
    row = store.rows[JOB]
    assert row["status"] == "done" and row["cacheable"] is True
    assert row["render_path"] == f"{USER}/tryon/{JOB}.webp"
    assert row["texture"] == {"version": 3, "front": f"{USER}/tryon/{JOB}-v3-front.png", "back": f"{USER}/tryon/{JOB}-v3-back.png"}
    for path in (row["render_path"], row["texture"]["front"], row["texture"]["back"]):
        assert path in store.files
    assert row["event"]["type"] == "tryon.ready" and row["event"]["note"] == "Composite preview (offline engine)."


def test_a_queued_job_reuses_a_render_that_finished_meanwhile():
    store = FakeStore()
    store.insert({"job_id": "55555555-5555-4555-8555-555555555555", "user_id": USER, "cache_key": "k", "request": {}, "status": "done",
                  "cacheable": True, "render_path": f"{USER}/tryon/old.webp", "note": "n"})
    process_render(queued(store), store, OFFLINE, lambda m: True, no_model)
    row = store.rows[JOB]
    assert (row["status"], row["render_path"], row["cached_from"]) == ("done", f"{USER}/tryon/old.webp", "55555555-5555-4555-8555-555555555555")


def test_a_storage_error_requeues_then_gives_up():
    class Broken(FakeStore):
        def download(self, path: str) -> bytes | None:
            raise ConnectionError("storage down")

    store = Broken()
    row = queued(store)
    process_render(row, store, OFFLINE, lambda m: True, no_model)
    assert store.rows[JOB]["status"] == "queued" and "storage down" in store.rows[JOB]["error"]
    process_render({**row, "attempts": 3}, store, OFFLINE, lambda m: True, no_model)
    assert store.rows[JOB]["error"] == "AI try-on failed. Please try again later."


def test_events_are_delivered_once_and_retried_with_backoff():
    store = FakeStore()
    process_render(queued(store), store, OFFLINE, lambda m: True, no_model)  # failed: missing photo
    statuses = iter([500, 204])
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(next(statuses)))) as client:
        assert deliver_events(store, "http://web", "s" * 40, client) == 0
        assert store.rows[JOB]["event_attempts"] == 1 and store.rows[JOB]["event_after"]
        assert deliver_events(store, "http://web", "s" * 40, client) == 1
    assert store.rows[JOB]["event_sent_at"]
