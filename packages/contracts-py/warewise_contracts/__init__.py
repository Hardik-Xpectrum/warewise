"""The Warewise service contract, Python side.

Mirrors packages/contracts/src/index.ts (the TypeScript side used by the web app) field for
field: JSON on the wire is camelCase exactly as there, Python attributes are snake_case. Service
tokens and render cache keys are byte-for-byte compatible (tests/test_contracts.py checks
vectors produced by the TypeScript code). Change the TypeScript contract first, then this.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# Service identities and auth
# ---------------------------------------------------------------------------

ServiceName = Literal["web", "vision", "avatar", "tryon"]
SERVICES: tuple[str, ...] = ("web", "vision", "avatar", "tryon")


def sign_service_token(iss: ServiceName, aud: ServiceName, secret: str, ttl_seconds: int = 300) -> str:
    """`<iss>.<aud>.<exp>.<hex hmac-sha256>`, sent as `Authorization: Service <token>`."""
    exp = int(time.time()) + ttl_seconds
    payload = f"{iss}.{aud}.{exp}"
    return f"{payload}.{hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()}"


class TokenCheck(BaseModel):
    ok: bool
    iss: ServiceName | None = None
    reason: str | None = None


def verify_service_token(token: str | None, expected_aud: ServiceName, secret: str) -> TokenCheck:
    if not token:
        return TokenCheck(ok=False, reason="missing token")
    raw = token[8:] if token[:8].lower() == "service " else token
    parts = raw.strip().split(".")
    if len(parts) != 4:
        return TokenCheck(ok=False, reason="malformed token")
    iss, aud, exp, sig = parts
    if iss not in SERVICES:
        return TokenCheck(ok=False, reason="unknown issuer")
    if aud != expected_aud:
        return TokenCheck(ok=False, reason="wrong audience")
    if not exp.isdigit() or int(exp) < int(time.time()):
        return TokenCheck(ok=False, reason="expired")
    want = hmac.new(secret.encode(), f"{iss}.{aud}.{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, sig):
        return TokenCheck(ok=False, reason="bad signature")
    return TokenCheck(ok=True, iss=iss)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Shared shapes
# ---------------------------------------------------------------------------


class Model(BaseModel):
    """camelCase on the wire, snake_case in Python; unknown fields rejected like zod's strict parse is not
    (zod strips them), so extra keys are ignored here too."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def to_json(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")


Uuid = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
# A path inside the private Supabase Storage bucket "wardrobe", always "<userId>/...".
StoragePath = Annotated[str, Field(min_length=3, max_length=300, pattern=r"^[0-9a-f-]{36}/[A-Za-z0-9_./-]+$")]
Slot = Literal["top", "outer", "bottom", "one_piece", "shoes", "accessory"]
JobState = Literal["queued", "running", "done", "failed"]


class Problem(Model):
    """RFC 7807 problem details: the error body of every service."""

    type: str
    title: str
    status: int
    detail: str | None = None


class JobAccepted(Model):
    job_id: Uuid
    status: JobState
    cached: bool = False


# ---------------------------------------------------------------------------
# Vision service
# ---------------------------------------------------------------------------


class ProcessItemRequest(Model):
    job_id: Uuid
    user_id: Uuid
    item_id: Uuid
    image_path: StoragePath


class ItemTags(Model):
    category: Slot
    subcategory: str | None
    colors: list[str] = Field(max_length=3)
    pattern: str
    seasons: list[str]
    fabric: str | None
    formality: int = Field(ge=1, le=5)
    fit: str
    brand: str | None
    confidence: float = Field(ge=0, le=1)
    model: str


class ItemPaths(Model):
    clean: StoragePath
    thumb: StoragePath
    cutout: StoragePath | None


class ItemError(Model):
    message: str
    user_facing: bool
    retryable: bool


class ItemProcessed(Model):
    type: Literal["item.processed"] = "item.processed"
    job_id: Uuid
    user_id: Uuid
    item_id: Uuid
    ok: bool
    tags: ItemTags | None = None
    paths: ItemPaths | None = None
    phash: str | None = None
    error: ItemError | None = None


class VisionJobStatus(Model):
    """GET /v1/jobs/:jobId on the vision service."""

    job_id: Uuid
    item_id: Uuid
    status: JobState
    attempts: int
    tags: ItemTags | None = None
    paths: ItemPaths | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Avatar service
