import { authed, readJson } from "@/modules/platform/http";
import { PackSchema, packTrip } from "@/modules/stylist/planner";

/** A trip capsule: the fewest pieces for an outfit every day. */
export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => PackSchema.parse(b));
  return Response.json(await packTrip(ctx, input));
});
