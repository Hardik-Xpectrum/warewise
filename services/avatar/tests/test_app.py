from fastapi.testclient import TestClient
from warewise_contracts import AvatarCurrent, AvatarVersion, JobAccepted, Problem, sign_service_token

from app.main import VERSION, create_app
from tests.fakes import FakeStore

secret = "s" * 40
user_id = "11111111-1111-4111-8111-111111111111"
job_id = "22222222-2222-4222-8222-222222222222"
build = {"jobId": job_id, "userId": user_id, "kind": "photo", "views": {"front": f"{user_id}/scans/front.png"}, "heightCm": 175}


def auth(iss="web"):
    return {"authorization": f"Service {sign_service_token(iss, 'avatar', secret)}"}


def make():
    store = FakeStore()
    return store, TestClient(create_app(store, secret))


def test_health_without_auth():
    _, c = make()
    assert c.get("/health").json() == {"ok": True, "service": "avatar", "version": VERSION}


def test_build_202_idempotent_and_409_on_clash():
    store, c = make()
    for _ in range(2):
        res = c.post("/v1/avatars/build", headers=auth(), json=build)
        assert res.status_code == 202
        assert JobAccepted.model_validate(res.json()).to_json() == {"jobId": job_id, "status": "queued", "cached": False}
    assert len(store.jobs) == 1
    clash = c.post("/v1/avatars/build", headers=auth(), json={**build, "kind": "face", "faceMesh": f"{user_id}/f.glb"})
    assert clash.status_code == 409 and clash.json()["type"] == "/errors/conflict"


def test_bad_builds_and_callers():
    _, c = make()
    bad = c.post("/v1/avatars/build", headers=auth(), json={k: v for k, v in build.items() if k != "views"})
    assert bad.status_code == 400 and "views.front" in bad.json()["detail"]
    assert bad.headers["content-type"] == "application/problem+json"
    Problem.model_validate(bad.json())
    assert c.post("/v1/avatars/build", headers={**auth(), "content-type": "application/json"}, content=b"{nope").status_code == 400
    assert c.post("/v1/avatars/build", headers=auth("tryon"), json=build).status_code == 403
    assert c.post("/v1/avatars/build", json=build).status_code == 401


def test_current_versions_404_and_delete():
    store, c = make()
    assert c.get(f"/v1/avatars/{user_id}", headers=auth()).status_code == 404
    assert c.get("/v1/avatars/not-a-uuid", headers=auth()).status_code == 400
    store.versions_.append({"user_id": user_id, "version": 1, "kind": "photo", "mesh_path": f"{user_id}/avatar3d/{job_id}/body.glb", "face_mesh_path": None,
                            "measurements": {"heightCm": 175}, "measurement_sources": {"heightCm": "size"}, "textured": True, "engine": "trellis",
                            "job_id": job_id, "created_at": "2026-10-04T10:00:00+00:00"})
    res = c.get(f"/v1/avatars/{user_id}", headers=auth("tryon"))
    cur = AvatarCurrent.model_validate(res.json())
    assert cur.version == 1 and cur.building is False and cur.face_mesh_url is None and "body.glb" in cur.mesh_url
    assert cur.textured and cur.measurement_sources == {"heightCm": "size"} and cur.created_at == "2026-10-04T10:00:00.000Z"
    vs = c.get(f"/v1/avatars/{user_id}/versions", headers=auth()).json()
    assert len(vs) == 1 and AvatarVersion.model_validate(vs[0]).engine == "trellis"
    assert c.delete(f"/v1/avatars/{user_id}", headers=auth("tryon")).status_code == 403
    assert c.delete(f"/v1/avatars/{user_id}", headers=auth()).status_code == 204
    assert store.versions_ == []


def test_404_says_building_and_unknown_routes_are_problems():
    store, c = make()
    c.post("/v1/avatars/build", headers=auth(), json=build)
    res = c.get(f"/v1/avatars/{user_id}", headers=auth())
    assert res.status_code == 404 and res.json()["detail"] == "The first build is in progress"
    nf = c.get("/nope")
    assert nf.status_code == 404 and nf.headers["content-type"] == "application/problem+json"
    assert c.get("/v1/nope").status_code == 401  # auth first, like the TypeScript service
