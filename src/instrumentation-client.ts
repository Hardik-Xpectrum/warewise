// Browser error tracking, sent through /monitoring on this site (no third-party requests, so the
// CSP and ad blockers don't drop it). Off unless NEXT_PUBLIC_SENTRY_DSN is set at build time, and
// then loaded lazily: without a DSN the SDK (~250 KB) is never downloaded.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const sentry = dsn
  ? import("@sentry/nextjs").then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
        tracesSampleRate: 0.1,
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
        // Canvas, WebGL and camera errors on old devices are noise unless they break a page.
        ignoreErrors: ["ResizeObserver loop", "AbortError", "NotAllowedError"],
      });
      return Sentry;
    })
  : null;

export function onRouterTransitionStart(href: string, navigationType: string) {
  sentry?.then((Sentry) => Sentry.captureRouterTransitionStart(href, navigationType));
}
