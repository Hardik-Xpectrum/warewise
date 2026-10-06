import { authed, readJson } from "@/modules/platform/http";
import { CompleteLookSchema } from "@/modules/stylist/schemas";
import { completeLook } from "@/modules/stylist/service";

export const POST = authed<{ id: string }>(async (ctx, { id }) => {
  const input = await readJson(ctx.req, (b) => CompleteLookSchema.parse(b ?? {}));
  return Response.json(await completeLook(ctx, id, input.occasion, input.city));
});
