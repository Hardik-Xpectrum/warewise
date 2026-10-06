import { describe, expect, it } from "vitest";
import { findGaps, type GapItem } from "./gaps";

const it_ = (category: string, colors: string[], formality = 2, subcategory: string | null = null): GapItem => ({ category, colors, formality, subcategory });

describe("findGaps", () => {
  it("suggests shoes first when there are none, ranked by outfits unlocked", () => {
    const gaps = findGaps([it_("top", ["red"]), it_("top", ["white"]), it_("bottom", ["navy"]), it_("bottom", ["beige"])]);
    expect(gaps[0].id).toBe("white-sneakers");
    expect(gaps[0].unlocksOutfits).toBe(4);
    expect(gaps[0].links.map((l) => l.store)).toEqual(["Myntra", "AJIO"]);
    expect(gaps[0].links[0].url).toBe("https://www.myntra.com/white-sneakers");
  });

  it("does not suggest what already exists", () => {
    const gaps = findGaps([
      it_("top", ["white"], 5, "formal shirt"), it_("top", ["blue"], 3, "kurta"),
      it_("bottom", ["grey"], 5), it_("shoes", ["black"], 5), it_("outer", ["navy"], 4),
    ]);
    expect(gaps.map((g) => g.id)).toEqual([]);
  });
});
