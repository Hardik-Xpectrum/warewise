import pytest

from app.placement import GarmentInput, place_garments, pose_quality, pose_usable


def standing_pose(**overrides: dict) -> dict:
    """A front-facing standing figure (normalised coordinates); overrides are {"i23": {...}}."""
    lm = [{"x": 0.5, "y": 0.5, "visibility": 0.9} for _ in range(33)]
    for i, x, y in [(0, 0.5, 0.08), (11, 0.66, 0.2), (12, 0.34, 0.2), (23, 0.6, 0.5), (24, 0.4, 0.5),
                    (25, 0.6, 0.7), (26, 0.4, 0.7), (27, 0.6, 0.92), (28, 0.4, 0.92)]:
        lm[i] = {"x": x, "y": y, "visibility": 0.95}
    for key, patch in overrides.items():
        lm[int(key[1:])] = {**lm[int(key[1:])], **patch}
    return {"landmarks": lm}


W, H = 600, 1200
BOXES = place_garments(standing_pose(), W, H, [
    GarmentInput("jacket", "outer", 0.8), GarmentInput("tee", "top", 0.83), GarmentInput("jeans", "bottom", 0.7),
    GarmentInput("shoes", "shoes", 2.3), GarmentInput("watch", "accessory", 1),
])


def by(id_: str):
    return next(b for b in BOXES if b.id == id_)


def test_scores_a_full_front_pose_highly_and_hidden_hips_as_unusable():
    assert pose_quality(standing_pose()) > 0.85
    assert pose_usable(standing_pose())
    assert not pose_usable(standing_pose(i23={"visibility": 0.1}))


def test_penalises_side_on_photos():
    assert pose_quality(standing_pose(i11={"x": 0.52}, i12={"x": 0.48})) < pose_quality(standing_pose())


def test_draws_back_to_front_and_skips_accessories():
    assert [b.id for b in BOXES] == ["shoes", "jeans", "tee", "jacket"]


def test_puts_the_top_over_the_shoulders_and_the_bottom_from_hips_to_ankles():
    tee = by("tee")
    assert tee.y < 0.2 * H and tee.y + tee.h > 0.5 * H
    assert tee.x + tee.w / 2 == pytest.approx(300, abs=0.5)
    jeans = by("jeans")
    assert jeans.y < 0.5 * H and jeans.y + jeans.h > 0.88 * H


def test_keeps_shoes_at_the_feet_and_the_jacket_wider_than_the_top():
    assert by("shoes").y > 0.85 * H
    assert by("jacket").w >= by("tee").w


def test_keeps_tall_shoe_photos_small():
    [shoes] = place_garments(standing_pose(), W, H, [GarmentInput("s", "shoes", 0.8)])
    assert shoes.h <= (0.5 - 0.2) * H * 0.35 + 0.001
    assert shoes.y + shoes.h < H * 1.05


def test_makes_kurtas_longer_than_t_shirts():
    [kurta] = place_garments(standing_pose(), W, H, [GarmentInput("k", "top", 0.7, "kurta")])
    assert kurta.h > by("tee").h


def test_missing_visibility_counts_as_visible():
    pose = standing_pose()
    for p in pose["landmarks"]:
        p["visibility"] = None
    assert pose_usable(pose)
