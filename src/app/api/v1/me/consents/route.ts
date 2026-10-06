import { authed, readJson } from "@/modules/platform/http";
import { ConsentsSchema, setConsents } from "@/modules/identity/service";

export const PUT = authed(async (ctx) => {
  const input = await readJson(ctx.req, (b) => ConsentsSchema.parse(b));
  return Response.json(await setConsents(ctx, input));
});
