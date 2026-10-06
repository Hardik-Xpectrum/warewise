import { authed, readJson } from "@/modules/platform/http";
import { deleteOutfit, patchOutfit, PatchOutfitSchema } from "@/modules/outfits/service";

type P = { id: string };

export const PATCH = authed<P>(async (ctx, { id }) => {
  await patchOutfit(ctx, id, await readJson(ctx.req, (b) => PatchOutfitSchema.parse(b)));
  return new Response(null, { status: 204 });
});

export const DELETE = authed<P>(async (ctx, { id }) => {
  await deleteOutfit(ctx, id);
  return new Response(null, { status: 204 });
});
