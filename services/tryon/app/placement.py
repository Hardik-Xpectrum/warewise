"""Where each garment goes on an avatar photo, from body landmarks. Ported from
src/modules/tryon/placement.ts (the browser preview draws with the same rules, so keep the two in
step). Pure. A pose is {"landmarks": [{"x", "y", "visibility"?}, ... 33]} normalised 0..1."""

from __future__ import annotations

import re
from dataclasses import dataclass

# MediaPipe pose landmark indices.
NOSE, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE = 0, 11, 12, 23, 24, 25, 26, 27, 28

# Drawing order, back to front: a top goes over trousers, a jacket over the top.
ORDER = ["shoes", "bottom", "one_piece", "top", "outer"]


@dataclass(frozen=True)
class GarmentInput:
    id: str
    slot: str  # top | bottom | one_piece | outer | shoes | accessory
    aspect: float  # width / height of the garment cut-out
    subcategory: str | None = None


@dataclass(frozen=True)
class Box:
    id: str
    slot: str
    x: float
    y: float
    w: float
    h: float


def _vis(p: dict) -> float:
    v = p.get("visibility")
    return 1.0 if v is None else float(v)


def _visible(p: dict | None, minimum: float = 0.3) -> bool:
    return bool(p) and _vis(p) >= minimum


def pose_quality(pose: dict) -> float:
    """0..1 score of how usable a photo is: full body visible, standing, facing the camera."""
    lm = pose["landmarks"]
    if len(lm) < 33:
        return 0.0
    key = [NOSE, L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE]
    vis = sum(min(1.0, max(0.0, _vis(lm[i]))) for i in key) / len(key)
    shoulder_w = abs(lm[L_SHOULDER]["x"] - lm[R_SHOULDER]["x"])
    facing = min(1.0, shoulder_w / 0.12)  # side-on photos have narrow shoulders
    tall = min(1.0, (max(lm[L_ANKLE]["y"], lm[R_ANKLE]["y"]) - lm[NOSE]["y"]) / 0.7)
    return round(max(0.0, min(1.0, vis * 0.5 + facing * 0.25 + tall * 0.25)), 2)


def pose_usable(pose: dict) -> bool:
    """Hard requirement: shoulders and hips must be found, or garments cannot be placed at all."""
    lm = pose["landmarks"]
    return len(lm) >= 33 and all(_visible(lm[i], 0.5) for i in (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP))


def _fit(aspect: float, target_w: float, max_h: float) -> tuple[float, float]:
    w, h = target_w, target_w / aspect
    if h > max_h:
        h = max_h
        w = h * aspect
    return w, h


def place_garments(pose: dict, W: float, H: float, garments: list[GarmentInput]) -> list[Box]:
    """Pixel boxes for each garment on a W x H avatar image, in drawing order. Accessories are skipped."""
    lm = pose["landmarks"]

    def px(i: int) -> tuple[float, float]:
        return lm[i]["x"] * W, lm[i]["y"] * H

    ls, rs, lh, rh = px(L_SHOULDER), px(R_SHOULDER), px(L_HIP), px(R_HIP)
    shoulder_y = (ls[1] + rs[1]) / 2
    shoulder_x = (ls[0] + rs[0]) / 2
    shoulder_w = max(abs(ls[0] - rs[0]), W * 0.12)
    hip_y = (lh[1] + rh[1]) / 2
    hip_x = (lh[0] + rh[0]) / 2
    hip_w = max(abs(lh[0] - rh[0]), shoulder_w * 0.6)
    torso = max(hip_y - shoulder_y, H * 0.15)

    ankles_seen = _visible(lm[L_ANKLE]) and _visible(lm[R_ANKLE])
    ankle_y = (px(L_ANKLE)[1] + px(R_ANKLE)[1]) / 2 if ankles_seen else min(H, hip_y + torso * 2.1)
    knee_y = (px(L_KNEE)[1] + px(R_KNEE)[1]) / 2 if _visible(lm[L_KNEE]) and _visible(lm[R_KNEE]) else (hip_y + ankle_y) / 2
    ankle_x = (px(L_ANKLE)[0] + px(R_ANKLE)[0]) / 2 if ankles_seen else hip_x
    ankle_spread = abs(px(L_ANKLE)[0] - px(R_ANKLE)[0]) if ankles_seen else hip_w

    boxes: list[Box] = []
    for g in garments:
        aspect = g.aspect if g.aspect > 0 else 0.8
        sub = (g.subcategory or "").lower()
        box: tuple[float, float, float, float] | None = None  # w, h, top, cx
        if g.slot == "top":
            long = re.search(r"kurta|tunic|kurti", sub) is not None
            w, h = _fit(aspect, shoulder_w * 1.95, knee_y - shoulder_y + torso * 0.2 if long else torso * 1.45)
            box = (w, h, shoulder_y - torso * 0.12, shoulder_x)
        elif g.slot == "outer":
            w, h = _fit(aspect, shoulder_w * 2.1, torso * 1.6)
            box = (w, h, shoulder_y - torso * 0.14, shoulder_x)
        elif g.slot == "one_piece":
            w, h = _fit(aspect, shoulder_w * 1.9, ankle_y - shoulder_y + torso * 0.15)
            box = (w, h, shoulder_y - torso * 0.1, shoulder_x)
        elif g.slot == "bottom":
            short = re.search(r"shorts|skirt", sub) is not None
            target_h = (knee_y if short else ankle_y) - hip_y + torso * 0.12
            w = min(max(target_h * aspect, hip_w * 1.5), hip_w * 3.2)
            h = min(w / aspect, target_h * 1.05)
            box = (w, h, hip_y - torso * 0.1, hip_x)
        elif g.slot == "shoes":
            # Product photos of shoes come in any shape, so cap the height as well as the width:
            # shoes are never taller than about a third of the torso.
            w, h = _fit(aspect, max(ankle_spread * 1.7, hip_w * 1.25), torso * 0.35)
            box = (w, h, ankle_y - h * 0.35, ankle_x)
        if box:
            w, h, top, cx = box
            boxes.append(Box(g.id, g.slot, cx - w / 2, top, w, h))
    return sorted(boxes, key=lambda b: ORDER.index(b.slot))
