import { expect, test } from "@playwright/test";

// What a signed-out visitor sees, and what they must not.
test("public pages load and app pages require sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Get started" }).first()).toBeVisible();
  // The hero assembles an outfit from four pieces on a loop.
  const hero = page.getByRole("figure", { name: /assembling into an outfit/ });
  await expect(hero).toBeVisible();
  await expect(hero.locator(".hero-piece")).toHaveCount(4);
  expect(await hero.locator(".hero-piece").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("assemble");

  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  for (const path of ["/today", "/wardrobe", "/stylist", "/profile"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("security headers are sent", async ({ request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("the API refuses anonymous and cross-site requests", async ({ request }) => {
  expect((await request.get("/api/v1/items")).status()).toBe(401);
  expect((await request.post("/api/v1/uploads", { headers: { origin: "https://evil.example" }, data: {} })).status()).toBe(403);
});

test("unknown pages show the 404 page", async ({ page }) => {
  // Signed-out visitors are sent to sign-in from unknown app paths; under a public path they get the 404.
  const res = await page.goto("/privacy/definitely-not-a-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("This page isn't in the wardrobe")).toBeVisible();
});
