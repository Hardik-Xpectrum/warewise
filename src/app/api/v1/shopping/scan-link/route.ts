import { z } from "zod";
import { authed, readJson } from "@/modules/platform/http";
import { scanProductLink } from "@/modules/stylist/service";

export const maxDuration = 60;

/** Shop Scan from a product link (allow-listed shops only). */
export const POST = authed(async (ctx) => {
  const { url } = await readJson(ctx.req, (b) => z.object({ url: z.string().trim().max(2000) }).parse(b));
  return Response.json(await scanProductLink(ctx, url));
});
