"""Validates a render request beyond the contract's shape. Pure and unit-tested.

The valid request is kept as camelCase JSON (it is stored in tryon.renders.request and read back
by the worker), with `pose` as {"landmarks": [...]} or None, the same shape the TypeScript
service stored."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from warewise_contracts import RenderRequest

from app.wear import slot_for

DRESSABLE = ("top", "outer", "bottom", "one_piece")


def _detail(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'body'}: {e['msg']}" for e in err.errors())


def validate_render(body: Any) -> tuple[bool, dict | str]:
    """(True, valid request JSON) or (False, a readable detail)."""
    try:
        req = RenderRequest.model_validate(body)
    except ValidationError as err:
        return False, _detail(err)

    # The web app checked who is acting; still, every file must sit under that user's prefix so a
    # bad request can never read someone else's photos.
    def own(path: str | None) -> bool:
        return path is None or path.startswith(f"{req.user_id}/")

    if not own(req.person_image_path) or not all(own(g.image_path) and own(g.cutout_path) for g in req.garments):
        return False, "All image paths must be under the user's own folder"
    if len({g.item_id for g in req.garments}) != len(req.garments):
        return False, "garments: duplicate itemId"
    if not any(g.slot in DRESSABLE for g in req.garments):
        return False, "AI try-on dresses clothes, not shoes or accessories: include a top, bottom, layer or dress"

    value = req.model_dump(by_alias=True, mode="json")
    # A "layer" that is really a shirt is dressed as a top (the description stands in for the subcategory).
    for g in value["garments"]:
        g["slot"] = slot_for(g["slot"], g["description"].lower()) or g["slot"]
    value["pose"] = {"landmarks": value["pose"]} if value.get("pose") else None
    return True, value
