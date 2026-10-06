import "server-only";
import { signedUrls } from "@/modules/media/signing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errors } from "@/modules/platform/errors";
import { must } from "@/modules/platform/http";
import { hammingHex } from "@/modules/jobs/phash";
import type { ItemListQuery, ItemPatch } from "./schemas";

export const BUCKET = "wardrobe";

export type ItemRow = {
  id: string;
  status: "processing" | "ready" | "failed";
  status_reason: string | null;
  lifecycle: "active" | "laundry" | "lent" | "archived";
  category: string | null;
  subcategory: string | null;
  colors: string[];
  pattern: string | null;
  seasons: string[];
  fabric: string | null;
  formality: number | null;
  fit: string | null;
  brand: string | null;
  price_inr: number | null;
  notes: string | null;
  image_path: string;
  clean_path: string | null;
  thumb_path: string | null;
  cutout_path: string | null;
  is_sample: boolean;
  size_label: string | null;
  phash: string | null;
  duplicate_of: string | null;
  ai_tags: Record<string, unknown> | null;
  ai_confidence: number | null;
  user_verified: boolean;
  created_at: string;
};

export type ItemDto = Omit<ItemRow, "image_path" | "clean_path" | "thumb_path" | "cutout_path" | "phash" | "ai_tags"> & {
  imageUrl: string | null;
  thumbUrl: string | null;
  cutoutUrl: string | null;
};

const ITEM_COLUMNS =
  "id,status,status_reason,lifecycle,category,subcategory,colors,pattern,seasons,fabric,formality,fit,brand,price_inr,notes,image_path,clean_path,thumb_path,cutout_path,is_sample,size_label,phash,duplicate_of,ai_tags,ai_confidence,user_verified,created_at";

/** Adds signed URLs (reused for up to a day) so the private bucket never becomes public. */
export async function withImageUrls(supabase: SupabaseClient, rows: ItemRow[]): Promise<ItemDto[]> {
  const paths = new Set<string>();
  for (const r of rows) {
    paths.add(r.thumb_path ?? r.image_path);
    paths.add(r.clean_path ?? r.image_path);
    if (r.cutout_path) paths.add(r.cutout_path);
  }
  const urls = await signedUrls(supabase, BUCKET, paths);
  return rows.map((row) => {
    // Storage paths, hashes and raw AI output stay server-side.
    const { image_path, clean_path, thumb_path, cutout_path, ...rest } = row;
    const dto: Record<string, unknown> = { ...rest };
    delete dto.phash;
    delete dto.ai_tags;
    return {
      ...(dto as Omit<ItemRow, "image_path" | "clean_path" | "thumb_path" | "cutout_path" | "phash" | "ai_tags">),
      imageUrl: urls.get(clean_path ?? image_path) ?? null,
      thumbUrl: urls.get(thumb_path ?? image_path) ?? null,
      cutoutUrl: cutout_path ? urls.get(cutout_path) ?? null : null,
    };
  });
}

export async function listItems(supabase: SupabaseClient, query: ItemListQuery) {
  let q = supabase
    .from("wardrobe_items")
    .select(ITEM_COLUMNS)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(query.limit + 1);

  if (query.category) q = q.eq("category", query.category);
  if (query.color) q = q.contains("colors", [query.color]);
  if (query.season) q = q.overlaps("seasons", [query.season, "all"]);
  if (query.lifecycle) q = q.eq("lifecycle", query.lifecycle);
  if (query.q) {
    const term = query.q.replace(/[%,()]/g, " ");
    q = q.or(`subcategory.ilike.%${term}%,brand.ilike.%${term}%,notes.ilike.%${term}%,fabric.ilike.%${term}%`);
  }
  if (query.cursor) q = q.lt("created_at", Buffer.from(query.cursor, "base64url").toString());

  const rows = must(await q, "List items") as unknown as ItemRow[];
  const page = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit ? Buffer.from(page[page.length - 1].created_at).toString("base64url") : null;
  return { items: await withImageUrls(supabase, page), nextCursor };
}

