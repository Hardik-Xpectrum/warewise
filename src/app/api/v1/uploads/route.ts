import { authed, readJson } from "@/modules/platform/http";
import { createUploadUrl, UploadRequestSchema } from "@/modules/media/service";

export const POST = authed(async (ctx) => {
  const { contentType, purpose } = await readJson(ctx.req, (b) => UploadRequestSchema.parse(b ?? {}));
  return Response.json(await createUploadUrl(ctx, contentType, purpose), { status: 201 });
});
