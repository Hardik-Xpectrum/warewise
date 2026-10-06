import { authed } from "@/modules/platform/http";
import { getWeek } from "@/modules/stylist/planner";

/** The next 7 days and their planned outfits. */
export const GET = authed(async (ctx) => Response.json(await getWeek(ctx)));
