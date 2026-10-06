"use client";
import { api } from "@/lib/api";
import { prepareAvatarPhoto } from "@/lib/pose";
import { browserClient } from "@/lib/supabase/browser";

/** Cuts out and measures a photo on this device, uploads the cut-out and registers it as an avatar photo. */
export async function uploadAvatarPhoto(file: Blob, onStep?: (step: string) => void): Promise<{ id: string; warnings: string[] }> {
  onStep?.("finding you in the photo (on this device)");
  const prepared = await prepareAvatarPhoto(file);
  onStep?.("uploading");
  const target = await api<{ path: string; token: string }>("/uploads", { method: "POST", json: { contentType: prepared.blob.type, purpose: "avatar" } });
  const { error } = await browserClient().storage.from("wardrobe").uploadToSignedUrl(target.path, target.token, prepared.blob, { contentType: prepared.blob.type });
  if (error) throw new Error(error.message);
  const added = await api<{ id: string }>("/avatar/photos", { method: "POST", json: { imagePath: target.path, pose: { landmarks: prepared.landmarks } } });
  return { id: added.id, warnings: prepared.warnings };
}
