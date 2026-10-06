import "server-only";
import { PHOTO_CACHE_CONTROL } from "@/modules/media/signing";
import sharp from "sharp";
import { errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { BUCKET } from "@/modules/wardrobe/service";
import { garmentSvg, SAMPLE_ITEMS, SAMPLE_OUTFITS } from "./garments";

/** Adds 12 illustrated items and 3 saved outfits so every feature can be tried without photos. */
export async function loadSamples(ctx: AuthedContext) {
  const { count } = await ctx.supabase.from("wardrobe_items").select("id", { count: "exact", head: true }).eq("is_sample", true);
  if (count) throw errors.conflict("Sample items are already in your wardrobe");

  const store = ctx.supabase.storage.from(BUCKET);
  const ids = new Map<string, string>();
  for (const s of SAMPLE_ITEMS) {
    const id = crypto.randomUUID();
    const png = await sharp(Buffer.from(garmentSvg(s.shape, s.hex))).resize({ width: 640 }).png().toBuffer();
    const cutout = await sharp(png).trim({ threshold: 1 }).webp({ quality: 88, alphaQuality: 90 }).toBuffer();
    const thumb = await sharp(png).resize({ width: 320, height: 320, fit: "inside" }).webp({ quality: 80 }).toBuffer();
    const files: [string, Buffer][] = [
      [`${ctx.userId}/clean/${id}.webp`, cutout],
      [`${ctx.userId}/thumb/${id}.webp`, thumb],
    ];
    for (const [path, body] of files) {
      const up = await store.upload(path, body, { contentType: "image/webp", upsert: true, cacheControl: PHOTO_CACHE_CONTROL });
      if (up.error) throw new Error(`upload sample: ${up.error.message}`);
    }
    must(
      await ctx.supabase.from("wardrobe_items").insert({
        id,
        user_id: ctx.userId,
        status: "ready",
        is_sample: true,
        user_verified: true,
        category: s.category,
        subcategory: s.subcategory,
        colors: s.colors,
        pattern: s.pattern,
        seasons: s.seasons,
        fabric: s.fabric,
        formality: s.formality,
        fit: s.fit,
        price_inr: s.price_inr,
        notes: "Sample item",
        image_path: files[0][0],
        clean_path: files[0][0],
        thumb_path: files[1][0],
        cutout_path: files[0][0],
      }),
      "Add sample item",
    );
    ids.set(s.key, id);
  }

  for (const o of SAMPLE_OUTFITS) {
    const outfit = must(
      await ctx.supabase
        .from("outfits")
        .insert({ user_id: ctx.userId, name: o.name, occasion: o.occasion, source: "manual", saved: true, is_sample: true })
        .select("id")
        .single(),
      "Add sample outfit",
    ) as { id: string };
    must(
      await ctx.supabase.from("outfit_items").insert(
        o.keys.map((k) => ({ outfit_id: outfit.id, item_id: ids.get(k)!, user_id: ctx.userId, slot: SAMPLE_ITEMS.find((s) => s.key === k)!.category })),
      ),
      "Add sample outfit items",
    );
  }
  return { items: SAMPLE_ITEMS.length, outfits: SAMPLE_OUTFITS.length };
}

export async function removeSamples(ctx: AuthedContext) {
  const rows = must(
    await ctx.supabase.from("wardrobe_items").select("id,image_path,clean_path,thumb_path,cutout_path").eq("is_sample", true),
    "Find samples",
  ) as { image_path: string; clean_path: string | null; thumb_path: string | null; cutout_path: string | null }[];
  must(await ctx.supabase.from("outfits").delete().eq("is_sample", true), "Remove sample outfits");
  must(await ctx.supabase.from("wardrobe_items").delete().eq("is_sample", true), "Remove sample items");
  const paths = [...new Set(rows.flatMap((r) => [r.image_path, r.clean_path, r.thumb_path, r.cutout_path]))].filter((p): p is string => Boolean(p));
  if (paths.length) await ctx.supabase.storage.from(BUCKET).remove(paths);
  return { removed: rows.length };
}
