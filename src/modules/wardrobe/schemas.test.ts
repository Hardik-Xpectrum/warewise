import { describe, expect, it } from "vitest";
import { extractJson } from "@/modules/ai/json";
import { ItemPatchSchema, TaggerOutputSchema } from "./schemas";

describe("TaggerOutputSchema", () => {
  it("accepts a typical model reply wrapped in a code fence and cleans it up", () => {
    const reply = 'Sure!\n```json\n{"is_clothing": true, "item_count": 1, "category": "top", "subcategory": " Kurta ", "colors": ["Navy", "sparkly"], "pattern": "zigzag", "seasons": ["spring"], "fabric": "Cotton", "formality": "4", "fit": "regular", "brand": null, "confidence": 0.9}\n```';
    const tags = TaggerOutputSchema.parse(extractJson(reply));
    expect(tags).toMatchObject({ subcategory: "kurta", colors: ["navy"], pattern: "other", seasons: ["all"], fabric: "cotton", formality: 4 });
  });

  it("rejects an unknown category", () => {
    const result = TaggerOutputSchema.safeParse({ is_clothing: true, category: "hat", colors: [], seasons: [], formality: 2 });
    expect(result.success).toBe(false);
  });
});

describe("ItemPatchSchema", () => {
  it("rejects fields users may not set", () => {
    expect(ItemPatchSchema.safeParse({ user_id: "someone-else" }).success).toBe(false);
    expect(ItemPatchSchema.safeParse({ colors: ["navy", "white"], formality: 3 }).success).toBe(true);
  });
});
