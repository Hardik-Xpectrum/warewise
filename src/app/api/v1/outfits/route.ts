import { authed, readJson } from "@/modules/platform/http";
import { createManualOutfit, CreateOutfitSchema, listSavedOutfits } from "@/modules/outfits/service";

export const GET = authed(async (ctx) => {
  const favoritesOnly = new URL(ctx.req.url).searchParams.get("favorite") === "true";
  return Response.json({ outfits: await listSavedOutfits(ctx, favoritesOnly) });
});

export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => CreateOutfitSchema.parse(b));
  return Response.json(await createManualOutfit(ctx, input), { status: 201 });
});
