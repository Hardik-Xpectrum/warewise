import { ZodError } from "zod";

/** An error the user is allowed to see, rendered as an RFC 9457 problem response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
  }
}

export const errors = {
  badRequest: (detail: string, extra?: Record<string, unknown>) =>
    new AppError(400, "bad-request", "Invalid request", detail, extra),
  unauthorized: () => new AppError(401, "unauthorized", "Sign in required"),
  // 404 rather than 403 for other users' resources, so ids cannot be probed.
  notFound: (what = "Resource") => new AppError(404, "not-found", `${what} not found`),
  quota: (detail: string) => new AppError(429, "quota-exceeded", "Daily limit reached", detail),
  tooFast: () => new AppError(429, "rate-limited", "Too many requests", "Slow down a little and try again in a minute."),
  forbidden: (detail: string) => new AppError(403, "forbidden", "Not allowed", detail),
  conflict: (detail: string) => new AppError(409, "conflict", "Conflict", detail),
};

export function problemBody(err: unknown, requestId: string) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        type: `/errors/${err.type}`,
        title: err.title,
        status: err.status,
        detail: err.detail,
        requestId,
        ...err.extra,
      },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        type: "/errors/bad-request",
        title: "Invalid request",
        status: 400,
        detail: "Some fields are invalid",
        errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId,
      },
    };
  }
  return {
    status: 500,
    body: {
      type: "/errors/internal",
      title: "Something went wrong",
      status: 500,
      detail: `Please try again. Reference ${requestId}`,
      requestId,
    },
  };
}
