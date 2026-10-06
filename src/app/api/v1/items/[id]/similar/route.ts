import { authed } from "@/modules/platform/http";
import { similarItems } from "@/modules/wardrobe/service";

export const GET = authed<{ id: string }>(async (ctx, { id }) => Response.json({ items: await similarItems(ctx.supabase, id) }));
