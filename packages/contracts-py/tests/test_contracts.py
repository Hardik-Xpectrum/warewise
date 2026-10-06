"""The Python contract must match the TypeScript one byte for byte (vectors from packages/contracts)."""

import pytest
from pydantic import TypeAdapter, ValidationError

from warewise_contracts import (
    ItemProcessed, RenderRequest, ServiceEvent, render_cache_key, sign_service_token, verify_service_token,
)

SECRET = "test-secret-at-least-32-characters-long"
UID = "6f4a9a5a-0e85-4d1c-b8e8-325960fa650b"

# Produced by the TypeScript contract (expires in 2100).
TS_TOKEN = "web.tryon.4102444800.855164bfc3944493262537eb357586668a29116901fe529bd67d37cf85c2cbf3"
TS_CACHE_KEY = "23fd17242a6f100b1370cd84a5b37351"
TS_CACHE_KEY_NO_AVATAR = "7e01938a70033004c669efcf06d24970"


def test_verifies_a_token_signed_by_typescript():
    assert verify_service_token(f"Service {TS_TOKEN}", "tryon", SECRET).ok


def test_rejects_wrong_audience_bad_signature_and_expired():
    t = sign_service_token("web", "tryon", SECRET)
    assert verify_service_token(t, "tryon", SECRET).ok
    assert verify_service_token(t, "avatar", SECRET).reason == "wrong audience"
    assert verify_service_token(t, "tryon", "another-secret-also-long-enough-xx").reason == "bad signature"
    assert verify_service_token(sign_service_token("web", "tryon", SECRET, -10), "tryon", SECRET).reason == "expired"
    assert not verify_service_token(None, "tryon", SECRET).ok


def test_render_cache_key_matches_typescript():
    garments = [{"itemId": "b", "updatedAt": "2026-10-02"}, {"itemId": "a", "updatedAt": "2026-10-01"}]
    assert render_cache_key("u/p.png", 3, garments, "ai") == TS_CACHE_KEY
    assert render_cache_key("u/p.png", None, [{"itemId": "a", "updatedAt": "x"}], "composite") == TS_CACHE_KEY_NO_AVATAR


def test_camel_case_on_the_wire():
    req = RenderRequest.model_validate({
        "jobId": UID, "userId": UID, "personImagePath": f"{UID}/avatar/p.png", "avatarVersion": None,
        "garments": [{"itemId": UID, "slot": "top", "description": "navy shirt", "imagePath": f"{UID}/clean/a.webp", "cutoutPath": None, "updatedAt": "2026-10-01"}],
    })
    assert req.person_image_path.endswith("p.png")
    assert req.to_json()["garments"][0]["itemId"] == UID


def test_events_are_discriminated_by_type():
    ev = TypeAdapter(ServiceEvent).validate_python({"type": "item.processed", "jobId": UID, "userId": UID, "itemId": UID, "ok": False,
                                                    "error": {"message": "x", "userFacing": True, "retryable": False}})
    assert isinstance(ev, ItemProcessed)
    with pytest.raises(ValidationError):
        TypeAdapter(ServiceEvent).validate_python({"type": "nope", "jobId": UID})


def test_storage_paths_must_sit_under_a_user():
    with pytest.raises(ValidationError):
        RenderRequest.model_validate({"jobId": UID, "userId": UID, "personImagePath": "../etc/passwd", "avatarVersion": None,
                                      "garments": [{"itemId": UID, "slot": "top", "description": "", "imagePath": f"{UID}/a", "cutoutPath": None, "updatedAt": "x"}]})
