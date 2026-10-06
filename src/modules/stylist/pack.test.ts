import { describe, expect, it } from "vitest";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { planDays } from "./pack";
import type { Candidate, Climate } from "./rules";

let n = 0;
const item = (category: Category, color: string, formality = 2, extra: Partial<Candidate> = {}): Candidate => ({
  id: `${category}-${color}-${++n}`, category, subcategory: null, colors: [color], pattern: "solid", seasons: ["all"], formality, fabric: "cotton", lastWornDaysAgo: null, ...extra,
});
const warm: Climate = { band: "warm", rainy: false, needsLayer: false };

const wardrobe = [
  item("top", "white"), item("top", "navy"), item("top", "maroon"), item("top", "grey"),
  item("bottom", "beige"), item("bottom", "black"), item("bottom", "blue"),
  item("shoes", "white"),
  item("top", "white", 4, { subcategory: "formal shirt" }), item("bottom", "charcoal", 4, { subcategory: "trousers" }), item("shoes", "brown", 4),
];

describe("planDays", () => {
  it("gives every day an outfit and packs far fewer pieces than outfits × pieces", () => {
    const r = planDays(wardrobe, ["casual", "casual", "casual", "casual"], warm);
    expect(r.outfitsCount).toBe(4);
    expect(r.items.length).toBeLessThan(4 * 3);
  });

  it("never repeats yesterday's top or bottom when there's an alternative", () => {
    const r = planDays(wardrobe, ["casual", "casual", "casual"], warm);
    for (let d = 1; d < r.days.length; d++) {
      const main = (i: number) => r.days[i].outfit!.items.filter((x) => x.slot !== "shoes").map((x) => x.id);
      expect(main(d).some((id) => main(d - 1).includes(id))).toBe(false);
    }
  });

  it("dresses formal days formally", () => {
    const r = planDays(wardrobe, ["casual", "office", "casual"], warm);
    const office = r.days[1].outfit!.items.map((i) => wardrobe.find((w) => w.id === i.id)!);
    expect(office.every((p) => (p.formality ?? 0) >= 3)).toBe(true);
  });

  it("leaves a day empty rather than inventing clothes", () => {
    const r = planDays([item("top", "white")], ["casual"], warm);
    expect(r.days[0].outfit).toBeNull();
    expect(r.items).toEqual([]);
  });
});
