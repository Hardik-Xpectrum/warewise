import { authed, readJson } from "@/modules/platform/http";
import { logWear, WearLogSchema } from "@/modules/outfits/service";

export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => WearLogSchema.parse(b));
  return Response.json(await logWear(ctx, input), { status: 201 });
});
