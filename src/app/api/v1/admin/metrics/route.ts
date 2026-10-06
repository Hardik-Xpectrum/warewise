import { adminMetrics } from "@/modules/platform/metrics";
import { errors } from "@/modules/platform/errors";
import { authed } from "@/modules/platform/http";

export const GET = authed(async (ctx) => {
  if (ctx.role !== "admin") throw errors.notFound();
  return Response.json(await adminMetrics());
});
