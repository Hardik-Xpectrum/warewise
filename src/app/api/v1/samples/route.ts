import { authed } from "@/modules/platform/http";
import { loadSamples, removeSamples } from "@/modules/samples/service";

export const POST = authed(async (ctx) => Response.json(await loadSamples(ctx), { status: 201 }));
export const DELETE = authed(async (ctx) => Response.json(await removeSamples(ctx)));
