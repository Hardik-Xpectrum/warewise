import { describe, expect, it } from "vitest";
import { cutoutLabels, GARMENTS, namedColors, nearestColor, NOT_CLOTHING, PATTERN_PROMPTS, pickGarment, pickPattern } from "./localVision";

const scoresWith = (winner: number, n = GARMENTS.length + NOT_CLOTHING.length) => Array.from({ length: n }, (_, i) => (i === winner ? 0.6 : 0.4 / (n - 1)));

describe("pickGarment", () => {
  it("maps the winning label to the app's tags", () => {
    const kurta = GARMENTS.findIndex((g) => g.subcategory === "kurta");
    const { garment, confidence } = pickGarment(scoresWith(kurta));
    expect(garment).toMatchObject({ category: "top", subcategory: "kurta" });
    expect(confidence).toBeGreaterThan(0.6); // category siblings add to the confidence
  });

  it("returns no garment when a not-clothing label wins", () => {
    expect(pickGarment(scoresWith(GARMENTS.length + 1)).garment).toBeNull();
  });
});

describe("pickPattern", () => {
  const keys = Object.keys(PATTERN_PROMPTS);
  const at = (values: Record<string, number>) => keys.map((k) => values[k] ?? 0.05);

  it("prefers solid unless a pattern clearly leads", () => {
    expect(pickPattern(at({ solid: 0.3, striped: 0.4 }))).toBe("solid");
    expect(pickPattern(at({ solid: 0.2, striped: 0.5 }))).toBe("striped");
  });

  it("needs an even bigger lead for embroidery", () => {
    expect(pickPattern(at({ solid: 0.2, embroidered: 0.5 }))).toBe("solid");
    expect(pickPattern(at({ solid: 0.1, embroidered: 0.6 }))).toBe("embroidered");
  });
});

describe("colours", () => {
  it("names common garment colours", () => {
    expect(nearestColor([30, 42, 77])).toBe("navy");
    expect(nearestColor([201, 162, 39])).toBe("mustard");
    expect(nearestColor([250, 250, 250])).toBe("white");
    expect(nearestColor([190, 190, 190])).toBe("grey"); // plain fabric isn't "silver"
  });

  it("ignores transparent pixels and ranks colours by share", () => {
    const px = (r: number, g: number, b: number, a: number, n: number) => Array.from({ length: n }, () => [r, g, b, a]).flat();
    const rgba = new Uint8Array([...px(30, 42, 77, 255, 70), ...px(250, 250, 250, 255, 30), ...px(200, 0, 0, 0, 200)]);
    expect(namedColors(rgba, 0.12, 1)).toEqual(["navy", "white"]);
  });
});

describe("cutoutLabels", () => {
  it("keeps only the category's parts when someone is wearing it", () => {
    expect(cutoutLabels({ Face: 0.02, "Upper-clothes": 0.3, Pants: 0.2 }, "top")).toEqual(["Upper-clothes", "Dress"]);
  });

  it("keeps all clothing on a product photo", () => {
    expect(cutoutLabels({ Dress: 0.4 }, "top")).toContain("Pants");
  });
});
