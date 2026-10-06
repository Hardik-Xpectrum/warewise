import { describe, expect, it } from "vitest";
import { placeGarments, poseQuality, poseUsable } from "./placement";
import { SAMPLE_MODEL } from "./sampleModel";

describe("sample model", () => {
  it("has a complete, usable, front-facing pose", () => {
    expect(SAMPLE_MODEL.pose.landmarks).toHaveLength(33);
    expect(poseUsable(SAMPLE_MODEL.pose)).toBe(true);
    expect(poseQuality(SAMPLE_MODEL.pose)).toBeGreaterThan(0.9);
  });

  it("places a top on the torso and trousers below it", () => {
    const [bottom, top] = placeGarments(SAMPLE_MODEL.pose, SAMPLE_MODEL.width, SAMPLE_MODEL.height, [
      { id: "t", slot: "top", aspect: 0.9 },
      { id: "b", slot: "bottom", aspect: 0.45 },
    ]);
    expect(top.slot).toBe("top");
    expect(top.y).toBeLessThan(400);
    expect(bottom.y + bottom.h).toBeGreaterThan(1200);
  });
});
