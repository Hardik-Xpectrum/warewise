from fastapi import FastAPI
from fastapi.testclient import TestClient
from warewise_contracts import sign_service_token

from app.auth import service_auth

secret = "s" * 40
app = FastAPI()
app.middleware("http")(service_auth(secret, prefix="/x"))


@app.get("/x")
def x():
    return "ok"


@app.post("/x")
def x_post():
    return "ok"


client = TestClient(app)


def call(auth=None, method="GET"):
    return client.request(method, "/x", headers={"authorization": auth} if auth else {})


def test_lets_web_in():
    assert call(f"Service {sign_service_token('web', 'avatar', secret)}").status_code == 200


def test_rejects_bad_tokens_as_problems():
    for auth in (
        None,
        f"Service {sign_service_token('web', 'tryon', secret)}",
        f"Service {sign_service_token('web', 'avatar', 'x' * 40)}",
        f"Service {sign_service_token('web', 'avatar', secret, -10)}",
        "Service garbage",
    ):
        res = call(auth)
        assert res.status_code == 401
        assert res.headers["content-type"] == "application/problem+json"
        assert res.json()["type"] == "/errors/unauthorized" and res.json()["status"] == 401


def test_forbids_other_senders():
    assert call(f"Service {sign_service_token('vision', 'avatar', secret)}").status_code == 403
    # tryon may read, not write
    assert call(f"Service {sign_service_token('tryon', 'avatar', secret)}").status_code == 200
    assert call(f"Service {sign_service_token('tryon', 'avatar', secret)}", "POST").status_code == 403
