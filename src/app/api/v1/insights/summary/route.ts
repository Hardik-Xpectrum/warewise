import { authed } from "@/modules/platform/http";
import { insightsSummary } from "@/modules/insights/service";

export const GET = authed(async (ctx) => Response.json(await insightsSummary(ctx)));
