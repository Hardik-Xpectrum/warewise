from fastapi.testclient import TestClient
from warewise_contracts import JobAccepted, Problem, sign_service_token

from app.main import AppDeps, create_app, parse_process_request
from tests.conftest import ITEM, JOB, USER
from tests.memory_store import MemoryJobStore

SECRET = "x" * 32
BODY = {"jobId": JOB, "userId": USER, "itemId": ITEM, "imagePath": f"{USER}/originals/{ITEM}.jpg"}


class Setup:
    def __init__(self):
        self.store = MemoryJobStore()
        self.queued = 0

        def kick():
            self.queued += 1

        self.client = TestClient(create_app(AppDeps(store=self.store, secret=SECRET, on_job_queued=kick)))

    def call(self, method, path, body=None, token: str | None = "default"):
        if token == "default":
            token = sign_service_token("web", "vision", SECRET)
        headers = {"content-type": "application/json"}
        if token:
            headers["authorization"] = f"Service {token}"
        content = body if isinstance(body, str) else None
        return self.client.request(method, path, headers=headers, content=content, json=None if content or body is None else body)


def test_parse_accepts_valid():
    assert parse_process_request(BODY)[0] is not None


def test_parse_refuses_other_folder():
    other = "99999999-9999-4999-8999-999999999999"
    req, detail = parse_process_request({**BODY, "imagePath": f"{other}/originals/x.jpg"})
    assert req is None and "own folder" in detail


def test_parse_refuses_traversal_and_bad_ids():
    assert parse_process_request({**BODY, "imagePath": f"{USER}/../x.jpg"})[0] is None
    req, detail = parse_process_request({**BODY, "jobId": "nope"})
    assert req is None and "jobId" in detail
    assert parse_process_request(None)[0] is None


def test_health_needs_no_token():
    res = Setup().call("GET", "/health", token=None)
    assert res.status_code == 200
    assert res.json()["ok"] is True and res.json()["service"] == "vision"


def test_refuses_bad_tokens():
    s = Setup()
    for token in [None, sign_service_token("web", "tryon", SECRET), sign_service_token("web", "vision", SECRET, -10),
                  sign_service_token("web", "vision", "y" * 32)]:
        res = s.call("POST", "/v1/items/process", BODY, token=token)
        assert res.status_code == 401
        assert Problem.model_validate(res.json()).status == 401
        assert res.headers["content-type"].startswith("application/problem+json")


def test_refuses_other_callers():
    res = Setup().call("GET", f"/v1/jobs/{JOB}", token=sign_service_token("tryon", "vision", SECRET))
    assert res.status_code == 403


def test_queues_and_answers_202():
    s = Setup()
    res = s.call("POST", "/v1/items/process", BODY)
    assert res.status_code == 202
    assert JobAccepted.model_validate(res.json()).to_json() == {"jobId": JOB, "status": "queued", "cached": False}
    assert s.store.rows[JOB].status == "queued"
    assert s.queued == 1


def test_idempotent_by_job_id():
    s = Setup()
    s.call("POST", "/v1/items/process", BODY)
    s.store.rows[JOB].status = "done"
    res = s.call("POST", "/v1/items/process", BODY)
    assert res.status_code == 202 and res.json()["status"] == "done"
    assert len(s.store.rows) == 1 and s.queued == 1


def test_reused_job_id_conflicts():
    s = Setup()
    s.call("POST", "/v1/items/process", BODY)
    res = s.call("POST", "/v1/items/process", {**BODY, "itemId": "44444444-4444-4444-8444-444444444444"})
    assert res.status_code == 409


def test_bad_bodies_are_400_problems():
    s = Setup()
    assert s.call("POST", "/v1/items/process", "{not json").status_code == 400
    res = s.call("POST", "/v1/items/process", {**BODY, "userId": "x"})
    assert res.status_code == 400
    assert "problem+json" in res.headers["content-type"]


def test_job_status_and_404():
    s = Setup()
    s.call("POST", "/v1/items/process", BODY)
    body = s.call("GET", f"/v1/jobs/{JOB}").json()
    assert body["jobId"] == JOB and body["status"] == "queued" and body["result"] is None
    assert body["tags"] is None and body["attempts"] == 0
    assert s.call("GET", "/v1/jobs/55555555-5555-4555-8555-555555555555").status_code == 404
    assert s.call("GET", "/v1/jobs/not-a-uuid").status_code == 400


def test_unknown_route_is_problem():
    res = Setup().call("GET", "/nope", token=None)
    assert res.status_code == 404 and res.json()["status"] == 404


def test_delete_user():
    s = Setup()
    s.call("POST", "/v1/items/process", BODY)
    res = s.call("DELETE", f"/v1/users/{USER}")
    assert res.status_code == 204
    assert not s.store.rows
