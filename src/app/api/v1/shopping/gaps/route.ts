import { authed, must } from "@/modules/platform/http";
import { findGaps, type GapItem } from "@/modules/shopping/gaps";

export const GET = authed(async (ctx) => {
  const items = must(
    await ctx.supabase
      .from("wardrobe_items")
      .select("category,subcategory,colors,formality")
      .eq("status", "ready")
      .neq("lifecycle", "archived")
      .is("deleted_at", null),
    "Load items",
  ) as GapItem[];
  return Response.json({ gaps: findGaps(items), itemCount: items.length });
});
