import * as Sentry from "@sentry/nextjs";

// Server and edge error tracking. Off unless SENTRY_DSN is set, so local dev and CI send nothing.
export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // Collect nothing personal: no user info, cookies, headers, bodies, prompts or query data.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
  });
}

// Errors thrown while rendering server components and route handlers.
export const onRequestError = Sentry.captureRequestError;
