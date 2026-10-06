import { after } from "next/server";
import { authed, readJson } from "@/modules/platform/http";
import { createAiTryOn, CreateTryOnSchema, listTryOns, runTryOnJobs } from "@/modules/tryon/service";

export const maxDuration = 300;

export const GET = authed(async (ctx) => Response.json({ results: await listTryOns(ctx) }));

/** Queues a realistic AI try-on; the instant preview is drawn in the browser and needs no call. */
export const POST = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => CreateTryOnSchema.parse(b));
  const created = await createAiTryOn(ctx, input);
  after(() => runTryOnJobs(ctx.requestId).catch(() => undefined));
  return Response.json(created, { status: 202 });
});
