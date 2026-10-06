import { describe, expect, it } from "vitest";
import { fitFor, parseSizeLabel } from "./fit";

describe("parseSizeLabel", () => {
  it("reads letter, waist, chest and shoe sizes", () => {
    expect(parseSizeLabel(" xl ", "top")).toEqual({ top: 4 });
    expect(parseSizeLabel("W32 L30", "bottom")).toEqual({ waist: 32 });
    expect(parseSizeLabel("40", "top")).toEqual({ top: 3 });
    expect(parseSizeLabel("UK 9.5", "shoes")).toEqual({ shoe: 9.5 });
    expect(parseSizeLabel("free size", "top")).toEqual({});
  });
});

describe("fitFor", () => {
  it("scales and explains the fit against the user's sizes", () => {
    expect(fitFor("top", "L", { top_size: "M" })).toMatchObject({ scale: 1.08, note: "1 size big: relaxed fit" });
    expect(fitFor("top", "S", { top_size: "L" }).note).toBe("2 sizes small: too tight fit");
    expect(fitFor("bottom", "34", { waist_in: 32 }).note).toContain("loose");
    expect(fitFor("shoes", "UK 9", { shoe_uk: 9 }).note).toBe("Your shoe size");
  });

  it("does nothing without sizes", () => {
    expect(fitFor("top", "M", {})).toEqual({ scale: 1, note: null });
    expect(fitFor("top", null, { top_size: "M" })).toEqual({ scale: 1, note: null });
  });
});
