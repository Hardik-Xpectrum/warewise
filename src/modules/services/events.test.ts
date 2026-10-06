import { describe, expect, it } from "vitest";
import { avatarFailedPatch, itemPatch, tryonPatch } from "./events";

const U = "6f4a9a5a-0e85-4d1c-b8e8-325960fa650b";
const now = new Date("2026-10-05T10:00:00Z");

describe("itemPatch", () => {
  it("fills the item from the service's tags and files", () => {
    const p = itemPatch({
      type: "item.processed", jobId: U, userId: U, itemId: U, ok: true, phash: "abc",
      tags: { category: "top", subcategory: "kurta", colors: ["mustard"], pattern: "solid", seasons: ["all"], fabric: "cotton", formality: 3, fit: "regular", brand: null, confidence: 0.9, model: "local-vision" },
      paths: { clean: `${U}/clean/x.webp`, thumb: `${U}/thumb/x.webp`, cutout: null },
    });
    expect(p).toMatchObject({ status: "ready", category: "top", subcategory: "kurta", colors: ["mustard"], cutout_path: null, image_path: `${U}/clean/x.webp`, phash: "abc" });
  });

  it("shows the service's message only when it's meant for people", () => {
    const base = { type: "item.processed" as const, jobId: U, userId: U, itemId: U, ok: false };
    expect(itemPatch({ ...base, error: { message: "This photo doesn't look like clothing", userFacing: true, retryable: false } }).status_reason).toBe("This photo doesn't look like clothing");
    expect(itemPatch({ ...base, error: { message: "upload: 500 internal", userFacing: false, retryable: true } }).status_reason).toMatch(/couldn't process/);
  });
});

describe("tryonPatch and avatarFailedPatch", () => {
  it("marks a render ready with its note, or failed with the reason", () => {
    expect(tryonPatch({ type: "tryon.ready", jobId: U, userId: U, renderPath: `${U}/tryon/r.webp`, note: "AI dressed the top." }, now)).toEqual({
      status: "ready", result_path: `${U}/tryon/r.webp`, engine: "service:tryon", error: "AI dressed the top.", finished_at: now.toISOString(),
    });
    expect(tryonPatch({ type: "tryon.failed", jobId: U, userId: U, message: "The free GPU time is used up", quota: true }, now)).toMatchObject({ status: "failed", error: "The free GPU time is used up" });
  });

  it("marks a 3D build failed", () => {
    expect(avatarFailedPatch({ type: "avatar.failed", jobId: U, userId: U, message: "No 3D service could take the photo", retryable: true }, now)).toMatchObject({ status: "failed", provider_ref: null });
  });
});
