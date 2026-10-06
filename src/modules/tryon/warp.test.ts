import { describe, expect, it } from "vitest";
import { standingPose } from "./placement.test";
import { affineFromTriangles, analyzeShape, bodyFrame, smoothLandmarks, warpGarment, type Tri } from "./warp";

function apply(m: number[], p: { x: number; y: number }) {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Draws a filled shape into an alpha mask via a predicate. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean) {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) a[y * w + x] = 255;
  return a;
}

describe("affineFromTriangles", () => {
  it("maps each source corner onto its destination corner", () => {
    const src: Tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 }];
    const dst: Tri = [{ x: 10, y: 20 }, { x: 80, y: 40 }, { x: 5, y: 90 }];
    const m = affineFromTriangles(src, dst)!;
    src.forEach((p, i) => {
      const q = apply(m, p);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
  });

  it("returns null for a degenerate triangle", () => {
    expect(affineFromTriangles([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
  });
});

describe("analyzeShape", () => {
  it("finds a t-shirt's torso, sleeves and armpit, ignoring a hanger hook", () => {
    const w = 100, h = 120;
    const tee = mask(w, h, (x, y) =>
      (y >= 2 && y < 12 && x >= 48 && x <= 52) || // hanger hook
      (y >= 12 && y < 45 && x >= 5 && x <= 95) || // shoulders + sleeves
      (y >= 45 && y < 118 && x >= 25 && x <= 75), // torso
    );
    const s = analyzeShape(tee, w, h);
    expect(s.top).toBeCloseTo(12 / h, 2);
    expect(s.reachL).toBeLessThan(0.1);
    expect(s.reachR).toBeGreaterThan(0.9);
    expect(s.bodyL).toBeGreaterThan(0.2);
    expect(s.armpitY).toBeCloseTo(45 / h, 1);
  });

  it("finds where trouser legs split and their hems", () => {
    const w = 100, h = 200;
    const jeans = mask(w, h, (x, y) => (y < 60 && x >= 20 && x <= 80) || (y >= 60 && ((x >= 20 && x <= 47) || (x >= 53 && x <= 80))));
    const s = analyzeShape(jeans, w, h);
    expect(s.crotchY).toBeCloseTo(60 / h, 1);
    expect(s.hemL[1]).toBeLessThan(0.5);
    expect(s.hemR[0]).toBeGreaterThan(0.5);
  });
});

describe("bodyFrame", () => {
  it("orders limbs image-left first, also in a mirrored frame", () => {
    const pose = standingPose();
    const f = bodyFrame(pose.landmarks, 600, 1200);
    expect(f.shoulder[0].x).toBeLessThan(f.shoulder[1].x);
    const mirrored = pose.landmarks.map((p) => ({ ...p, x: 1 - p.x }));
    const g = bodyFrame(mirrored, 600, 1200);
    expect(g.shoulder[0].x).toBeLessThan(g.shoulder[1].x);
    expect(g.hip[0].x).toBeLessThan(g.hip[1].x);
  });
});

describe("warpGarment", () => {
  const body = bodyFrame(standingPose().landmarks, 600, 1200);
  const shape = analyzeShape(mask(100, 120, (x, y) => (y < 35 && x >= 5 && x <= 95) || (y >= 35 && x >= 25 && x <= 75)), 100, 120);

  it("drapes a top from the shoulders to just below the hips, with sleeves", () => {
    const tris = warpGarment({ slot: "top", subcategory: "t-shirt", shape, imgW: 100, imgH: 120 }, body);
    expect(tris.length).toBe(4 + 8); // torso strip (2 quads) + two sleeves (2 quads each)
    const ys = tris.flatMap((t) => t.dst.map((p) => p.y));
    expect(Math.min(...ys)).toBeLessThan(0.2 * 1200);
    expect(Math.max(...ys)).toBeGreaterThan(0.5 * 1200);
    expect(Math.max(...ys)).toBeLessThan(0.62 * 1200);
  });

  it("runs trouser legs from the hips to the ankles", () => {
    const jeans = analyzeShape(mask(100, 200, (x, y) => (y < 60 && x >= 20 && x <= 80) || (y >= 60 && ((x >= 20 && x <= 47) || (x >= 53 && x <= 80)))), 100, 200);
    const tris = warpGarment({ slot: "bottom", subcategory: "jeans", shape: jeans, imgW: 100, imgH: 200 }, body);
    const ys = tris.flatMap((t) => t.dst.map((p) => p.y));
    expect(Math.min(...ys)).toBeLessThan(0.52 * 1200);
    expect(Math.max(...ys)).toBeGreaterThan(0.9 * 1200);
  });

  it("puts one shoe on each foot", () => {
    const tris = warpGarment({ slot: "shoes", shape, imgW: 200, imgH: 80 }, body);
    expect(tris.length).toBe(4);
  });
});

describe("smoothLandmarks", () => {
  it("moves part of the way towards the new position", () => {
    const out = smoothLandmarks([{ x: 0, y: 0 }], [{ x: 1, y: 1 }], 0.5);
    expect(out[0]).toMatchObject({ x: 0.5, y: 0.5 });
  });
});

describe("findParts", () => {
  it("finds two separate tilted shoes and their angle", () => {
    const w = 120, h = 80;
    // Two thin bars tilted by about 30 degrees.
    const tilted = (x: number, y: number, cx: number, cy: number) => {
      const a = Math.PI / 6;
      const u = (x - cx) * Math.cos(a) + (y - cy) * Math.sin(a);
      const v = -(x - cx) * Math.sin(a) + (y - cy) * Math.cos(a);
      return Math.abs(u) < 22 && Math.abs(v) < 7;
    };
    const a = mask(w, h, (x, y) => tilted(x, y, 30, 40) || tilted(x, y, 90, 40));
    const parts = analyzeShape(a, w, h).parts;
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p.angle).toBeCloseTo(Math.PI / 6, 1);
      expect(p.len * w).toBeGreaterThan(p.wid * h * 2);
    }
  });

  it("places straightened shoes side-on at the feet", () => {
    const body = bodyFrame(standingPose().landmarks, 600, 1200);
    const shape = analyzeShape(mask(120, 80, (x, y) => (x > 10 && x < 55 && y > 30 && y < 50) || (x > 65 && x < 110 && y > 30 && y < 50)), 120, 80);
    const tris = warpGarment({ slot: "shoes", shape, imgW: 120, imgH: 80 }, body);
    expect(tris).toHaveLength(4);
    for (const t of tris) for (const p of t.dst) expect(p.y).toBeGreaterThan(0.8 * 1200);
  });
});

describe("fit scaling", () => {
  it("draws a roomier top when fit > 1", () => {
    const body = bodyFrame(standingPose().landmarks, 600, 1200);
    const shape = analyzeShape(mask(100, 120, (x, y) => x >= 20 && x <= 80 && y >= 5), 100, 120);
    const width = (fit: number) => {
      const xs = warpGarment({ slot: "top", shape, imgW: 100, imgH: 120, fit }, body).flatMap((t) => t.dst.map((p) => p.x));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width(1.2)).toBeGreaterThan(width(1));
  });
});
