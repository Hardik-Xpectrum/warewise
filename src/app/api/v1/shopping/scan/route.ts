import { authed, readJson } from "@/modules/platform/http";
import { ShopScanSchema } from "@/modules/stylist/schemas";
import { scanPurchase } from "@/modules/stylist/service";

export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => ShopScanSchema.parse(b));
  return Response.json(await scanPurchase(ctx, input));
});
