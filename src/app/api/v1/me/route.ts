import { authed, readJson } from "@/modules/platform/http";
import { deleteAccount, getProfile, ProfilePatchSchema, updateProfile } from "@/modules/identity/service";

export const GET = authed(async (ctx) => Response.json(await getProfile(ctx)));

export const PATCH = authed(async (ctx) => {
  const patch = await readJson(ctx.req, (b) => ProfilePatchSchema.parse(b));
  return Response.json(await updateProfile(ctx, patch));
});

export const DELETE = authed(async (ctx) => {
  await deleteAccount(ctx);
  return new Response(null, { status: 204 });
});
