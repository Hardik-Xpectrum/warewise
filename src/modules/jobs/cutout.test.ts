import { describe, expect, it } from "vitest";
import { keyOutBackground } from "./cutout";

function image(w: number, h: number, bg: [number, number, number], fg: [number, number, number], box: [number, number, number, number]) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      px.set([...(inside ? fg : bg), 255], (y * w + x) * 4);
    }
  return px;
}

describe("keyOutBackground", () => {
  it("makes a plain background transparent and keeps the garment", () => {
    const w = 40, h = 40;
    const out = keyOutBackground(image(w, h, [245, 245, 240], [30, 60, 120], [10, 10, 30, 30]), w, h)!;
    expect(out[(0 * w + 0) * 4 + 3]).toBe(0);
    expect(out[(20 * w + 20) * 4 + 3]).toBe(255);
  });

  it("does not punch holes in garment areas that match the background but are enclosed", () => {
    const w = 40, h = 40;
    const px = image(w, h, [250, 250, 250], [20, 20, 20], [5, 5, 35, 35]);
    px.set([250, 250, 250, 255], (20 * w + 20) * 4); // a white button inside a black shirt
    const out = keyOutBackground(px, w, h)!;
    expect(out[(20 * w + 20) * 4 + 3]).toBe(255);
  });

  it("rejects a result where the background survives along the edges (e.g. a textured wall)", () => {
    const w = 40, h = 40;
    const px = image(w, h, [240, 240, 240], [250, 250, 250], [15, 15, 25, 25]);
    // A dark patch covering the whole left side, touching the edge: not keyed out as background.
    for (let y = 0; y < h; y++) for (let x = 0; x < 12; x++) px.set([60, 60, 60, 255], (y * w + x) * 4);
    expect(keyOutBackground(px, w, h)).toBeNull();
  });

  it("gives up on busy backgrounds", () => {
    const w = 30, h = 30;
    const px = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));
    expect(keyOutBackground(px, w, h)).toBeNull();
  });
});
