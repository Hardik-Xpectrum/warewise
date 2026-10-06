import { authed, readJson } from "@/modules/platform/http";
import { ItemPatchSchema } from "@/modules/wardrobe/schemas";
import { deleteItem, getItem, updateItem } from "@/modules/wardrobe/service";

type P = { id: string };

export const GET = authed<P>(async (ctx, { id }) => Response.json(await getItem(ctx.supabase, id)));

export const PATCH = authed<P>(async (ctx, { id }) => {
  const patch = await readJson(ctx.req, (b) => ItemPatchSchema.parse(b));
  return Response.json(await updateItem(ctx.supabase, ctx.userId, id, patch));
});

export const DELETE = authed<P>(async (ctx, { id }) => {
  await deleteItem(ctx.supabase, id);
  return new Response(null, { status: 204 });
});
