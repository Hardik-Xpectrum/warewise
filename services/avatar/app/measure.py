"""Body measurements stored with each avatar version, in cm, with where each value came from.

These are estimates and the app labels them so. Method (all pure, unit-tested):

1. **Scale.** The cut-out's silhouette runs from the crown to the soles, so cm-per-pixel is the
   height from the profile (170 cm when unknown) over the silhouette's pixel height. Each view is
   scaled on its own, so the views needn't share a camera distance.
2. **Landmark rows.** Shoulder, chest, waist and hip sit at near-constant fractions of stature in
   adults (ISO 7250 / Drillis-Contini means): bideltoid 0.80, chest 0.72, waist 0.62, hip 0.53,
   measured from the floor.
3. **Width and depth.** At each row the front view gives the body's width and the side view (left,
   else right) its depth: the run of opaque pixels through the torso's centre column, the median
   over a band of ±1.5 % of stature to ride over noise. The front view needs an A-pose (arms away
   from the torso), which the phone's scan guide asks for.
4. **Girth.** A torso cross-section is close to an ellipse whose axes are that width and depth.
   Its perimeter (Ramanujan's approximation, `ellipse_circumference`) times a fullness factor
   (chest 1.13, waist 1.05, hip 1.05) gives the girth; the factors calibrate the ellipse to the
   mean adult girths for the mean adult breadths and depths (the chest is fuller than an ellipse
   because of the back muscles and the bust).
5. **Fallbacks.** Without a side view (a photo scan) there is no depth: chest and waist come from
   the sizes the user entered (top size, waist in inches), then from average proportions. A
   silhouette value is kept only within 0.65–1.5x the size/proportion estimate, which rejects,
   for example, a width that merged with the arms.

Sources (`MeasurementSource` in the contract), one per value:
- ``measured``: read from the scan's silhouettes;
- ``size``: from what the user entered (height in the profile, top size, waist, shoe size);
- ``average``: from mean adult proportions of the height.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

Source = Literal["measured", "size", "average"]
Mask = np.ndarray  # 2-D uint8 alpha (height x width), 0 = background

# Typical chest girth (cm) for each letter size (same table as the web app's measure.ts).
CHEST_BY_SIZE = {"XS": 84, "S": 90, "M": 96, "L": 102, "XL": 108, "XXL": 114, "3XL": 120}
ROW = {"shoulder": 0.8, "chest": 0.72, "waist": 0.62, "hip": 0.53}
GIRTH_FACTOR = {"chest": 1.13, "waist": 1.05, "hip": 1.05}
BAND = 0.015
OPAQUE = 128
DEFAULT_HEIGHT_CM = 170


def jround(v: float) -> int:
    """JavaScript's Math.round (halves go up), so results match the TypeScript service."""
    return math.floor(v + 0.5)


@dataclass
class Measurements:
    values: dict[str, float] = field(default_factory=dict)
    sources: dict[str, Source] = field(default_factory=dict)

    def set(self, name: str, value: float, source: Source) -> None:
        self.values[name] = value
        self.sources[name] = source


def silhouette_rows(m: Mask) -> tuple[int, int] | None:
    """First and last rows with any opaque pixel: the crown and the soles."""
    rows = np.flatnonzero((m >= OPAQUE).any(axis=1))
    if rows.size == 0 or rows[-1] - rows[0] < 10:
        return None
    return int(rows[0]), int(rows[-1])


def _torso_centre(m: Mask, rows: tuple[int, int]) -> int:
    """Centre column of the torso: the mean x of opaque pixels between the chest and hip rows."""
    top, bottom = rows
    h = bottom - top
    y0, y1 = jround(bottom - ROW["chest"] * h), jround(bottom - ROW["hip"] * h)
    ys, xs = np.nonzero(m[max(0, y0) : y1 + 1] >= OPAQUE)
    return jround(float(xs.mean())) if xs.size else jround(m.shape[1] / 2)


def run_width(m: Mask, y: int, cx: int) -> int:
    """Width in pixels of the opaque run in row y that contains column cx (0 when cx is background)."""
    if y < 0 or y >= m.shape[0] or not (0 <= cx < m.shape[1]) or m[y, cx] < OPAQUE:
        return 0
    row = m[y] >= OPAQUE
    left = np.flatnonzero(~row[:cx])
    right = np.flatnonzero(~row[cx:])
    lo = int(left[-1]) + 1 if left.size else 0
    hi = cx + int(right[0]) - 1 if right.size else m.shape[1] - 1
    return hi - lo + 1


