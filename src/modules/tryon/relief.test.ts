import { describe, expect, it } from "vitest";
import { distanceInside, inflate, reliefSurface } from "./relief";

/** A disc (torso) with a thin bar (arm) sticking out of it. */
function body(w: number, h: number) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const disc = (x - 20) ** 2 + (y - 20) ** 2 <= 15 ** 2;
      const arm = x > 34 && x < 58 && y >= 18 && y <= 22;
      if (disc || arm) m[y * w + x] = 1;
    }
  return m;
}

describe("distanceInside", () => {
  it("is zero outside, small at the edge and largest in the middle", () => {
    const m = body(60, 40);
    const d = distanceInside(m, 60, 40);
    expect(d[0]).toBe(0);
    expect(d[20 * 60 + 20]).toBeGreaterThan(12);
    expect(d[20 * 60 + 6]).toBeLessThan(2);
  });
});

describe("inflate", () => {
  it("makes the torso deep and the arm thin but still rounded", () => {
    const m = body(60, 40);
    const z = inflate(m, 60, 40);
    const torso = z[20 * 60 + 20];
    const arm = z[20 * 60 + 50];
    expect(torso).toBeGreaterThan(8);
    expect(arm).toBeGreaterThan(0.5);
    expect(arm).toBeLessThan(torso / 3);
    expect(z[0]).toBe(0);
  });
});

describe("reliefSurface", () => {
  it("builds a front surface standing on y = 0 at the requested height, facing +z", () => {
    const m = body(60, 40);
    const z = inflate(m, 60, 40);
    const front = reliefSurface(m, z, 60, 40, 0.01, 1);
    const back = reliefSurface(m, z, 60, 40, 0.01, -1);
    const ys = [...front.positions].filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(0.3, 2); // 30 px tall disc at 1 cm per px
    const zs = [...front.positions].filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeGreaterThan(0);
    expect(Math.min(...[...back.positions].filter((_, i) => i % 3 === 2))).toBeLessThan(0);
    expect(front.indices.length % 3).toBe(0);
    expect(front.uvs.length / 2).toBe(front.positions.length / 3);
  });
});

describe("closed shell", () => {
  it("keeps depth at zero on the outline so front and back meet", () => {
    const w = 60, h = 40;
    const m = new Uint8Array(w * h);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 55; x++) m[y * w + x] = 1;
    const z = inflate(m, w, h);
    for (let x = 5; x < 55; x++) {
      expect(z[5 * w + x]).toBe(0);
      expect(z[34 * w + x]).toBe(0);
    }
    expect(z[20 * w + 30]).toBeGreaterThan(5);
  });
});
