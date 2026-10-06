"use client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly requestId?: string,
  ) {
    super(detail || title);
  }
}

/** fetch wrapper for /api/v1: JSON in, JSON out, problem responses become ApiError. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api/v1${path}`, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401 && typeof window !== "undefined") {
    // Full reload to the login page; the session cookie has expired.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.title ?? "Request failed", body.detail, body.requestId);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.detail ? `${err.title}: ${err.detail}` : err.title;
  return err instanceof Error ? err.message : "Something went wrong";
}
