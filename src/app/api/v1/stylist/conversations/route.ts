import { authed } from "@/modules/platform/http";
import { createConversation } from "@/modules/stylist/service";

export const POST = authed(async (ctx) => Response.json(await createConversation(ctx), { status: 201 }));
