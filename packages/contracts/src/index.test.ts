import { describe, expect, it } from "vitest";
import { ItemProcessed, renderCacheKey, signServiceToken, verifyServiceToken } from "./index";

describe("service tokens", () => {
  const secret = "test-secret-at-least-32-characters-long";
  it("accepts a fresh token for the right audience", () => {
    expect(verifyServiceToken(`Service ${signServiceToken("web", "tryon", secret)}`, "tryon", secret)).toEqual({ ok: true, iss: "web" });
  });
  it("rejects the wrong audience, a bad signature and an expired token", () => {
    const t = signServiceToken("web", "tryon", secret);
    expect(verifyServiceToken(t, "avatar", secret).ok).toBe(false);
    expect(verifyServiceToken(t, "tryon", "another-secret-also-long-enough-xx").ok).toBe(false);
    expect(verifyServiceToken(signServiceToken("web", "tryon", secret, -1), "tryon", secret).ok).toBe(false);
  });
});

describe("render cache key", () => {
  const g = (itemId: string, updatedAt = "2026-10-01") => ({ itemId, slot: "top" as const, description: "", imagePath: "", cutoutPath: null, updatedAt });
  it("ignores garment order but changes when a garment is edited", () => {
    const a = renderCacheKey({ personImagePath: "p", avatarVersion: 1, garments: [g("a"), g("b")] });
    expect(renderCacheKey({ personImagePath: "p", avatarVersion: 1, garments: [g("b"), g("a")] })).toBe(a);
    expect(renderCacheKey({ personImagePath: "p", avatarVersion: 1, garments: [g("a", "2026-10-02"), g("b")] })).not.toBe(a);
    expect(renderCacheKey({ personImagePath: "p", avatarVersion: 2, garments: [g("a"), g("b")] })).not.toBe(a);
    expect(renderCacheKey({ personImagePath: "p", avatarVersion: 1, garments: [g("a"), g("b")] }, "composite")).not.toBe(a);
  });
});

describe("events", () => {
  it("validates an item.processed event", () => {
    const id = "6f4a9a5a-0e85-4d1c-b8e8-325960fa650b";
    expect(ItemProcessed.safeParse({ type: "item.processed", jobId: id, userId: id, itemId: id, ok: false, error: { message: "x", userFacing: true, retryable: false } }).success).toBe(true);
  });
});
