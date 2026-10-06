"""Synthetic cut-outs of a 170 cm person at 2 px/cm: widths (cm) by height above the floor (cm)."""

import numpy as np
import pytest

from app.measure import ellipse_circumference, estimate_measurements, inseam_cm, jround, run_width, silhouette_rows, width_at

PX, H = 2, 170


def person(width_at_cm, leg_gap=0, arms=False):
    width, height = 200, H * PX + 20  # 10 px margin above and below
    m = np.zeros((height, width), dtype=np.uint8)
    cx = width / 2
    for y in range(10, height - 10):
        h = (height - 10 - y) / PX
        w = width_at_cm(h) * PX

        def fill(x0, x1):
            m[y, jround(x0) : jround(x1)] = 255

        if h < 80 and leg_gap:
            fill(cx - w / 2, cx - leg_gap * PX / 2)
            fill(cx + leg_gap * PX / 2, cx + w / 2)
        else:
            fill(cx - w / 2, cx + w / 2)
        if arms and 85 < h < 140:  # A-pose arms, apart from the torso
            fill(cx - w / 2 - 14 * PX, cx - w / 2 - 8 * PX)
            fill(cx + w / 2 + 8 * PX, cx + w / 2 + 14 * PX)
    return m


front = person(lambda h: 16 if h > 150 else 44 if h > 128 else 34 if h > 112 else 30 if h > 97 else 36 if h > 80 else 34, leg_gap=6, arms=True)
side = person(lambda h: 20 if h > 150 else 20 if h > 128 else 24 if h > 112 else 22 if h > 97 else 25 if h > 80 else 16)


def test_crown_and_soles():
    assert silhouette_rows(front) == (10, 349)
    assert silhouette_rows(np.zeros((4, 4), np.uint8)) is None


def test_run_through_centre_not_arms():
    y = 350 - 122 * PX  # chest row
    assert run_width(front, y, 100) == 34 * PX
    assert run_width(front, y, 5) == 0
    assert width_at(front, 0.72, H) == pytest.approx(34, abs=0.5)
    assert width_at(side, 0.72, H) == pytest.approx(24, abs=0.5)


def test_inseam():
    assert inseam_cm(front, H) == pytest.approx(80, abs=0.5)


def test_ellipse_circle():
    assert ellipse_circumference(10, 10) == pytest.approx(np.pi * 10, abs=1e-6)


def test_360_scan_uses_front_width_and_side_depth():
    r = estimate_measurements(H, front=front, side=side)
    m, s = r.values, r.sources
    assert m["heightCm"] == 170 and s["heightCm"] == "size"
    assert m["shoulderCm"] == 44 and s["shoulderCm"] == "measured"
    assert abs(m["chestCm"] - ellipse_circumference(34, 24) * 1.13) <= 1  # ≈ 104
    assert abs(m["waistCm"] - ellipse_circumference(30, 22) * 1.05) <= 1
    assert (m["chestDepthCm"], m["waistDepthCm"], m["inseamCm"]) == (24, 22, 80)
    assert all(s[k] == "measured" for k in ("chestCm", "waistCm", "hipCm", "chestDepthCm", "waistDepthCm", "inseamCm"))
    assert s["armCm"] == s["torsoCm"] == "average"
    assert set(s) == set(m)


def test_fallback_to_sizes_then_proportions():
    sized = estimate_measurements(H, sizes={"topSize": "m", "waistIn": 32, "shoeUk": 9}, front=front)
    assert (sized.values["chestCm"], sized.values["waistCm"], sized.values["shoulderCm"]) == (96, 81, 44)
    assert sized.sources["chestCm"] == sized.sources["waistCm"] == sized.sources["shoeUk"] == "size"
    assert "chestDepthCm" not in sized.values
    bare = estimate_measurements(None)
    assert {k: bare.values[k] for k in ("heightCm", "shoulderCm", "chestCm", "inseamCm")} == {"heightCm": 170, "shoulderCm": 42, "chestCm": 92, "inseamCm": 80}
    assert set(bare.sources.values()) == {"average"}


def test_ignores_width_merged_with_arms():
    merged = person(lambda h: 16 if h > 150 else 70 if h > 85 else 34, leg_gap=6)
    r = estimate_measurements(H, front=merged, side=side, sizes={"topSize": "L"})
    assert r.values["chestCm"] == 102 and r.sources["chestCm"] == "size"  # the size, not the 170+ cm silhouette
    assert r.values["shoulderCm"] == jround(H * 0.245) and r.sources["shoulderCm"] == "average"
