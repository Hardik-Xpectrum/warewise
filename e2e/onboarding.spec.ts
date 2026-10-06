import { expect, test } from "@playwright/test";
import { deleteAccount, newEmail, signIn } from "./helpers";

// The welcome flow, one screen per step: name and city, sizes, style quiz, then the sample
// wardrobe. What was entered must land in the profile, and the flow must not come back.
test("first-run onboarding saves each step and runs once", async ({ page, isMobile }) => {
  await signIn(page, newEmail(isMobile ? "welcome-phone" : "welcome"), { welcome: "stay" });

  await expect(page.getByRole("heading", { name: "Hi! What should we call you?" })).toBeVisible();
  await page.getByLabel("Your name").fill("Hardik");
  await page.getByLabel("Home city").fill("Pune");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Your sizes" })).toBeVisible();
  await page.getByRole("radio", { name: "M", exact: true }).click();
  await page.getByLabel("Waist (in)").fill("32");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Which feel like you?" })).toBeVisible();
  await page.getByRole("button", { name: /Minimal/ }).click();
  await page.getByRole("button", { name: /Classic/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // The 360° scan step is optional.
  await expect(page.getByRole("heading", { name: "Scan your body in 3D" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload a turn video" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  await expect(page.getByRole("heading", { name: "Now, your clothes" })).toBeVisible();
  await page.getByRole("button", { name: /Explore with a sample wardrobe/ }).click();
  await expect(page).toHaveURL(/\/today/);

  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.display_name).toBe("Hardik");
  expect(me.home_city).toBe("Pune");
  expect(me.body_profile).toMatchObject({ top_size: "M", waist_in: 32 });
  expect(me.style_prefs.styles).toEqual(["minimal", "classic"]);

  // Done once: Today no longer sends you back, and /welcome itself forwards to Today.
  await page.goto("/welcome");
  await expect(page).toHaveURL(/\/today/);

  // Profile saves itself: no Save button, a change persists across a reload.
  await page.goto("/profile");
  await page.getByLabel("Home city (for weather)").fill("Mumbai");
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Home city (for weather)")).toHaveValue("Mumbai");

  // Try-on before any photo: the sample model stands in, so the page is never empty.
  await page.goto("/tryon");
  await expect(page.getByText("Sample model", { exact: true })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  await deleteAccount(page);
});
