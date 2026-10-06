import { z } from "zod";
import { authed, readJson } from "@/modules/platform/http";
import { clearPlan, PlanSchema, setPlan } from "@/modules/stylist/planner";

type P = { day: string };
const Day = z.iso.date();

export const PUT = authed<P>(async (ctx, { day }) => {
  const { outfitId } = await readJson(ctx.req, (b) => PlanSchema.parse(b));
  await setPlan(ctx, Day.parse(day), outfitId);
  return new Response(null, { status: 204 });
});

export const DELETE = authed<P>(async (ctx, { day }) => {
  await clearPlan(ctx, Day.parse(day));
  return new Response(null, { status: 204 });
});
