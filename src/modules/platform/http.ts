import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { createUserClient } from "@/lib/supabase/server";
import { errors, problemBody } from "./errors";
import { errorFields, log } from "./log";

export type AuthedContext = {
  req: Request;
  userId: string;
  role: string | undefined;
  supabase: SupabaseClient;
  requestId: string;
};

/** A client that acts as the bearer token's user, so row-level security still applies. */
function bearerClient(token: string): SupabaseClient {
  return createClient(publicEnv.supabaseUrl(), publicEnv.supabaseKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const WRITES_PER_MINUTE = 60;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cookie-authenticated writes must come from this site (belt and braces on top of SameSite). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches from some browsers and non-browser clients omit it
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function newRequestId() {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function problem(err: unknown, requestId: string): Response {
  const { status, body } = problemBody(err, requestId);
  if (status >= 500) log("error", "request failed", { requestId, ...errorFields(err) });
  return Response.json(body, {
    status,
    headers: { "content-type": "application/problem+json", "x-request-id": requestId },
  });
}

/**
 * Wraps a route handler: resolves the signed-in user from the verified JWT (never from the body),
 * attaches a request id, and turns thrown errors into problem responses.
 */
export function authed<P = unknown>(
  handler: (ctx: AuthedContext, params: P) => Promise<Response>,
) {
  return async (req: Request, routeCtx: { params: Promise<P> }) => {
    const requestId = req.headers.get("x-request-id") || newRequestId();
    try {
      // Browsers send the session cookie; scripts and future mobile apps send "Authorization: Bearer <jwt>".
      const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const writing = UNSAFE.has(req.method);
      if (writing && !bearer && !sameOrigin(req)) throw errors.forbidden("Cross-site request blocked");
      const supabase = bearer ? bearerClient(bearer) : await createUserClient();
      const { data } = bearer ? await supabase.auth.getClaims(bearer) : await supabase.auth.getClaims();
      const userId = data?.claims?.sub;
      if (!userId) throw errors.unauthorized();
      const role = (data.claims.app_metadata as { role?: string } | undefined)?.role;
      if (writing) {
        const { data: allowed, error } = await supabase.rpc("take_rate", { p_limit: WRITES_PER_MINUTE });
        if (!error && allowed === false) throw errors.tooFast();
        // A failed counter never blocks the request: availability over strictness here.
      }
      const params = routeCtx?.params ? await routeCtx.params : ({} as P);
      const res = await handler({ req, userId, role, supabase, requestId }, params);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      return problem(err, requestId);
    }
  };
}

export async function readJson<T>(req: Request, parse: (v: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw errors.badRequest("Body must be JSON");
  }
  return parse(body);
}

/** Throws a user-safe error for a failed Supabase query. */
export function must<T>(result: { data: T; error: { message: string; code?: string } | null }, what = "Query"): T {
  if (result.error) {
    if (result.error.code === "PGRST116") throw errors.notFound();
    throw new Error(`${what} failed: ${result.error.message}`);
  }
  return result.data;
}
