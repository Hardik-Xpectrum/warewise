import { after } from "next/server";
import { runMediaJobs } from "@/modules/jobs/runner";
import { errors } from "@/modules/platform/errors";
import { authed, readJson } from "@/modules/platform/http";
import { idempotent } from "@/modules/platform/idempotency";
import { errorFields, log } from "@/modules/platform/log";
import { CreateItemSchema, ItemListQuerySchema } from "@/modules/wardrobe/schemas";
import { createItem, listItems } from "@/modules/wardrobe/service";

export const maxDuration = 60;
const DAILY_UPLOAD_CAP = 60;

export const GET = authed(async (ctx) => {
  const query = ItemListQuerySchema.parse(Object.fromEntries(new URL(ctx.req.url).searchParams));
  return Response.json(await listItems(ctx.supabase, query));
});

export const POST = authed(async (ctx) => {
  const { imagePath } = await readJson(ctx.req, (b) => CreateItemSchema.parse(b));
  const { body, replayed } = await idempotent(ctx, async () => {
    const { data: count, error } = await ctx.supabase.rpc("take_usage", { p_kind: "tag_calls", p_cap: DAILY_UPLOAD_CAP });
    if (error) throw new Error(error.message);
    if (count === -1) throw errors.quota(`You can add ${DAILY_UPLOAD_CAP} items a day. Try again tomorrow.`);
    return createItem(ctx.supabase, ctx.userId, imagePath);
  });
  if (!replayed) {
    // Start tagging right away instead of waiting for the next pg_cron minute.
    after(async () => {
      try {
        await runMediaJobs(ctx.requestId);
      } catch (err) {
        log("warn", "immediate job run failed; pg_cron will retry", { requestId: ctx.requestId, ...errorFields(err) });
      }
    });
  }
  return Response.json(body, { status: 202 });
});
