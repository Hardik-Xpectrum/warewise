import { authed } from "@/modules/platform/http";
import { deleteTryOn } from "@/modules/tryon/service";

export const DELETE = authed<{ id: string }>(async (ctx, { id }) => {
  await deleteTryOn(ctx, id);
  return new Response(null, { status: 204 });
});
