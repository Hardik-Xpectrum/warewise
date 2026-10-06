import "server-only";
import { z } from "zod";
import { errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import { withImageUrls, type ItemRow } from "@/modules/wardrobe/service";

export const CreateOutfitSchema = z.object({
  name: z.string().trim().min(1).max(80),
  occasion: z.string().trim().max(40).optional(),
  itemIds: z.array(z.uuid()).min(1).max(8),
});

export const PatchOutfitSchema = z
  .object({ name: z.string().trim().min(1).max(80), is_favorite: z.boolean(), saved: z.boolean() })
  .partial()
  .strict();

export const WearLogSchema = z
  .object({
    outfitId: z.uuid().optional(),
    itemIds: z.array(z.uuid()).max(8).optional(),
    wornOn: z.iso.date().optional(),
  })
  .refine((v) => v.outfitId || v.itemIds?.length, "Give an outfitId or itemIds");

type OutfitRow = {
  id: string;
  name: string | null;
  occasion: string | null;
  source: string;
  is_favorite: boolean;
  created_at: string;
  outfit_items: { slot: string; wardrobe_items: ItemRow | null }[];
};

export async function listSavedOutfits(ctx: AuthedContext, favoritesOnly = false) {
  let q = ctx.supabase
    .from("outfits")
    .select("id,name,occasion,source,is_favorite,created_at,outfit_items(slot,wardrobe_items(*))")
    .eq("saved", true)
    .order("created_at", { ascending: false })
    .limit(100);
  if (favoritesOnly) q = q.eq("is_favorite", true);
  const rows = must(await q, "List outfits") as unknown as OutfitRow[];

  const items = rows.flatMap((o) => o.outfit_items.map((oi) => oi.wardrobe_items).filter((i): i is ItemRow => Boolean(i)));
  const dtos = new Map((await withImageUrls(ctx.supabase, items)).map((d) => [d.id, d]));

  const { data: wears } = await ctx.supabase.from("wear_log").select("outfit_id,worn_on").not("outfit_id", "is", null);
  const wearCount = new Map<string, number>();
  for (const w of wears ?? []) wearCount.set(w.outfit_id as string, (wearCount.get(w.outfit_id as string) ?? 0) + 1);

  return rows.map((o) => ({
    id: o.id,
    name: o.name,
    occasion: o.occasion,
    source: o.source,
    isFavorite: o.is_favorite,
    createdAt: o.created_at,
    timesWorn: wearCount.get(o.id) ?? 0,
    items: o.outfit_items
      .filter((oi) => oi.wardrobe_items)
      .map((oi) => {
        const d = dtos.get(oi.wardrobe_items!.id)!;
        return { id: d.id, slot: oi.slot, subcategory: d.subcategory, colors: d.colors, thumbUrl: d.thumbUrl };
      }),
  }));
}

export async function createManualOutfit(ctx: AuthedContext, input: z.infer<typeof CreateOutfitSchema>) {
  const items = must(
    await ctx.supabase.from("wardrobe_items").select("id,category").in("id", input.itemIds).eq("status", "ready"),
    "Load items",
  ) as { id: string; category: string | null }[];
  if (items.length !== new Set(input.itemIds).size || items.some((i) => !i.category)) {
    throw errors.badRequest("Some items are missing or not tagged yet");
  }
  const outfit = must(
    await ctx.supabase
      .from("outfits")
      .insert({ user_id: ctx.userId, name: input.name, occasion: input.occasion ?? null, source: "manual", saved: true })
      .select("id")
      .single(),
    "Create outfit",
  ) as { id: string };
  must(
    await ctx.supabase.from("outfit_items").insert(items.map((i) => ({ outfit_id: outfit.id, item_id: i.id, slot: i.category, user_id: ctx.userId }))),
    "Add outfit items",
  );
  return outfit;
}

export async function patchOutfit(ctx: AuthedContext, id: string, patch: z.infer<typeof PatchOutfitSchema>) {
  const { data } = await ctx.supabase.from("outfits").update(patch).eq("id", id).select("id").maybeSingle();
  if (!data) throw errors.notFound("Outfit");
}

export async function deleteOutfit(ctx: AuthedContext, id: string) {
  const { data } = await ctx.supabase.from("outfits").delete().eq("id", id).select("id").maybeSingle();
  if (!data) throw errors.notFound("Outfit");
}

export async function logWear(ctx: AuthedContext, input: z.infer<typeof WearLogSchema>) {
  let itemIds = input.itemIds ?? [];
  if (input.outfitId) {
    const rows = must(
      await ctx.supabase.from("outfit_items").select("item_id").eq("outfit_id", input.outfitId),
      "Load outfit",
    ) as { item_id: string }[];
    if (!rows.length) throw errors.notFound("Outfit");
    itemIds = rows.map((r) => r.item_id);
  }
  const entry = must(
    await ctx.supabase
      .from("wear_log")
      .insert({ user_id: ctx.userId, outfit_id: input.outfitId ?? null, ...(input.wornOn ? { worn_on: input.wornOn } : {}) })
      .select("id,worn_on")
      .single(),
    "Log wear",
  ) as { id: string; worn_on: string };
  must(
    await ctx.supabase.from("wear_log_items").insert([...new Set(itemIds)].map((item_id) => ({ wear_log_id: entry.id, item_id, user_id: ctx.userId }))),
    "Log worn items",
  );
  return entry;
}
