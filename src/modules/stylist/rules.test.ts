import { describe, expect, it } from "vitest";
import { buildRuleOutfits, climateOf, closestOutfits, explainGap, filterCandidates, pairScore, validOutfit, type Candidate } from "./rules";

let n = 0;
const item = (p: Partial<Candidate> & Pick<Candidate, "category">): Candidate => ({
  id: `id${++n}`,
  subcategory: null,
  colors: ["black"],
  pattern: "solid",
  seasons: ["all"],
  formality: 3,
  fabric: "cotton",
  lastWornDaysAgo: null,
  ...p,
});

const hot = climateOf({ city: "Pune", date: "2026-05-01", tempMaxC: 36, tempMinC: 26, rainChancePct: 0 });
const cold = climateOf({ city: "Delhi", date: "2026-01-10", tempMaxC: 14, tempMinC: 6, rainChancePct: 0 });

describe("climateOf", () => {
  it("bands temperatures and flags layers and rain", () => {
    expect(hot).toEqual({ band: "hot", rainy: false, needsLayer: false });
    expect(cold.band).toBe("cold");
    expect(cold.needsLayer).toBe(true);
    expect(climateOf({ city: "x", date: "d", tempMaxC: 28, tempMinC: 24, rainChancePct: 80 }).rainy).toBe(true);
  });
});

describe("filterCandidates", () => {
  it("drops items worn in the last 3 days, except shoes", () => {
    const shirt = item({ category: "top", lastWornDaysAgo: 1 });
    const shoes = item({ category: "shoes", lastWornDaysAgo: 0 });
    expect(filterCandidates([shirt, shoes], "casual", hot).map((c) => c.id)).toEqual([shoes.id]);
  });

  it("enforces the occasion's formality range with slack for shoes", () => {
    const tee = item({ category: "top", formality: 2 });
    const shirt = item({ category: "top", formality: 5 });
    const sneakers = item({ category: "shoes", formality: 2 });
    const ids = filterCandidates([tee, shirt, sneakers], "interview", hot).map((c) => c.id);
    expect(ids).toEqual([shirt.id]);
  });

  it("keeps heavy fabrics and outerwear out of hot days", () => {
    const wool = item({ category: "top", fabric: "wool" });
    const jacket = item({ category: "outer" });
    const linen = item({ category: "top", fabric: "linen" });
    expect(filterCandidates([wool, jacket, linen], "casual", hot).map((c) => c.id)).toEqual([linen.id]);
  });

  it("matches seasons to the climate", () => {
    const winterOnly = item({ category: "top", seasons: ["winter"] });
    expect(filterCandidates([winterOnly], "casual", hot)).toHaveLength(0);
    expect(filterCandidates([winterOnly], "casual", cold)).toHaveLength(1);
  });
});

describe("pairScore", () => {
  it("prefers a neutral with a colour over two clashing patterns", () => {
    const navy = item({ category: "bottom", colors: ["navy"] });
    const redFloral = item({ category: "top", colors: ["red"], pattern: "floral" });
    const greenChecked = item({ category: "bottom", colors: ["green"], pattern: "checked" });
    expect(pairScore(redFloral, navy)).toBeGreaterThan(pairScore(redFloral, greenChecked));
  });
});

describe("buildRuleOutfits", () => {
  it("builds complete, varied outfits and adds a layer when cold", () => {
    const tops = [item({ category: "top", colors: ["white"] }), item({ category: "top", colors: ["blue"] })];
    const bottoms = [item({ category: "bottom", colors: ["navy"] }), item({ category: "bottom", colors: ["beige"] })];
    const shoes = [item({ category: "shoes", colors: ["brown"] })];
    const outer = [item({ category: "outer", colors: ["grey"], seasons: ["winter"] })];
    const outfits = buildRuleOutfits([...tops, ...bottoms, ...shoes, ...outer], "office", cold);
    expect(outfits.length).toBe(2);
    for (const o of outfits) {
      const slots = o.items.map((i) => i.slot);
      expect(slots).toEqual(expect.arrayContaining(["top", "bottom", "shoes", "outer"]));
    }
    const mainTops = outfits.map((o) => o.items.find((i) => i.slot === "top")!.id);
    expect(new Set(mainTops).size).toBe(2);
  });

  it("returns nothing when no complete outfit exists", () => {
    expect(buildRuleOutfits([item({ category: "top" })], "casual", hot)).toEqual([]);
  });
});

describe("validOutfit", () => {
  const top = item({ category: "top" });
  const bottom = item({ category: "bottom" });
  const dress = item({ category: "one_piece" });
  const byId = new Map([top, bottom, dress].map((c) => [c.id, c]));

  it("accepts top+bottom or a one-piece", () => {
    expect(validOutfit({ why: "", items: [{ id: top.id, slot: "top" }, { id: bottom.id, slot: "bottom" }] }, byId)).toBe(true);
    expect(validOutfit({ why: "", items: [{ id: dress.id, slot: "one_piece" }] }, byId)).toBe(true);
  });

  it("rejects unknown ids, duplicates, incomplete and conflicting outfits", () => {
    expect(validOutfit({ why: "", items: [{ id: "made-up", slot: "top" }, { id: bottom.id, slot: "bottom" }] }, byId)).toBe(false);
    expect(validOutfit({ why: "", items: [{ id: top.id, slot: "top" }, { id: top.id, slot: "top" }] }, byId)).toBe(false);
    expect(validOutfit({ why: "", items: [{ id: top.id, slot: "top" }] }, byId)).toBe(false);
    expect(validOutfit({ why: "", items: [{ id: dress.id, slot: "one_piece" }, { id: bottom.id, slot: "bottom" }] }, byId)).toBe(false);
  });
});

describe("explainGap and closestOutfits", () => {
  it("says the tops are too casual for office and still offers the closest outfit", () => {
    const tee = item({ category: "top", formality: 2 });
    const jeans = item({ category: "bottom", formality: 3 });
    const shoes = item({ category: "shoes", formality: 2 });
    const all = [tee, jeans, shoes];
    expect(buildRuleOutfits(filterCandidates(all, "office", hot), "office", hot)).toEqual([]);
    expect(explainGap(all, "office", hot)).toBe("your tops are too casual for office");
    const closest = closestOutfits(all, "office", hot);
    expect(closest).toHaveLength(1);
    expect(closest[0].items.map((i) => i.id)).toEqual(expect.arrayContaining([tee.id, jeans.id]));
  });

  it("says when a category is missing entirely", () => {
    expect(explainGap([item({ category: "top" })], "casual", hot)).toBe("you have no bottoms yet");
  });
});
