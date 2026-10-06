import { authed } from "@/modules/platform/http";
import { listAvatarPhotos } from "@/modules/avatar/service";

export const GET = authed(async (ctx) => Response.json(await listAvatarPhotos(ctx)));
