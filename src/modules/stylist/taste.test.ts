import { describe, expect, it } from "vitest";
import type { Category } from "@/modules/wardrobe/taxonomy";
import type { Candidate } from "./rules";
import { describeTaste, learnTaste, neglected, tasteScore } from "./taste";

const item = (id: string, category: Category, color: string, extra: Partial<Candidate> = {}): Candidate => ({
  id, category, subcategory: null, colors: [color], pattern: "solid", seasons: ["all"], formality: 3, fabric: null, lastWornDaysAgo: null, ...extra,
});

const navyTee = item("t1", "top", "navy");
const redTee = item("t2", "top", "red", { pattern: "floral" });
const beige = item("b1", "bottom", "beige");
const black = item("b2", "bottom", "black");
const byId = new Map([navyTee, redTee, beige, black].map((c) => [c.id, c]));

describe("learnTaste", () => {
  const taste = learnTaste(
    [
      { kind: "like", itemIds: ["t1", "b1"], daysAgo: 1 },
      { kind: "worn", itemIds: ["t1", "b1"], daysAgo: 3 },
      { kind: "dislike", itemIds: ["t2", "b2"], daysAgo: 2 },
    ],
    byId,
  );

  it("scores liked combinations above disliked ones", () => {
    expect(tasteScore(taste, [navyTee, beige])).toBeGreaterThan(0.5);
    expect(tasteScore(taste, [redTee, black])).toBeLessThan(0);
  });

  it("is neutral with no history", () => {
    expect(tasteScore(learnTaste([], byId), [navyTee, beige])).toBe(0);
    expect(tasteScore(null, [navyTee, beige])).toBe(0);
  });

  it("summarises the taste in plain words", () => {
    const text = describeTaste(taste)!;
    expect(text).toContain("likes");
    expect(text).toContain("navy");
    expect(text).toContain("prefers plain pieces");
  });

  it("forgets old signals", () => {
    const fresh = learnTaste([{ kind: "like", itemIds: ["t1"], daysAgo: 0 }], byId);
    const old = learnTaste([{ kind: "like", itemIds: ["t1"], daysAgo: 180 }], byId);
    expect(tasteScore(fresh, [navyTee])).toBeGreaterThan(tasteScore(old, [navyTee]));
  });
});

describe("neglected", () => {
  it("lists clothes not worn for a month, longest first, skipping shoes", () => {
    const list = neglected([
      item("a", "top", "white", { lastWornDaysAgo: 40 }),
      item("b", "top", "grey", { lastWornDaysAgo: 5 }),
      item("c", "bottom", "navy", { lastWornDaysAgo: null }),
      item("d", "shoes", "white", { lastWornDaysAgo: null }),
    ]);
    expect(list.map((c) => c.id)).toEqual(["c", "a"]);
  });
});
