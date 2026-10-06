import { z } from "zod";
import { authed, readJson } from "@/modules/platform/http";
import { OCCASIONS, type Occasion } from "@/modules/stylist/rules";
import { todayLook } from "@/modules/stylist/service";

const OccasionParam = z.enum(Object.keys(OCCASIONS) as [Occasion, ...Occasion[]]).optional();

/** Today's outfit (created on first visit of the day, then kept). */
export const GET = authed(async (ctx) => {
  const occasion = OccasionParam.parse(new URL(ctx.req.url).searchParams.get("occasion") ?? undefined);
  return Response.json(await todayLook(ctx, { occasion }));
});

/** Shuffle: a different outfit for today, optionally for another occasion. */
export const POST = authed(async (ctx) => {
  const { occasion } = await readJson(ctx.req, (b) => z.object({ occasion: OccasionParam }).parse(b ?? {}));
  return Response.json(await todayLook(ctx, { occasion, shuffle: true }));
});
