import pytest
from fastapi.testclient import TestClient
from warewise_contracts import RenderStatus, render_cache_key, sign_service_token

from app import __version__
from app.main import create_app
from tests.conftest import JOB, USER, FakeStore, render_body

SECRET = "x" * 40


def auth(iss: str = "web", secret: str = SECRET) -> dict:
    return {"authorization": f"Service {sign_service_token(iss, 'tryon', secret)}"}


class Wake:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self) -> None:
        self.calls += 1


def client(store: FakeStore | None = None, wake: Wake | None = None, engine: str = "ai") -> TestClient:
    return TestClient(create_app(store=store or FakeStore(), secret=SECRET, wake=wake or Wake(), engine=engine))  # type: ignore[arg-type]


def test_health_is_open():
    assert client().get("/health").json() == {"ok": True, "service": "tryon", "version": __version__}


def test_refuses_missing_forged_and_non_web_tokens_with_a_problem_body():
    c = client()
    none = c.get(f"/v1/renders/{JOB}")
    assert none.status_code == 401
    assert none.headers["content-type"] == "application/problem+json"
    assert none.json() == {"type": "/errors/unauthorized", "title": "Unauthorized", "status": 401, "detail": "missing token"}
    assert c.get("/v1/renders/x", headers=auth("web", "y" * 40)).status_code == 401
    assert c.get("/v1/renders/x", headers=auth("vision")).status_code == 403
    assert c.post("/v1/renders", json=render_body()).status_code == 401


def test_queues_a_new_render_once_even_when_the_job_id_is_resent():
    wake = Wake()
    store = FakeStore()
    c = client(store, wake)
    first = c.post("/v1/renders", json=render_body(), headers=auth())
    assert first.status_code == 202
    assert first.json() == {"jobId": JOB, "status": "queued", "cached": False}
    assert c.post("/v1/renders", json=render_body(), headers=auth()).json() == {"jobId": JOB, "status": "queued", "cached": False}
    assert wake.calls == 1
    row = store.rows[JOB]
    assert row["cache_key"] == render_cache_key(f"{USER}/avatar/front.webp", None, render_body()["garments"], "ai")
    assert row["request"]["pose"] is None and row["request"]["garments"][0]["itemId"]


def test_the_engine_mode_is_part_of_the_cache_key():
    a, b = FakeStore(), FakeStore()
    client(a, engine="ai").post("/v1/renders", json=render_body(), headers=auth())
    client(b, engine="composite").post("/v1/renders", json=render_body(), headers=auth())
    assert a.rows[JOB]["cache_key"] != b.rows[JOB]["cache_key"]


def test_answers_a_cache_hit_at_once_and_queues_its_tryon_ready_event():
    body = render_body()
    store = FakeStore()
    old = "55555555-5555-4555-8555-555555555555"
    key = render_cache_key(body["personImagePath"], None, body["garments"], "ai")
    store.insert({"job_id": old, "user_id": USER, "cache_key": key, "request": {}, "status": "done", "cacheable": True,
                  "render_path": f"{USER}/tryon/old.webp", "note": "AI dressed the top."})
    wake = Wake()
    c = client(store, wake)
    res = c.post("/v1/renders", json=body, headers=auth())
    assert res.status_code == 202
    assert res.json() == {"jobId": JOB, "status": "done", "cached": True}
    row = store.rows[JOB]
    assert (row["status"], row["render_path"], row["cached_from"]) == ("done", f"{USER}/tryon/old.webp", old)
    assert row["event"] == {"type": "tryon.ready", "jobId": JOB, "userId": USER, "renderPath": f"{USER}/tryon/old.webp", "note": "AI dressed the top."}
    assert wake.calls == 1  # so the event goes out now
    status = c.get(f"/v1/renders/{JOB}", headers=auth()).json()
    RenderStatus.model_validate(status)
    assert status["status"] == "done" and status["renderPath"] == f"{USER}/tryon/old.webp" and status["textureForAvatar"] is None
    # Resending the cached job keeps saying cached.
    assert c.post("/v1/renders", json=body, headers=auth()).json() == {"jobId": JOB, "status": "done", "cached": True}


def test_status_carries_both_avatar_textures():
    store = FakeStore()
    store.insert({"job_id": JOB, "user_id": USER, "cache_key": "k", "request": {}, "status": "done", "render_path": f"{USER}/tryon/{JOB}.webp",
                  "texture": {"version": 2, "front": f"{USER}/tryon/{JOB}-v2-front.png", "back": f"{USER}/tryon/{JOB}-v2-back.png"}})
    status = client(store).get(f"/v1/renders/{JOB}", headers=auth()).json()
    assert status["textureForAvatar"] == {"version": 2, "texturePath": f"{USER}/tryon/{JOB}-v2-front.png", "backTexturePath": f"{USER}/tryon/{JOB}-v2-back.png"}


@pytest.mark.parametrize("payload", [{"nope": 1}, None, "not json"])
def test_rejects_invalid_requests(payload):
    c = client()
    if payload == "not json":
        res = c.post("/v1/renders", content=b"{oops", headers={**auth(), "content-type": "application/json"})
    else:
        res = c.post("/v1/renders", json=payload, headers=auth())
    assert res.status_code == 400
    assert res.headers["content-type"] == "application/problem+json"
    assert res.json()["title"] == "Invalid render request"


def test_rejects_paths_outside_the_users_folder():
    other = "99999999-9999-4999-8999-999999999999"
    res = client().post("/v1/renders", json=render_body(personImagePath=f"{other}/avatar/front.webp"), headers=auth())
    assert res.status_code == 400 and "own folder" in res.json()["detail"]


def test_refuses_a_reused_job_id():
    c = client()
    c.post("/v1/renders", json=render_body(), headers=auth())
    other = render_body()
    other["garments"] = other["garments"][:1]
    res = c.post("/v1/renders", json=other, headers=auth())
    assert res.status_code == 409 and res.json()["title"] == "Job id already used"


def test_404s_unknown_renders_and_routes_and_deletes_a_users_renders():
    store = FakeStore()
    c = client(store)
    assert c.get(f"/v1/renders/{JOB}", headers=auth()).status_code == 404
    assert c.get("/v1/renders/not-a-uuid", headers=auth()).status_code == 400
    assert c.get("/v1/nothing", headers=auth()).json()["status"] == 404
    assert c.delete(f"/v1/users/{USER}/renders", headers=auth()).status_code == 204
    assert store.deleted == [USER]
    assert c.delete("/v1/users/bad/renders", headers=auth()).status_code == 400
