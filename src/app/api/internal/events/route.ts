import { ServiceEvent, verifyServiceToken } from "@warewise/contracts";
import { serverEnv } from "@/lib/env";
import { errorFields, log } from "@/modules/platform/log";
import { applyServiceEvent } from "@/modules/services/apply";

/**
 * Events from the vision, avatar and try-on services (job finished or failed). Not for browsers:
 * needs a service token addressed to "web". A 2xx means "stored, don't send again"; anything else
 * makes the service retry later.
 */
export async function POST(req: Request) {
  const requestId = `evt_${crypto.randomUUID().slice(0, 12)}`;
  const check = verifyServiceToken(req.headers.get("authorization"), "web", serverEnv.serviceSecret());
  if (!check.ok) return problem(401, "unauthorized", "Service token required", check.reason);
  if (check.iss === "web") return problem(403, "forbidden", "Only services send events");

  const parsed = ServiceEvent.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return problem(400, "bad-request", "Invalid event", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const ev = parsed.data;
  // A service may only report on its own kind of job.
  const from = ev.type.startsWith("item.") ? "vision" : ev.type.startsWith("avatar.") ? "avatar" : "tryon";
  if (check.iss !== from) return problem(403, "forbidden", `${check.iss} can't send ${ev.type}`);

  try {
    const outcome = await applyServiceEvent(ev, requestId);
    log("info", "service event", { requestId, type: ev.type, jobId: ev.jobId, outcome });
    return Response.json({ ok: true, outcome });
  } catch (err) {
    log("error", "service event failed", { requestId, type: ev.type, jobId: ev.jobId, ...errorFields(err) });
    return problem(503, "unavailable", "Couldn't apply the event right now; send it again later");
  }
}

function problem(status: number, slug: string, title: string, detail?: string) {
  return Response.json({ type: `/errors/${slug}`, title, status, ...(detail ? { detail } : {}) }, { status, headers: { "content-type": "application/problem+json" } });
}
