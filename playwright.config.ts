import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end tests. They run against the app on port 3000 (the only port the local
// Supabase allows as a sign-in redirect) and read sign-in emails from the local Mailpit inbox.
//   npm run dev        (or `npm run build && npm start` with AI_CONFIG_FILE=config/ai.config.mock.json)
//   npm run e2e
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false, // one user journey at a time keeps the shared local database predictable
  workers: 1, // and keeps a dev server (compiling on demand) fast enough for the timeouts
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Video needs Playwright's ffmpeg download; CI installs it, local runs keep traces and screenshots.
    video: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [
    // Locally: your installed Chrome (no browser download). In CI: Playwright's Chromium.
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.CI ? undefined : "chrome" } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: process.env.CI ? undefined : "chrome" } },
  ],
});