# ---------------------------------------------------------------------------

ScanKind = Literal["photo", "body360", "face"]
MeasurementSource = Literal["measured", "size", "average"]


class Views(Model):
    front: StoragePath
    back: StoragePath | None = None
    left: StoragePath | None = None
    right: StoragePath | None = None


class Sizes(Model):
    top_size: str | None = None
    waist_in: float | None = None
    shoe_uk: float | None = None


class BuildAvatarRequest(Model):
    job_id: Uuid
    user_id: Uuid
    kind: ScanKind
    views: Views | None = None
    face_mesh: StoragePath | None = None
    face_texture: StoragePath | None = None
    height_cm: float | None = Field(default=None, ge=100, le=230)
    sizes: Sizes | None = None


class AvatarVersion(Model):
    user_id: Uuid
    version: int = Field(gt=0)
    kind: ScanKind
    mesh_path: StoragePath | None
    face_mesh_path: StoragePath | None
    face_texture_path: StoragePath | None = None  # also embedded in the face GLB when it has UVs
    measurements: dict[str, float]
    measurement_sources: dict[str, MeasurementSource] = {}
    textured: bool = False
    engine: str
    created_at: str


class AvatarCurrent(AvatarVersion):
    mesh_url: str | None
    face_mesh_url: str | None
    face_texture_url: str | None = None
    building: bool


class AvatarReady(Model):
    type: Literal["avatar.ready"] = "avatar.ready"
    job_id: Uuid
    user_id: Uuid
    version: int = Field(gt=0)


class AvatarFailed(Model):
    type: Literal["avatar.failed"] = "avatar.failed"
    job_id: Uuid
    user_id: Uuid
    message: str
    retryable: bool


# ---------------------------------------------------------------------------
# Try-on service
# ---------------------------------------------------------------------------


class Landmark(Model):
    x: float
    y: float
    visibility: float | None = None


class RenderGarment(Model):
    item_id: Uuid
    slot: Slot
    description: str = Field(max_length=120)
    image_path: StoragePath
    cutout_path: StoragePath | None
    updated_at: str


class RenderRequest(Model):
    job_id: Uuid
    user_id: Uuid
    person_image_path: StoragePath
    avatar_version: int | None = Field(gt=0)
    garments: list[RenderGarment] = Field(min_length=1, max_length=6)
    pose: list[Landmark] | None = Field(default=None, min_length=33, max_length=33)


class AvatarTexture(Model):
    version: int
    texture_path: StoragePath
    back_texture_path: StoragePath | None = None


class RenderStatus(Model):
    job_id: Uuid
    status: JobState
    cache_key: str
    render_path: StoragePath | None
    texture_for_avatar: AvatarTexture | None
    note: str | None
    error: str | None


class TryonReady(Model):
    type: Literal["tryon.ready"] = "tryon.ready"
    job_id: Uuid
    user_id: Uuid
    render_path: StoragePath
    note: str | None


class TryonFailed(Model):
    type: Literal["tryon.failed"] = "tryon.failed"
    job_id: Uuid
    user_id: Uuid
    message: str
    quota: bool


# ---------------------------------------------------------------------------
# Events to the web app: POST {WEB_URL}/api/internal/events, idempotent by (type, jobId)
# ---------------------------------------------------------------------------

ServiceEvent = Annotated[Union[ItemProcessed, AvatarReady, AvatarFailed, TryonReady, TryonFailed], Field(discriminator="type")]


def render_cache_key(person_image_path: str, avatar_version: int | None, garments: list[RenderGarment] | list[dict], engine: str = "ai") -> str:
    """Same as renderCacheKey in TypeScript: engine | person | avatar version | itemId@updatedAt sorted."""
    pairs = []
    for g in garments:
        item_id = g["itemId"] if isinstance(g, dict) else g.item_id
        updated = g["updatedAt"] if isinstance(g, dict) else g.updated_at
        pairs.append((item_id, f"{item_id}@{updated}"))
    raw = "|".join([engine, person_image_path, str(avatar_version) if avatar_version is not None else "-", *[p for _, p in sorted(pairs)]])
    return hmac.new(b"warewise-render-cache", raw.encode(), hashlib.sha256).hexdigest()[:32]
