import { describe, expect, it } from "vitest";
import { slotFor, takeOff, wear } from "./wear";

const shirt = { id: "shirt", category: "top", subcategory: "shirt" };
const kurta = { id: "kurta", category: "top", subcategory: "kurta" };
const blazer = { id: "blazer", category: "outer", subcategory: "blazer" };
const mistagged = { id: "overshirt?", category: "outer", subcategory: "linen shirt" };
const jeans = { id: "jeans", category: "bottom", subcategory: "jeans" };
const dress = { id: "dress", category: "one_piece", subcategory: "dress" };

describe("wear", () => {
  it("replaces the top and drops the layer when a new top is chosen", () => {
    let w = wear({}, blazer);
    w = wear(w, shirt);
    expect(w).toEqual({ top: "shirt" }); // the blazer then the kurta no longer pile up
    w = wear(w, kurta);
    expect(w).toEqual({ top: "kurta" });
  });

  it("adds a real layer over the current top", () => {
    expect(wear(wear({}, shirt), blazer)).toEqual({ top: "shirt", outer: "blazer" });
  });

  it("treats a shirt filed under layers as a top", () => {
    expect(slotFor(mistagged)).toBe("top");
    expect(wear({ top: "kurta" }, mistagged)).toEqual({ top: "overshirt?" });
  });

  it("swaps a dress for top and bottom, and back", () => {
    const w = wear({ top: "shirt", bottom: "jeans" }, dress);
    expect(w).toEqual({ one_piece: "dress" });
    expect(wear(w, jeans)).toEqual({ bottom: "jeans" });
  });

  it("takes a piece off when tapped again, or from the wearing bar", () => {
    expect(wear({ top: "shirt", bottom: "jeans" }, shirt)).toEqual({ bottom: "jeans" });
    expect(takeOff({ top: "shirt", bottom: "jeans" }, "bottom")).toEqual({ top: "shirt" });
  });
});