def width_at(m: Mask, fraction: float, height_cm: float) -> float | None:
    """Body width (cm) at a fraction of stature from the floor: the band's median run width."""
    rows = silhouette_rows(m)
    if not rows:
        return None
    top, bottom = rows
    h = bottom - top
    cx = _torso_centre(m, rows)
    yc = jround(bottom - fraction * h)
    half = max(1, jround(BAND * h))
    widths = sorted(run_width(m, y, cx) for y in range(yc - half, yc + half + 1))
    median = widths[len(widths) // 2]
    return median * height_cm / h if median > 0 else None


def inseam_cm(m: Mask, height_cm: float) -> float | None:
    """Inside leg length: from the floor up the centre column to the crotch (the first opaque pixel)."""
    rows = silhouette_rows(m)
    if not rows:
        return None
    top, bottom = rows
    cx = _torso_centre(m, rows)
    y = bottom
    while y > top and m[y, cx] < OPAQUE:
        y -= 1
    inseam = (bottom - y) * height_cm / (bottom - top)
    return inseam if inseam > 0 else None


def ellipse_circumference(width: float, depth: float) -> float:
    """Ramanujan's approximation of an ellipse's perimeter from its two full axes."""
    a, b = width / 2, depth / 2
    return math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))


def _plausible(measured: float | None, expected: float) -> float | None:
    return measured if measured is not None and expected * 0.65 <= measured <= expected * 1.5 else None


def estimate_measurements(
    height_cm: float | None,
    sizes: dict | None = None,
    front: Mask | None = None,
    side: Mask | None = None,
) -> Measurements:
    """`sizes` uses the contract's wire names (topSize, waistIn, shoeUk)."""
    sizes = sizes or {}
    out = Measurements()
    given_height = bool(height_cm and height_cm >= 100)
    height = float(height_cm) if given_height else DEFAULT_HEIGHT_CM
    out.set("heightCm", jround(height), "size" if given_height else "average")

    # Size-based and proportional estimates: the baseline and the plausibility reference.
    shoulder_avg = height * 0.245
    shoulder = _plausible(width_at(front, ROW["shoulder"], height), shoulder_avg) if front is not None else None
    out.set("shoulderCm", jround(shoulder or shoulder_avg), "measured" if shoulder else "average")
    shoulder_cm = shoulder or shoulder_avg

    top_size = (sizes.get("topSize") or "").upper().replace(" ", "")
    chest_size = CHEST_BY_SIZE.get(top_size)
    chest_base, chest_src = (chest_size, "size") if chest_size else (shoulder_cm * 2.2, "average")
    waist_in = sizes.get("waistIn")
    waist_base, waist_src = (waist_in * 2.54, "size") if waist_in else (chest_base * 0.86, chest_src)
    hip_base = max(waist_base * 1.08, chest_base * 0.96)
    hip_src: Source = waist_src if waist_base * 1.08 >= chest_base * 0.96 else chest_src

    def girth(part: str, base: float, base_src: Source) -> None:
        name = f"{part}Cm"
        if front is not None and side is not None:
            w = width_at(front, ROW[part], height)
            d = width_at(side, ROW[part], height)
            if w and d:
                measured = _plausible(ellipse_circumference(w, d) * GIRTH_FACTOR[part], base)
                if measured:
                    out.set(name, jround(measured), "measured")
                    if part != "hip":
                        out.set(f"{part}DepthCm", jround(d), "measured")
                    return
        out.set(name, jround(base), base_src)

    girth("chest", chest_base, chest_src)  # type: ignore[arg-type]
    girth("waist", waist_base, waist_src)  # type: ignore[arg-type]
    girth("hip", hip_base, hip_src)
    # Keep the TypeScript key order: depths after the girths.
    for k in ("chestDepthCm", "waistDepthCm"):
        if k in out.values:
            out.values[k] = out.values.pop(k)
            out.sources[k] = out.sources.pop(k)

    inseam_avg = height * 0.47
    inseam = _plausible(inseam_cm(front, height), inseam_avg) if front is not None else None
    out.set("inseamCm", jround(inseam or inseam_avg), "measured" if inseam else "average")
    out.set("armCm", jround(height * 0.33), "average")
    out.set("torsoCm", jround(height * 0.3), "average")
    if sizes.get("shoeUk"):
        out.set("shoeUk", sizes["shoeUk"], "size")
    return out
