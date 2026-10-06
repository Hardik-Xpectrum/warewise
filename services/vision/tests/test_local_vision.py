import numpy as np

from app.local_vision import (
    GARMENTS,
    NOT_CLOTHING,
    PATTERN_PROMPTS,
    cutout_labels,
    erode,
    mask_passes_gate,
    named_colors,
    nearest_color,
    pick_garment,
    pick_pattern,
)

N_LABELS = len(GARMENTS) + len(NOT_CLOTHING)


def scores_with(winner, n=N_LABELS):
    return [0.6 if i == winner else 0.4 / (n - 1) for i in range(n)]


def test_pick_garment_maps_tags():
    kurta = next(i for i, g in enumerate(GARMENTS) if g.subcategory == "kurta")
    garment, confidence = pick_garment(scores_with(kurta))
    assert (garment.category, garment.subcategory) == ("top", "kurta")
    assert confidence > 0.6


def test_not_clothing_wins():
    assert pick_garment(scores_with(len(GARMENTS) + 1))[0] is None


def at(values):
    return [values.get(k, 0.05) for k in PATTERN_PROMPTS]


def test_pattern_needs_clear_lead():
    assert pick_pattern(at({"solid": 0.3, "striped": 0.4})) == "solid"
    assert pick_pattern(at({"solid": 0.2, "striped": 0.5})) == "striped"


def test_embroidery_needs_bigger_lead():
    assert pick_pattern(at({"solid": 0.2, "embroidered": 0.5})) == "solid"
    assert pick_pattern(at({"solid": 0.1, "embroidered": 0.6})) == "embroidered"


def test_colour_names():
    assert nearest_color((30, 42, 77)) == "navy"
    assert nearest_color((201, 162, 39)) == "mustard"
    assert nearest_color((250, 250, 250)) == "white"
    assert nearest_color((190, 190, 190)) == "grey"  # plain fabric isn't "silver"
    assert nearest_color((200, 164, 77)) != "gold"


def test_named_colors_ranked_opaque_only():
    px = lambda r, g, b, a, n: [[r, g, b, a]] * n
    rgba = np.array(px(30, 42, 77, 255, 70) + px(250, 250, 250, 255, 30) + px(200, 0, 0, 0, 200), np.uint8)
    assert named_colors(rgba, 0.12, 1) == ["navy", "white"]
    assert named_colors(np.zeros((4, 4), np.uint8)) == []


def test_cutout_labels():
    assert cutout_labels({"Face": 0.02, "Upper-clothes": 0.3, "Pants": 0.2}, "top") == ["Upper-clothes", "Dress"]
    assert "Pants" in cutout_labels({"Dress": 0.4}, "top")


def mask(fill, w=20, h=20):
    return np.array([[255 if fill(x, y) else 0 for x in range(w)] for y in range(h)], np.uint8)


def test_gate():
    assert mask_passes_gate(mask(lambda x, y: 5 <= x < 15 and 3 <= y < 18))
    assert not mask_passes_gate(mask(lambda x, y: False))
    assert not mask_passes_gate(mask(lambda x, y: x == 10 and y == 10), 0.02)
    scraps = mask(lambda x, y: (x == 0 and y == 0) or (x == 19 and y == 19) or (x % 7 == 0 and y % 7 == 0))
    assert not mask_passes_gate(scraps, 0)


def test_erode():
    m = erode(mask(lambda x, y: 5 <= x < 15 and 5 <= y < 15), 1)
    assert m[5, 5] == 0 and m[6, 6] == 255
