import { authed, readJson } from "@/modules/platform/http";
import { AddAvatarPhotoSchema, addAvatarPhoto } from "@/modules/avatar/service";

export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => AddAvatarPhotoSchema.parse(b));
  return Response.json(await addAvatarPhoto(ctx, input), { status: 201 });
});
