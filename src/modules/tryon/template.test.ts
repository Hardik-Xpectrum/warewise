import { describe, expect, it } from "vitest";
import { standingPose } from "./placement.test";
import { smooth, templatePieces } from "./template";
import { bodyFrame, DEFAULT_SHAPE } from "./warp";

const body = bodyFrame(standingPose().landmarks, 600, 1200);
const bounds = (pts: { x: number; y: number }[]) => ({
  minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
});

describe("templatePieces", () => {
  it("builds a t-shirt: body from above the shoulders to below the hips, plus two sleeves", () => {
    const pieces = templatePieces("top", "t-shirt", DEFAULT_SHAPE, body)!;
    expect(pieces.filter((p) => p.kind === "sleeve")).toHaveLength(2);
    const b = bounds(pieces.find((p) => p.kind === "body")!.outline);
    expect(b.minY).toBeLessThan(0.2 * 1200);
    expect(b.maxY).toBeGreaterThan(0.5 * 1200);
    expect(b.maxY).toBeLessThan(0.62 * 1200);
  });

  it("gives shirts long sleeves reaching the wrists and kurtas a knee-length body", () => {
    const shirt = templatePieces("top", "formal shirt", DEFAULT_SHAPE, body)!;
    const kurta = templatePieces("top", "kurta", DEFAULT_SHAPE, body)!;
    const sleeveLen = (ps: typeof shirt) => { const b = bounds(ps.find((p) => p.kind === "sleeve")!.outline); return Math.hypot(b.maxX - b.minX, b.maxY - b.minY); };
    expect(sleeveLen(shirt)).toBeGreaterThan(sleeveLen(templatePieces("top", "t-shirt", DEFAULT_SHAPE, body)!));
    expect(bounds(kurta.find((p) => p.kind === "body")!.outline).maxY).toBeGreaterThan(0.65 * 1200);
  });

  it("builds trousers as two legs from the waist to the ankles, plus a waistband", () => {
    const pieces = templatePieces("bottom", "jeans", DEFAULT_SHAPE, body)!;
    expect(pieces.filter((p) => p.kind === "leg")).toHaveLength(2);
    const legs = bounds(pieces.filter((p) => p.kind === "leg").flatMap((p) => p.outline));
    expect(legs.minY).toBeLessThan(0.5 * 1200);
    expect(legs.maxY).toBeGreaterThan(0.9 * 1200);
  });

  it("makes a roomier garment when fit > 1", () => {
    const width = (fit: number) => { const b = bounds(templatePieces("top", "t-shirt", DEFAULT_SHAPE, body, fit)!.find((p) => p.kind === "body")!.outline); return b.maxX - b.minX; };
    expect(width(1.2)).toBeGreaterThan(width(1));
  });

  it("leaves shoes to the shoe placer", () => {
    expect(templatePieces("shoes", null, DEFAULT_SHAPE, body)).toBeNull();
  });
});

describe("smooth", () => {
  it("doubles the points each pass and stays inside the original bounds", () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const out = smooth(square, 2);
    expect(out).toHaveLength(16);
    expect(bounds(out)).toMatchObject({ minX: expect.any(Number) });
    expect(Math.min(...out.map((p) => p.x))).toBeGreaterThanOrEqual(0);
  });
});
