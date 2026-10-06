import { authed } from "@/modules/platform/http";
import { autoPlanWeek } from "@/modules/stylist/planner";

/** Fills the week's open days with outfits (office on weekdays, casual at weekends, no repeats). */
export const POST = authed(async (ctx) => Response.json(await autoPlanWeek(ctx)));
