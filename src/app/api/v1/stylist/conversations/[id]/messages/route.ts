import { problemBody } from "@/modules/platform/errors";
import { authed, readJson } from "@/modules/platform/http";
import { errorFields, log } from "@/modules/platform/log";
import { StylistMessageSchema } from "@/modules/stylist/schemas";
import { handleStylistMessage, type StylistEvent } from "@/modules/stylist/service";

export const maxDuration = 60;

function sse(e: StylistEvent) {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** Streams the stylist's progress and outfits as Server-Sent Events. */
export const POST = authed<{ id: string }>(async (ctx, { id }) => {
  const input = await readJson(ctx.req, (b) => StylistMessageSchema.parse(b));
  const events = handleStylistMessage(ctx, id, input);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const e of events) controller.enqueue(encoder.encode(sse(e)));
      } catch (err) {
        const { body } = problemBody(err, ctx.requestId);
        if (body.status >= 500) log("error", "stylist failed", { requestId: ctx.requestId, ...errorFields(err) });
        controller.enqueue(encoder.encode(sse({ event: "error", data: { title: body.title, detail: body.detail ?? "" } })));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
});
