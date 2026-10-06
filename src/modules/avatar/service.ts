import "server-only";
import { PHOTO_CACHE_CONTROL, signedUrls } from "@/modules/media/signing";
import sharp from "sharp";
import { z } from "zod";
import { errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { poseQuality, poseUsable } from "@/modules/tryon/placement";
import { BUCKET } from "@/modules/wardrobe/service";

export const MAX_AVATAR_PHOTOS = 5;

const LandmarkSchema = z.object({
  x: z.number().min(-0.5).max(1.5),
  y: z.number().min(-0.5).max(1.5),
  z: z.number().optional(),
  visibility: z.number().min(0).max(1).optional(),
});

export const AddAvatarPhotoSchema = z.object({
  imagePath: z.string().min(1).max(300),
  pose: z.object({ landmarks: z.array(LandmarkSchema).length(33) }),
});

type AvatarRow = { id: string; path: string; width: number; height: number; pose: unknown; quality: number; is_primary: boolean; created_at: string };

export async function listAvatarPhotos(ctx: AuthedContext) {
  const rows = must(
    await ctx.supabase.from("avatar_photos").select("id,path,width,height,pose,quality,is_primary,created_at").order("created_at"),
    "List avatar",
  ) as AvatarRow[];
  const urls = await signedUrls(ctx.supabase, BUCKET, rows.map((r) => r.path));
  return { max: MAX_AVATAR_PHOTOS, photos: rows.map(({ path, ...r }) => ({ ...r, imageUrl: urls.get(path) ?? null })) };
}

/**
 * Registers a photo the browser has already cut out (person segmentation) and measured (pose),
 * both on the device. The server re-encodes it without metadata and keeps it in the user's folder.
 */
export async function addAvatarPhoto(ctx: AuthedContext, input: z.infer<typeof AddAvatarPhotoSchema>) {
  if (!input.imagePath.startsWith(`${ctx.userId}/raw-avatar/`)) throw errors.badRequest("imagePath is not an avatar upload of yours");
  if (!poseUsable(input.pose)) throw errors.badRequest("We couldn't find your shoulders and hips. Use a front-facing photo showing at least your upper body and hips.");

  const { count } = await ctx.supabase.from("avatar_photos").select("id", { count: "exact", head: true });
  if ((count ?? 0) >= MAX_AVATAR_PHOTOS) throw errors.conflict(`You can keep up to ${MAX_AVATAR_PHOTOS} avatar photos. Delete one first.`);

  const store = ctx.supabase.storage.from(BUCKET);
  const raw = await store.download(input.imagePath);
  if (raw.error || !raw.data) throw errors.badRequest("Upload not found");
  let image: Buffer;
  let width: number;
  let height: number;
  try {
    const out = await sharp(Buffer.from(await raw.data.arrayBuffer()))
      .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, alphaQuality: 90 })
      .toBuffer({ resolveWithObject: true });
    image = out.data;
    width = out.info.width;
    height = out.info.height;
  } catch {
    throw errors.badRequest("This file is not a readable image");
  } finally {
    await store.remove([input.imagePath]);
  }

  const id = crypto.randomUUID();
  const path = `${ctx.userId}/avatar/${id}.webp`;
  const up = await store.upload(path, image, { contentType: "image/webp", cacheControl: PHOTO_CACHE_CONTROL });
  if (up.error) throw new Error(`upload avatar: ${up.error.message}`);

  const { count: existing } = await ctx.supabase.from("avatar_photos").select("id", { count: "exact", head: true }).eq("is_primary", true);
  const { data, error } = await ctx.supabase
    .from("avatar_photos")
    .insert({ id, user_id: ctx.userId, path, width, height, pose: input.pose, quality: poseQuality(input.pose), is_primary: !existing })
    .select("id")
    .single();
  if (error) {
    await store.remove([path]);
    if (error.code === "P0001") throw errors.conflict(`You can keep up to ${MAX_AVATAR_PHOTOS} avatar photos. Delete one first.`);
    throw new Error(error.message);
  }
  return data as { id: string };
}

export async function setPrimary(ctx: AuthedContext, id: string) {
  const { data } = await ctx.supabase.from("avatar_photos").select("id").eq("id", id).maybeSingle();
  if (!data) throw errors.notFound("Avatar photo");
  must(await ctx.supabase.from("avatar_photos").update({ is_primary: false }).eq("is_primary", true), "Update avatar");
  must(await ctx.supabase.from("avatar_photos").update({ is_primary: true }).eq("id", id), "Update avatar");
}

export async function deleteAvatarPhoto(ctx: AuthedContext, id: string) {
  const { data } = await ctx.supabase.from("avatar_photos").select("id,path,is_primary").eq("id", id).maybeSingle();
  if (!data) throw errors.notFound("Avatar photo");
  must(await ctx.supabase.from("avatar_photos").delete().eq("id", id), "Delete avatar photo");
  await ctx.supabase.storage.from(BUCKET).remove([data.path]);
  if (data.is_primary) {
    // Promote the best remaining photo.
    const { data: next } = await ctx.supabase.from("avatar_photos").select("id").order("quality", { ascending: false }).limit(1).maybeSingle();
    if (next) await ctx.supabase.from("avatar_photos").update({ is_primary: true }).eq("id", next.id);
  }
}
