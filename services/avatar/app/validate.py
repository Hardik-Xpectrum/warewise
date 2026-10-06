"""Build request rules beyond the contract's shapes: which files each kind of scan needs, and that
every file is the acting user's own (the service key can read any user's files)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from warewise_contracts import BuildAvatarRequest


@dataclass
class Validated:
    ok: bool
    req: BuildAvatarRequest | None = None
    detail: str = ""


def request_paths(req: BuildAvatarRequest) -> list[str]:
    """The paths a request reads, so they can be checked together."""
    v = req.views
    paths = [v.front, v.back, v.left, v.right] if v else []
    return [p for p in [*paths, req.face_mesh, req.face_texture] if p]


def _issues(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'body'}: {e['msg']}" for e in err.errors())


def validate_build(body: Any) -> Validated:
    if not isinstance(body, dict):
        return Validated(False, detail="body: expected a JSON object")
    try:
        req = BuildAvatarRequest.model_validate(body)
    except ValidationError as err:
        return Validated(False, detail=_issues(err))
    for p in request_paths(req):
        if not p.startswith(f"{req.user_id}/"):
            return Validated(False, detail=f"{p} is not under the user's folder")
        if any(s in ("..", ".") for s in p.split("/")):
            return Validated(False, detail=f"{p} is not a plain path")
    v = req.views
    if req.kind == "photo" and not (v and v.front):
        return Validated(False, detail="A photo scan needs views.front")
    if req.kind == "body360" and not (v and v.front and v.back and v.left and v.right):
        # Hunyuan3D-2mv reads all four; the side view also gives the body's depth for measurements.
        return Validated(False, detail="A 360° scan needs views.front, back, left and right")
    if req.kind == "face" and not req.face_mesh:
        return Validated(False, detail="A face scan needs faceMesh")
    return Validated(True, req=req)
