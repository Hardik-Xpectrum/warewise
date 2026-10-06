import { exportAccount } from "@/modules/identity/service";
import { authed } from "@/modules/platform/http";

/** Downloads all of the user's data as one JSON file. */
export const GET = authed(async (ctx) => {
  const body = await exportAccount(ctx);
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="warewise-data-${body.exported_at.slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
});
