import { describe, expect, it } from "vitest";
import { dHashFromPixels, hammingHex } from "./phash";

describe("perceptual hash", () => {
  it("hashes a 9x8 gradient into 16 hex chars", () => {
    const pixels = Uint8Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20);
    const hash = dHashFromPixels(pixels);
    expect(hash).toHaveLength(16);
    expect(hash).toBe("ffffffffffffffff");
  });

  it("counts differing bits", () => {
    expect(hammingHex("ff00", "ff00")).toBe(0);
    expect(hammingHex("ff00", "fe00")).toBe(1);
    expect(hammingHex("0000", "ffff")).toBe(16);
    expect(hammingHex("00", "0000")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
