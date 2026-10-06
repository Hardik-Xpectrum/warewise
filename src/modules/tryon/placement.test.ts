import { describe, expect, it } from "vitest";
import { placeGarments, poseQuality, poseUsable, type Landmark, type Pose } from "./placement";

/** A front-facing standing figure in a 600x1200 photo (normalised coordinates). */
export function standingPose(overrides: Record<number, Partial<Landmark>> = {}): Pose {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }));
  const set = (i: number, x: number, y: number) => (lm[i] = { x, y, visibility: 0.95 });
  set(0, 0.5, 0.08); // nose
  set(11, 0.66, 0.2); set(12, 0.34, 0.2); // shoulders
  set(23, 0.6, 0.5); set(24, 0.4, 0.5); // hips
  set(25, 0.6, 0.7); set(26, 0.4, 0.7); // knees
  set(27, 0.6, 0.92); set(28, 0.4, 0.92); // ankles
  for (const [i, p] of Object.entries(overrides)) lm[Number(i)] = { ...lm[Number(i)], ...p };
  return { landmarks: lm };
}

describe("pose checks", () => {
  it("scores a full front-facing pose highly and a hidden-hips pose as unusable", () => {
    expect(poseQuality(standingPose())).toBeGreaterThan(0.85);
    expect(poseUsable(standingPose())).toBe(true);
    expect(poseUsable(standingPose({ 23: { visibility: 0.1 } }))).toBe(false);
  });

  it("penalises side-on photos", () => {
    const side = standingPose({ 11: { x: 0.52 }, 12: { x: 0.48 } });
    expect(poseQuality(side)).toBeLessThan(poseQuality(standingPose()));
  });
});

describe("placeGarments", () => {
  const W = 600, H = 1200;
  const boxes = placeGarments(standingPose(), W, H, [
    { id: "jacket", slot: "outer", aspect: 0.8 },
    { id: "tee", slot: "top", aspect: 0.83 },
    { id: "jeans", slot: "bottom", aspect: 0.7 },
    { id: "shoes", slot: "shoes", aspect: 2.3 },
    { id: "watch", slot: "accessory", aspect: 1 },
  ]);
  const by = (id: string) => boxes.find((b) => b.id === id)!;

  it("draws back to front and skips accessories", () => {
    expect(boxes.map((b) => b.id)).toEqual(["shoes", "jeans", "tee", "jacket"]);
  });

  it("puts the top over the shoulders and the bottom from the hips to the ankles", () => {
    const tee = by("tee");
    expect(tee.y).toBeLessThan(0.2 * H);
    expect(tee.y + tee.h).toBeGreaterThan(0.5 * H);
    expect(tee.x + tee.w / 2).toBeCloseTo(300, 0);
    const jeans = by("jeans");
    expect(jeans.y).toBeLessThan(0.5 * H);
    expect(jeans.y + jeans.h).toBeGreaterThan(0.88 * H);
  });

  it("keeps shoes at the feet and the jacket wider than the top", () => {
    expect(by("shoes").y).toBeGreaterThan(0.85 * H);
    expect(by("jacket").w).toBeGreaterThanOrEqual(by("tee").w);
  });

  it("keeps tall shoe photos small", () => {
    const [shoes] = placeGarments(standingPose(), W, H, [{ id: "s", slot: "shoes", aspect: 0.8 }]);
    expect(shoes.h).toBeLessThanOrEqual((0.5 - 0.2) * H * 0.35 + 0.001);
    expect(shoes.y + shoes.h).toBeLessThan(H * 1.05);
  });

  it("makes kurtas longer than t-shirts", () => {
    const [kurta] = placeGarments(standingPose(), W, H, [{ id: "k", slot: "top", subcategory: "kurta", aspect: 0.7 }]);
    expect(kurta.h).toBeGreaterThan(by("tee").h);
  });
});
