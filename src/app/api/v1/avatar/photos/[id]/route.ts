import { z } from "zod";
import { authed, readJson } from "@/modules/platform/http";
import { deleteAvatarPhoto, setPrimary } from "@/modules/avatar/service";

type P = { id: string };

export const PATCH = authed<P>(async (ctx, { id }) => {
  await readJson(ctx.req, (b) => z.object({ is_primary: z.literal(true) }).strict().parse(b));
  await setPrimary(ctx, id);
  return new Response(null, { status: 204 });
});

export const DELETE = authed<P>(async (ctx, { id }) => {
  await deleteAvatarPhoto(ctx, id);
  return new Response(null, { status: 204 });
});
