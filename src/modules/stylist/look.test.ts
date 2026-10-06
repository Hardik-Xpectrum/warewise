import { describe, expect, it } from "vitest";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { completeTheLook, lookFits, shopScan } from "./look";
import type { Candidate, Climate } from "./rules";

let n = 0;
const item = (category: Category, color: string, extra: Partial<Candidate> = {}): Candidate => ({
  id: `x${++n}`,
  category,
  subcategory: null,
  colors: [color],
  pattern: "solid",
  seasons: ["all"],
  formality: 3,
  fabric: "cotton",
  lastWornDaysAgo: null,
  ...extra,
});
const warm: Climate = { band: "warm", rainy: false, needsLayer: false };

describe("lookFits", () => {
  const neutral = [item("top", "white"), item("bottom", "navy")];
  const bright = [item("top", "red"), item("bottom", "navy")];
  it("filters by mood", () => {
    expect(lookFits(neutral, "minimal")).toBe(true);
    expect(lookFits(bright, "minimal")).toBe(false);
    expect(lookFits(bright, "bold")).toBe(true);
    expect(lookFits(neutral, "bold")).toBe(false);
  });
  it("filters by colour", () => {
    expect(lookFits(bright, "any", "red")).toBe(true);
    expect(lookFits(neutral, "any", "red")).toBe(false);
  });
});

describe("completeTheLook", () => {
  it("always includes the chosen piece and picks harmonious partners", () => {
    const shirt = item("top", "maroon");
    const wardrobe = [shirt, item("bottom", "beige"), item("bottom", "purple", { pattern: "floral" }), item("shoes", "white"), item("top", "white")];
    const looks = completeTheLook(wardrobe, shirt.id, "casual", warm);
    expect(looks.length).toBeGreaterThan(0);
    for (const l of looks) expect(l.items.some((i) => i.id === shirt.id)).toBe(true);
    const first = looks[0].items.map((i) => wardrobe.find((w) => w.id === i.id)!);
    expect(first.find((p) => p.category === "bottom")!.colors[0]).toBe("beige");
    expect(first.some((p) => p.category === "shoes")).toBe(true);
  });

  it("builds full outfits around shoes", () => {
    const shoes = item("shoes", "white");
    const looks = completeTheLook([shoes, item("top", "blue"), item("bottom", "black")], shoes.id, "casual", warm);
    expect(looks[0].items.map((i) => i.slot).sort()).toEqual(["bottom", "shoes", "top"]);
  });

  it("returns nothing for an unknown item", () => {
    expect(completeTheLook([item("top", "blue")], "nope", "casual", warm)).toEqual([]);
  });
});

describe("shopScan", () => {
  const wardrobe = [item("top", "white"), item("top", "grey"), item("top", "light-blue"), item("bottom", "navy"), item("bottom", "black")];
  it("says GET IT for a versatile piece", () => {
    const r = shopScan(wardrobe, { category: "bottom", colors: ["beige"] });
    expect(r.verdict).toBe("GET IT");
    expect(r.newOutfits).toBe(3);
  });
  it("says SKIP IT for a near-copy", () => {
    const r = shopScan(wardrobe, { category: "top", colors: ["white"] });
    expect(r.similarOwned.length).toBe(1);
    expect(r.verdict).not.toBe("GET IT");
  });
  it("rewards a first pair of shoes", () => {
    expect(shopScan(wardrobe, { category: "shoes", colors: ["white"] }).verdict).toBe("GET IT");
  });
});
