import { after } from "next/server";
import { authed, readJson } from "@/modules/platform/http";
import { createAvatarModel, CreateModelSchema, listAvatarModels, runModel3dJobs } from "@/modules/tryon/models3d";

export const maxDuration = 300;

/** The user's AI 3D avatar models, newest first, plus whether a provider is configured. */
export const GET = authed(async (ctx) => Response.json(await listAvatarModels(ctx)));

/** Queues a 3D model from an avatar photo or a finished realistic try-on (1–3 minutes). */
export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => CreateModelSchema.parse(b));
  const created = await createAvatarModel(ctx, input);
  after(() => runModel3dJobs(ctx.requestId).catch(() => undefined));
  return Response.json(created, { status: 202 });
});
