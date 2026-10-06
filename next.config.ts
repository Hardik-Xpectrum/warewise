import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const supabaseWs = supabase.replace(/^http/, "ws");
// Cloudflare Turnstile (login CAPTCHA) only when it's configured.
const turnstile = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ? " https://challenges.cloudflare.com" : "";

// Everything the browser may talk to. Models for pose tracking and background removal are
// fetched once from their publishers' CDNs; images and realtime come from Supabase.
const csp = [
  "default-src 'self'",
  // Next injects small inline bootstrap scripts; WASM (MediaPipe, background removal) needs
  // wasm-unsafe-eval; dev mode's React refresh needs eval.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}${turnstile}`,
  `frame-src 'self'${turnstile}`,
  "style-src 'self' 'unsafe-inline'",
  // Shop Scan shows the scanned product's photo straight from the shop's image CDN.
  `img-src 'self' data: blob: ${supabase} https://*.myntassets.com https://*.ajio.com https://*.media-amazon.com https://*.flixcart.com https://*.hm.com https://*.zara.net https://cdn.shopify.com https://*.nykaafashion.com https://*.tatacliq.com https://*.meesho.com https://*.uniqlo.com`,
  "font-src 'self'",
  // blob: lets the 3D viewer read the texture packed inside a generated .glb model.
  `connect-src 'self' blob: ${supabase} ${supabaseWs} https://storage.googleapis.com https://staticimgly.com`,
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera is used by the live mirror on this site only; nothing else is needed.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  // AI config and prompt files are read at runtime; ship them with the server functions.
  outputFileTracingIncludes: {
    "/api/**": ["./config/**", "./prompts/**"],
  },
  // The service contract is TypeScript source in packages/contracts.
  transpilePackages: ["@warewise/contracts"],
  serverExternalPackages: ["sharp", "@huggingface/transformers", "onnxruntime-node"],
  // The on-device models (LOCAL_VISION, local development only) need ~300 MB of native runtime;
  // keep it out of hosted functions, which are capped at 250 MB.
  outputFileTracingExcludes: process.env.LOCAL_VISION === "1" ? undefined : {
    "*": ["node_modules/onnxruntime-node/**", "node_modules/onnxruntime-web/**", "node_modules/@huggingface/transformers/**"],
  },
  images: { unoptimized: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// Sentry wraps the build only when it's configured: the wrapper injects the browser SDK (~250 KB)
// into every page, which is pure weight without a DSN. With a DSN it adds the /monitoring tunnel
// and (with SENTRY_AUTH_TOKEN) uploads source maps.
const sentryOn = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN);

export default sentryOn
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      tunnelRoute: "/monitoring",
      silent: !process.env.CI,
      telemetry: false,
    })
  : nextConfig;
