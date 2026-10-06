import { authed } from "@/modules/platform/http";
import { deleteAvatarModel } from "@/modules/tryon/models3d";

export const DELETE = authed<{ id: string }>(async (ctx, { id }) => {
  await deleteAvatarModel(ctx, id);
  return new Response(null, { status: 204 });
});
