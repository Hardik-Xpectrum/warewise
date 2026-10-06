import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";

const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:54324";

export const newEmail = (tag: string) => `e2e-${tag}-${Date.now()}-${randomBytes(3).toString("hex")}@warewise.test`;

/** Finds the newest sign-in link Supabase emailed to `email` (via Mailpit's API). */
async function magicLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`);
    const found = (await res.json()) as { messages?: { ID: string }[] };
    const id = found.messages?.[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string };
      const link = `${msg.Text ?? ""} ${msg.HTML ?? ""}`.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/)?.[0];
      if (link) return link.replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No sign-in email arrived for ${email}`);
}

/**
 * Signs in exactly like a person: request the email link on /login, open it, land in the app.
 * New accounts start on the welcome flow; `welcome: "skip"` (the default) skips it to Today.
 */
export async function signIn(page: Page, email: string, { welcome = "skip" }: { welcome?: "skip" | "stay" } = {}) {
  await page.goto("/login");
  await page.getByLabel("Or get a sign-in link by email").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByText(/Link sent|Check your inbox/)).toBeVisible();
  await page.goto(await magicLink(email));
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.locator("[data-hydrated]")).toBeAttached(); // clicks before hydration are lost
  if (welcome === "stay") return;
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/today/);
  // Today renders its heading only after hydrating and loading, so keys and clicks now land.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Deletes the signed-in account through the UI (also the cleanup for every test user). */
export async function deleteAccount(page: Page) {
  await page.goto("/profile");
  page.once("dialog", (d) => d.accept("delete"));
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/$|\/login/);
}
