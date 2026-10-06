import "server-only";
import { z } from "zod";
import { errors } from "@/modules/platform/errors";
import type { AuthedContext } from "@/modules/platform/http";
import { BUCKET } from "@/modules/wardrobe/service";

export const UploadRequestSchema = z.object({
  contentType: z.enum(["image/webp", "image/jpeg", "image/png"]).default("image/webp"),
  purpose: z.enum(["wardrobe", "avatar", "scan"]).default("wardrobe"),
});

const EXT = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" } as const;

/**
 * Signed URL the browser uploads to directly, so the API never handles large files.
 * The path is always inside the user's own folder; storage policies enforce the same rule.
 */
const DAILY_UPLOAD_URLS = 100;

export async function createUploadUrl(ctx: AuthedContext, contentType: keyof typeof EXT, purpose: "wardrobe" | "avatar" | "scan" = "wardrobe") {
  // Each URL allows one 10 MB upload, so cap them like the other daily limits.
  const { data: count, error: capError } = await ctx.supabase.rpc("take_usage", { p_kind: "upload_urls", p_cap: DAILY_UPLOAD_URLS });
  if (capError) throw new Error(capError.message);
  if (count === -1) throw errors.quota(`You can upload ${DAILY_UPLOAD_URLS} photos a day. Try again tomorrow.`);
  // Scan views are already cut out on the device and are used as uploaded.
  const folder = purpose === "avatar" ? "raw-avatar" : purpose === "scan" ? "scan" : "raw";
  const path = `${ctx.userId}/${folder}/${crypto.randomUUID()}.${EXT[contentType]}`;
  const { data, error } = await ctx.supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw errors.badRequest(`Could not create upload URL: ${error?.message ?? "unknown"}`);
  return { path, token: data.token, signedUrl: data.signedUrl, expiresInSeconds: 7200 };
}
