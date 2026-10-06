import { describe, expect, it } from "vitest";
import { harmonyScore } from "./harmony";

const p = (color: string, pattern = "solid", formality = 3) => ({ colors: [color], pattern, formality });

describe("harmonyScore", () => {
  it("rates one accent colour on neutrals highest", () => {
    const accent = harmonyScore([p("maroon"), p("beige"), p("brown")]);
    const neutral = harmonyScore([p("white"), p("navy"), p("black")]);
    expect(accent.score).toBeGreaterThanOrEqual(neutral.score);
    expect(accent.label).toBe("Great harmony");
    expect(accent.reasons[0]).toContain("maroon");
  });

  it("marks competing colours and double patterns as clashing", () => {
    const clash = harmonyScore([p("green", "checked"), p("purple", "floral"), p("orange")]);
    expect(clash.score).toBeLessThan(55);
    expect(clash.label).toBe("Clashing");
    expect(clash.reasons.some((r) => r.includes("patterns"))).toBe(true);
  });

  it("rewards analogous colours over clashing ones", () => {
    expect(harmonyScore([p("blue"), p("light-blue"), p("white")]).score).toBeGreaterThan(harmonyScore([p("green"), p("red"), p("white")]).score - 0);
    expect(harmonyScore([p("yellow"), p("purple"), p("white")]).reasons.join(" ")).toContain("Complementary");
  });

  it("penalises mixing very casual and very formal pieces", () => {
    expect(harmonyScore([p("white", "solid", 1), p("navy", "solid", 5)]).score).toBeLessThan(harmonyScore([p("white", "solid", 3), p("navy", "solid", 4)]).score);
  });

  it("stays within 0 to 100", () => {
    const s = harmonyScore([p("red", "floral", 1), p("green", "checked", 5), p("purple", "striped"), p("orange", "printed"), p("yellow")]).score;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
