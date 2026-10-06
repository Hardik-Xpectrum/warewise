import { authed, readJson } from "@/modules/platform/http";
import { FeedbackSchema } from "@/modules/stylist/schemas";
import { recordFeedback } from "@/modules/stylist/service";

export const POST = authed<{ id: string }>(async (ctx, { id }) => {
  const { kind, reason } = await readJson(ctx.req, (b) => FeedbackSchema.parse(b));
  return Response.json(await recordFeedback(ctx, id, kind, reason));
});