export async function getItemRow(supabase: SupabaseClient, id: string): Promise<ItemRow> {
  const { data, error } = await supabase
    .from("wardrobe_items")
    .select(ITEM_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw errors.notFound("Item");
  return data as unknown as ItemRow;
}

export async function getItem(supabase: SupabaseClient, id: string): Promise<ItemDto> {
  const [dto] = await withImageUrls(supabase, [await getItemRow(supabase, id)]);
  return dto;
}

export async function createItem(supabase: SupabaseClient, userId: string, imagePath: string) {
  // The path must be inside the user's own folder, under raw/ (storage policies enforce this too).
  if (!imagePath.startsWith(`${userId}/raw/`)) throw errors.badRequest("imagePath is not an upload of yours");
  const row = must(
    await supabase
      .from("wardrobe_items")
      .insert({ user_id: userId, image_path: imagePath })
      .select("id,status")
      .single(),
    "Create item",
  );
  return row as { id: string; status: string };
}

const AI_FIELDS = ["category", "subcategory", "colors", "pattern", "seasons", "fabric", "formality", "fit", "brand"] as const;

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? [...v].sort().join(",") : String(v);
}

export async function updateItem(supabase: SupabaseClient, userId: string, id: string, patch: ItemPatch) {
  const current = await getItemRow(supabase, id);
  const corrections = AI_FIELDS.filter((f) => f in patch)
    .map((field) => ({
      field,
      ai_value: asText(current.ai_tags?.[field]),
      user_value: asText(patch[field]),
    }))
    .filter((c) => c.ai_value !== null && c.ai_value !== c.user_value)
    .map((c) => ({ ...c, user_id: userId, item_id: id }));

  const touchesTags = AI_FIELDS.some((f) => f in patch);
  must(
    await supabase
      .from("wardrobe_items")
      .update({ ...patch, ...(touchesTags ? { user_verified: true } : {}) })
      .eq("id", id),
    "Update item",
  );
  if (corrections.length) must(await supabase.from("item_corrections").insert(corrections), "Save corrections");
  return getItem(supabase, id);
}

export async function deleteItem(supabase: SupabaseClient, id: string) {
  const row = await getItemRow(supabase, id);
  const paths = [...new Set([row.image_path, row.clean_path, row.thumb_path, row.cutout_path])].filter((p): p is string => Boolean(p));
  must(await supabase.from("wardrobe_items").delete().eq("id", id), "Delete item");
  // Storage is the scarcest free resource, so files go immediately.
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
}

export async function retryItem(supabase: SupabaseClient, id: string) {
  const row = await getItemRow(supabase, id);
  // Failed items keep their original photo, so they can be processed again.
  if (row.status !== "failed") throw errors.conflict("Only failed items can be retried");
  must(
    // A fresh vision job id: the service treats a resent id as the same (finished) job.
    await supabase.from("wardrobe_items").update({ status: "processing", status_reason: null, vision_job_id: null }).eq("id", id),
    "Retry item",
  );
}

/** Near-identical photos by perceptual hash (Hamming distance of 64-bit dHash). */
export async function similarItems(supabase: SupabaseClient, id: string, maxDistance = 10) {
  const target = await getItemRow(supabase, id);
  if (!target.phash) return [];
  const rows = must(
    await supabase
      .from("wardrobe_items")
      .select(ITEM_COLUMNS)
      .is("deleted_at", null)
      .neq("id", id)
      .not("phash", "is", null),
    "Similar items",
  ) as unknown as ItemRow[];
  const close = rows
    .map((r) => ({ r, d: hammingHex(target.phash!, r.phash!) }))
    .filter((x) => x.d <= maxDistance)
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
  const dtos = await withImageUrls(supabase, close.map((x) => x.r));
  return dtos.map((dto, i) => ({ ...dto, distance: close[i].d }));
}
