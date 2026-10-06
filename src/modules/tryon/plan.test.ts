import { describe, expect, it } from "vitest";
import { planPasses, retryHint } from "./plan";

describe("planPasses", () => {
  it("dresses the top first, then the bottom", () => {
    const p = planPasses([{ id: "b", slot: "bottom" }, { id: "t", slot: "top" }, { id: "s", slot: "shoes" }]);
    expect(p.map((x) => [x.garmentId, x.region])).toEqual([["t", "upper_body"], ["b", "lower_body"]]);
  });
  it("prefers the visible layer over the top under it", () => {
    expect(planPasses([{ id: "t", slot: "top" }, { id: "o", slot: "outer" }])[0].garmentId).toBe("o");
  });
  it("uses one pass for a dress", () => {
    expect(planPasses([{ id: "d", slot: "one_piece" }, { id: "b", slot: "bottom" }])).toEqual([{ garmentId: "d", region: "dresses", model: "dress_code", label: "dress" }]);
  });
  it("handles a bottom alone and nothing wearable", () => {
    expect(planPasses([{ id: "b", slot: "bottom" }]).map((x) => x.region)).toEqual(["lower_body"]);
    expect(planPasses([{ id: "s", slot: "shoes" }])).toEqual([]);
  });
});

describe("retryHint", () => {
  it("turns the quota wait into plain words", () => {
    expect(retryHint("Try again in 18:52:11. Authenticate")).toBe("in about 19 hours");
    expect(retryHint("try again in 0:04:10")).toBe("in about 5 minutes");
    expect(retryHint("no hint")).toBeNull();
  });
});
