import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { runAllJobs } from "@/modules/jobs/runner";
import { newRequestId, problem } from "@/modules/platform/http";
import { errors } from "@/modules/platform/errors";

// AI try-on on a free GPU queue can take minutes. Vercel caps this at the plan's maximum.
export const maxDuration = 300;

function secretMatches(given: string | null): boolean {
  const expected = Buffer.from(serverEnv.jobSecret());
  const actual = Buffer.from(given ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Called by pg_cron (through pg_net) every minute. Not for browsers: requires the job secret. */
export async function POST(req: Request) {
  const requestId = newRequestId();
  try {
    if (!secretMatches(req.headers.get("x-job-secret"))) throw errors.unauthorized();
    const summary = await runAllJobs(requestId);
    return Response.json({ requestId, ...summary });
  } catch (err) {
    return problem(err, requestId);
  }
}
