"""The worker pipeline end to end on the in-memory store with the mock engine."""

import io
import threading

import numpy as np
import pytest
import trimesh
from PIL import Image, ImageDraw
from warewise_contracts import AvatarFailed, AvatarReady, BuildAvatarRequest

from app import engines
from app.config import load_ai_config
from app.events import EVENT, deliver_events
from app.glb import has_texture, load_scene
from app.jobs import JobDeps, process_job
from app.versions import VersionContents
from tests.fakes import FakeStore

U = "11111111-1111-4111-8111-111111111111"
cfg = load_ai_config()


def cutout(w_body=60, depth=False) -> bytes:
    """A standing figure on a transparent background, 400 px tall."""
    img = Image.new("RGBA", (200, 420), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((85, 10, 115, 50), fill=(90, 60, 40, 255))  # head
    w = 30 if depth else w_body
    d.rectangle((100 - w // 2, 50, 100 + w // 2, 230), fill=(200, 160, 120, 255))  # torso
    d.rectangle((100 - w // 2, 230, 98, 410), fill=(40, 40, 120, 255))  # legs
    d.rectangle((102, 230, 100 + w // 2, 410), fill=(40, 40, 120, 255))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def job(store, kind, job_id, **extra):
    req = BuildAvatarRequest.model_validate({"jobId": job_id, "userId": U, "kind": kind, "heightCm": 180, **extra})
    store.enqueue(req)
    return store.claim(330)


@pytest.fixture(autouse=True)
def mock_only(monkeypatch):
    monkeypatch.setenv("AVATAR_ENGINES", "mock-3d")


def views_files(store):
    for n in ("front", "back", "left", "right"):
        store.files[f"{U}/scans/{n}.png"] = cutout(depth=n in ("left", "right"))
    return {n: f"{U}/scans/{n}.png" for n in ("front", "back", "left", "right")}


def test_body360_builds_normalised_version_with_sources():
    store = FakeStore()
    j = job(store, "body360", "a0000000-0000-4000-8000-000000000001", views=views_files(store))
    process_job(j, JobDeps(store=store, config=cfg))
    v = store.latest_version(U)
    # The bare shape is painted from the scan's own photos.
    assert v["version"] == 1 and v["engine"] == "mock-3d" and v["textured"] is True
    lo, hi = load_scene(store.files[v["mesh_path"]]).bounds
    assert hi[1] - lo[1] == pytest.approx(1.8) and lo[1] == pytest.approx(0, abs=1e-6)
    assert v["measurements"]["heightCm"] == 180 and v["measurement_sources"]["heightCm"] == "size"
    assert v["measurement_sources"]["chestDepthCm"] == "measured"
    assert set(v["measurements"]) == set(v["measurement_sources"])
    AvatarReady.model_validate(store.jobs[j["job_id"]]["event"])


def test_face_keeps_body_and_embeds_texture():
    store = FakeStore()
    j = job(store, "photo", "a0000000-0000-4000-8000-000000000002", views={"front": views_files(store)["front"]})
    process_job(j, JobDeps(store=store, config=cfg))
    body = store.latest_version(U)
    face = trimesh.creation.icosphere(subdivisions=1, radius=0.1)
    face.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(3).random((len(face.vertices), 2)))
    store.files[f"{U}/scans/face.glb"] = bytes(trimesh.Scene(face).export(file_type="glb"))
    tex = io.BytesIO()
    Image.new("RGB", (32, 32), (210, 170, 150)).save(tex, "JPEG")
    store.files[f"{U}/scans/face.jpg"] = tex.getvalue()
    j2 = job(store, "face", "a0000000-0000-4000-8000-000000000003", faceMesh=f"{U}/scans/face.glb", faceTexture=f"{U}/scans/face.jpg")
    process_job(j2, JobDeps(store=store, config=cfg))
    v2 = store.latest_version(U)
    assert v2["version"] == 2 and v2["mesh_path"] == body["mesh_path"] and v2["engine"] == "mediapipe-face"
    assert v2["measurements"] == body["measurements"]
    assert has_texture(store.files[v2["face_mesh_path"]])
    assert f"{U}/avatar3d/a0000000-0000-4000-8000-000000000003/face-texture.jpg" in store.files


def test_bad_face_mesh_fails_at_once_without_retry():
    store = FakeStore()
    store.files[f"{U}/scans/face.glb"] = b"<html>not a model</html>"
    j = job(store, "face", "a0000000-0000-4000-8000-000000000004", faceMesh=f"{U}/scans/face.glb")
    process_job(j, JobDeps(store=store, config=cfg))
    row = store.jobs[j["job_id"]]
    ev = AvatarFailed.model_validate(row["event"])
    assert row["status"] == "failed" and ev.retryable is False and "isn't a usable 3D model" in ev.message


def test_no_engine_fails_with_friendly_message(monkeypatch):
    monkeypatch.setenv("AVATAR_ENGINES", "nope")
    store = FakeStore()
    j = job(store, "photo", "a0000000-0000-4000-8000-000000000005", views={"front": views_files(store)["front"]})
    process_job(j, JobDeps(store=store, config=cfg))
    ev = AvatarFailed.model_validate(store.jobs[j["job_id"]]["event"])
    assert ev.message == "No 3D service is set up for this kind of scan." and ev.retryable is False


def test_unexpected_error_backs_off_then_fails():
    store = FakeStore()
    j = job(store, "photo", "a0000000-0000-4000-8000-000000000006", views={"front": f"{U}/scans/missing.png"})
    for attempt in (1, 2):
        process_job(j, JobDeps(store=store, config=cfg))
        assert store.jobs[j["job_id"]]["attempts"] == attempt and store.jobs[j["job_id"]]["status"] == "running"
        j = dict(store.jobs[j["job_id"]])
    process_job(j, JobDeps(store=store, config=cfg))
    assert store.jobs[j["job_id"]]["status"] == "failed"


def test_resumed_job_does_not_submit_again(monkeypatch):
    store = FakeStore()
    j = job(store, "photo", "a0000000-0000-4000-8000-000000000007", views={"front": views_files(store)["front"]})
    j["provider_ref"] = {"engineKey": "mock-3d", "task": "mock"}
    monkeypatch.setattr(engines, "submit_3d", lambda *a: pytest.fail("submitted twice"))
    process_job(j, JobDeps(store=store, config=cfg))
    assert store.latest_version(U)["version"] == 1


def test_version_allocation_is_serialised_per_user():
    store = FakeStore()
    ids = [f"b0000000-0000-4000-8000-00000000000{i}" for i in range(8)]
    for i in ids:
        store.enqueue(BuildAvatarRequest.model_validate({"jobId": i, "userId": U, "kind": "photo", "views": {"front": f"{U}/f.png"}}))
    jobs = [dict(store.jobs[i]) for i in ids]
    v = VersionContents(None, None, None, {}, {}, False, "mock-3d")
    out: list[int] = []
    threads = [threading.Thread(target=lambda jj=jj: out.append(store.complete_job(jj, v))) for jj in jobs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(out) == list(range(1, 9))
    assert store.complete_job(jobs[0], v) == [r["version"] for r in store.versions_ if r["job_id"] == jobs[0]["job_id"]][0]  # idempotent


def test_events_are_delivered_signed_and_retried():
    store = FakeStore()
    j = job(store, "photo", "a0000000-0000-4000-8000-000000000008", views={"front": views_files(store)["front"]})
    process_job(j, JobDeps(store=store, config=cfg))
    seen = []

    def down(url, headers, body):
        return 503

    assert deliver_events(store, "http://web.test", "s" * 40, down) == 0
    row = store.jobs[j["job_id"]]
    assert row["event_attempts"] == 1 and row["event_after"] and not row.get("event_sent_at")
    row["event_after"] = "now"

    def up(url, headers, body):
        seen.append((url, headers, body))
        return 204

    assert deliver_events(store, "http://web.test", "s" * 40, up) == 1
    url, headers, body = seen[0]
    assert url == "http://web.test/api/internal/events" and headers["authorization"].startswith("Service avatar.web.")
    assert EVENT.validate_python(body).type == "avatar.ready"
