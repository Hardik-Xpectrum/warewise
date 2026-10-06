import { after } from "next/server";
import { runMediaJobs } from "@/modules/jobs/runner";
import { authed } from "@/modules/platform/http";
import { retryItem } from "@/modules/wardrobe/service";

export const maxDuration = 60;

export const POST = authed<{ id: string }>(async (ctx, { id }) => {
  await retryItem(ctx.supabase, id);
  after(() => runMediaJobs(ctx.requestId).catch(() => undefined));
  return Response.json({ id, status: "processing" }, { status: 202 });
});
