import "server-only";
import { must, type AuthedContext } from "@/modules/platform/http";
import { withImageUrls, type ItemRow } from "@/modules/wardrobe/service";

const WINDOW_DAYS = 90;
const NEW_ITEM_GRACE_DAYS = 14;

/** Wardrobe analytics from the wear log: how much of the wardrobe actually gets worn. */
export async function insightsSummary(ctx: AuthedContext) {
  const items = must(
    await ctx.supabase.from("wardrobe_items").select("*").eq("status", "ready").is("deleted_at", null).neq("lifecycle", "archived"),
    "Load items",
  ) as unknown as ItemRow[];
  const wears = must(
    await ctx.supabase.from("wear_log_items").select("item_id, wear_log:wear_log_id(worn_on)"),
    "Load wear log",
  ) as unknown as { item_id: string; wear_log: { worn_on: string } | null }[];

  const since = Date.now() - WINDOW_DAYS * 86400_000;
  const total = new Map<string, number>();
  const recent = new Set<string>();
  for (const w of wears) {
    total.set(w.item_id, (total.get(w.item_id) ?? 0) + 1);
    if (w.wear_log && new Date(w.wear_log.worn_on).getTime() >= since) recent.add(w.item_id);
  }

  const dtos = new Map((await withImageUrls(ctx.supabase, items)).map((d) => [d.id, d]));
  const card = (r: ItemRow) => {
    const d = dtos.get(r.id)!;
    const wearsCount = total.get(r.id) ?? 0;
    return {
      id: r.id,
      label: [r.colors[0], r.subcategory ?? r.category].filter(Boolean).join(" "),
      thumbUrl: d.thumbUrl,
      wears: wearsCount,
      costPerWear: r.price_inr && wearsCount ? Math.round(Number(r.price_inr) / wearsCount) : null,
    };
  };

  const byCategory: Record<string, number> = {};
  for (const r of items) byCategory[r.category ?? "untagged"] = (byCategory[r.category ?? "untagged"] ?? 0) + 1;

  const graceCutoff = Date.now() - NEW_ITEM_GRACE_DAYS * 86400_000;
  const wornRecently = items.filter((r) => recent.has(r.id)).length;

  return {
    totalItems: items.length,
    wornLast90Days: wornRecently,
    utilizationPct: items.length ? Math.round((wornRecently / items.length) * 100) : 0,
    totalWears: wears.length,
    byCategory,
    mostWorn: items.filter((r) => total.has(r.id)).sort((a, b) => (total.get(b.id) ?? 0) - (total.get(a.id) ?? 0)).slice(0, 5).map(card),
    neverWorn: items.filter((r) => !total.has(r.id) && new Date(r.created_at).getTime() < graceCutoff).slice(0, 10).map(card),
    bestValue: items
      .filter((r) => r.price_inr && total.has(r.id))
      .map(card)
      .sort((a, b) => (a.costPerWear ?? Infinity) - (b.costPerWear ?? Infinity))
      .slice(0, 5),
  };
}
