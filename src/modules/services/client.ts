import "server-only";
import { signServiceToken, type Problem } from "@warewise/contracts";
import { serverEnv } from "@/lib/env";

export type ServiceName = "vision" | "avatar" | "tryon";

/** True when this service has a URL set: the web app hands the work to it instead of doing it in-process. */
export function serviceEnabled(name: ServiceName): boolean {
  return serverEnv.serviceUrl(name) !== null;
}

export class ServiceError extends Error {
  constructor(
    readonly service: ServiceName,
    readonly status: number,
    readonly problem: Problem | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Calls a service with a short-lived token signed for it (`Authorization: Service …`). Errors come
 * back as ServiceError with the service's problem details. Free hosts sleep when idle, so the first
 * call after a quiet spell can take a while: the timeout is generous.
 */
export async function callService<T>(name: ServiceName, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 60_000): Promise<T | null> {
  const base = serverEnv.serviceUrl(name);
  if (!base) throw new Error(`${name} service is not configured`);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Service ${signServiceToken("web", name, serverEnv.serviceSecret())}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const problem = json && typeof json === "object" && "title" in json ? (json as Problem) : null;
    throw new ServiceError(name, res.status, problem, `${name} ${method} ${path}: ${res.status} ${problem?.title ?? ""} ${problem?.detail ?? ""}`.trim());
  }
  return json as T;
}
