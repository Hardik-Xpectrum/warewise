import { describe, expect, it } from "vitest";
import { estimateMeasurements } from "./measure";
import { standingPose } from "./placement.test";

describe("estimateMeasurements", () => {
  it("scales photo proportions to the user's height", () => {
    const pose = standingPose({ 13: { x: 0.7, y: 0.35 }, 14: { x: 0.3, y: 0.35 }, 15: { x: 0.72, y: 0.5 }, 16: { x: 0.28, y: 0.5 } });
    const m = estimateMeasurements(pose.landmarks, 600, 1200, 175, { top_size: "M", waist_in: 32 });
    expect(m.sources).toEqual({ lengths: "photo", chest: "size", waist: "size" });
    expect(m.heightCm).toBe(175);
    expect(m.chestCm).toBe(96);
    expect(m.waistCm).toBe(81);
    // Plausible adult ranges.
    expect(m.shoulderCm).toBeGreaterThan(30);
    expect(m.shoulderCm).toBeLessThan(60);
    expect(m.inseamCm).toBeGreaterThan(60);
    expect(m.inseamCm).toBeLessThan(100);
    expect(m.torsoCm + m.inseamCm).toBeLessThan(175);
  });

  it("falls back to average proportions and estimates girths without data", () => {
    const m = estimateMeasurements(null, 0, 0, null, null);
    expect(m.sources).toEqual({ lengths: "average", chest: "estimate", waist: "estimate" });
    expect(m.heightCm).toBe(170);
    expect(m.waistCm).toBeLessThan(m.chestCm);
  });
});
