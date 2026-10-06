import "server-only";
// Plan the week (an outfit per day, which Today then uses) and pack for a trip (a small capsule
// with an outfit per day). Rules only: instant and free.
import { z } from "zod";
import { errors } from "@/modules/platform/errors";
import { must, type AuthedContext } from "@/modules/platform/http";
import type { Category } from "@/modules/wardrobe/taxonomy";
import { planDays } from "./pack";
import { climateOf, closestOutfits, OCCASIONS, type Occasion, type OutfitPick } from "./rules";
import { describeOutfits, loadWardrobe, persistOutfits, todayIST, type LookOutfit } from "./service";
import { getForecast } from "./weather";

const OccasionEnum = z.enum(Object.keys(OCCASIONS) as [Occasion, ...Occasion[]]);
export const PlanSchema = z.object({ outfitId: z.uuid() });
export const PackSchema = z.object({
  city: z.string().trim().max(80).optional(),
  occasions: z.array(OccasionEnum).min(1).max(14), // one per day of the trip
});

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOccasion = (iso: string): Occasion => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? "casual" : "office";
};

/** The next 7 days with their planned outfits (if any). */
export async function getWeek(ctx: AuthedContext) {
  const start = todayIST();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const plans = must(
    await ctx.supabase.from("planned_outfits").select("day,outfit_id").gte("day", days[0]).lte("day", days[6]),
    "Load plan",
  ) as { day: string; outfit_id: string }[];
  const ids = plans.map((p) => p.outfit_id);
  const itemRows = ids.length
    ? (must(await ctx.supabase.from("outfit_items").select("outfit_id,item_id,slot").in("outfit_id", ids), "Load planned items") as { outfit_id: string; item_id: string; slot: Category }[])
    : [];
  const state = await loadWardrobe(ctx, "other", null);
  const looks = await describeOutfits(
    ctx,
    state,
    plans.map((p) => ({ outfitId: p.outfit_id, pick: { why: "", items: itemRows.filter((r) => r.outfit_id === p.outfit_id).map((r) => ({ id: r.item_id, slot: r.slot })) } })),
  );
  const byDay = new Map(plans.map((p, i) => [p.day, looks[i]]));
  return { days: days.map((day) => ({ day, suggested: weekdayOccasion(day), outfit: byDay.get(day) ?? null })) };
}

export async function setPlan(ctx: AuthedContext, day: string, outfitId: string) {
  if (day < todayIST()) throw errors.badRequest("You can only plan today or later");
  const { data } = await ctx.supabase.from("outfits").select("id").eq("id", outfitId).maybeSingle();
  if (!data) throw errors.notFound("Outfit");
  must(await ctx.supabase.from("planned_outfits").upsert({ user_id: ctx.userId, day, outfit_id: outfitId }), "Save plan");
}

export async function clearPlan(ctx: AuthedContext, day: string) {
  must(await ctx.supabase.from("planned_outfits").delete().eq("day", day), "Clear plan");
}

/** Fills the unplanned days of the next week: office on weekdays, casual at weekends, no repeats. */
export async function autoPlanWeek(ctx: AuthedContext) {
  const week = await getWeek(ctx);
  const open = week.days.filter((d) => !d.outfit);
  if (!open.length) return getWeek(ctx);
  const profile = must(await ctx.supabase.from("profiles").select("home_city").eq("id", ctx.userId).single(), "Load profile") as { home_city: string | null };
  const weather = profile.home_city ? await getForecast(profile.home_city, open[0].day) : null;
  const state = await loadWardrobe(ctx, "other", weather);
  const plan = planDays(state.all, open.map((d) => d.suggested), climateOf(weather));
  for (const [i, d] of plan.days.entries()) {
    // Nothing fits the occasion (e.g. no office clothes yet): plan the closest match, like Today does.
    const pick = d.outfit ?? closestOutfits(state.all, d.occasion, climateOf(weather))[0];
    if (!pick) continue;
    const label = new Date(`${open[i].day}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" });
    const [look] = await persistOutfits(ctx, state, [{ ...pick, why: `Planned for ${label}.` }], d.occasion, `${label}'s outfit`);
    must(await ctx.supabase.from("planned_outfits").upsert({ user_id: ctx.userId, day: open[i].day, outfit_id: look.outfitId }), "Save plan");
  }
  return getWeek(ctx);
}

/** A trip capsule: the fewest pieces that give an outfit for every day, and what to wear when. */
export async function packTrip(ctx: AuthedContext, input: z.infer<typeof PackSchema>) {
  const weather = input.city ? await getForecast(input.city, todayIST()) : null;
  const state = await loadWardrobe(ctx, "other", weather);
  const plan = planDays(state.all, input.occasions, climateOf(weather));
  const picks = plan.days.map((d) => d.outfit).filter((o): o is OutfitPick => Boolean(o));
  // Describe without saving: packing lists are throwaway until the user saves a look.
  const described = await describeOutfits(ctx, state, picks.map((pick, i) => ({ outfitId: `trip-${i}`, pick })));
  const byItem = new Map(described.flatMap((o) => o.items).map((i) => [i.id, i]));
  let k = 0;
  return {
    weather,
    items: plan.items.map((id) => byItem.get(id)!).filter(Boolean),
    days: plan.days.map((d) => ({ day: d.day + 1, occasion: d.occasion, outfit: d.outfit ? (described[k++] as LookOutfit) : null })),
    missing: plan.days.filter((d) => !d.outfit).length,
  };
}
