import { expect, test } from "@playwright/test";
import { deleteAccount, newEmail, signIn } from "./helpers";

// One new user's first session, end to end, in a real browser: sign in, sample wardrobe, Today,
// Complete the look, the stylist swipe deck (like = favourite), outfits, data export, deletion.
test("a new user's first session", async ({ page, isMobile }) => {
  const email = newEmail(isMobile ? "phone" : "desktop");
  await signIn(page, email);

  await test.step("Today: setup checklist and one-tap sample wardrobe", async () => {
    await expect(page.getByRole("heading", { name: /Here's what to wear/ })).toBeVisible();
    await expect(page.getByLabel("Get set up")).toBeVisible();
    await page.getByRole("button", { name: "Load sample wardrobe" }).click();
    await expect(page.getByText("Sample wardrobe added")).toBeVisible();
    await expect(page.getByText(/colour harmony \d+\/100/)).toBeVisible();
  });

  await test.step("Wardrobe lists the 12 sample items", async () => {
    await page.goto("/wardrobe");
    await expect(page.getByText("12 items")).toBeVisible();
  });

  await test.step("Complete the look builds outfits around one piece", async () => {
    // The tapped photo morphs into the item page (a shared-element view transition).
    await page.evaluate(() => {
      const w = window as unknown as { __morph: string[] };
      w.__morph = [];
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = ((cb: () => Promise<void>) => {
        const t = start(cb);
        t.ready.then(
          () => w.__morph.push(...document.getAnimations().map((a) => (a.effect as KeyframeEffect | null)?.pseudoElement ?? "").filter((p) => p.includes("morph"))),
          (e: Error) => w.__morph.push(`error: ${e.message}`),
        );
        return t;
      }) as typeof document.startViewTransition;
    });
    await page.locator('a[href^="/wardrobe/"]').first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __morph: string[] }).__morph.join(" "))).toContain("::view-transition-group(morph)");
    await page.getByRole("button", { name: "Style this piece" }).click();
    await expect(page.getByText(/ways? to wear it|Add a (top|bottom)/)).toBeVisible();
  });

  await test.step("Stylist: swipe deck, like saves a favourite", async () => {
    await page.goto("/stylist");
    // Chat-first: one tap on an occasion starts the session.
    await page.getByRole("group", { name: "Quick occasions" }).getByRole("button", { name: "Casual outing" }).click();
    const deck = page.locator('[aria-roledescription="swipe deck"]');
    await expect(deck).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "Like and save to favourites" }).click();
    await expect(page.getByText("Liked: saved to your favourites")).toBeVisible();
  });

  await test.step("The liked look is in Outfits → Favourites", async () => {
    await page.goto("/outfits");
    await page.getByRole("button", { name: /All outfits/ }).click();
    await expect(page.getByRole("button", { name: "Remove from favourites" }).first()).toBeVisible();
  });

  await test.step("Download my data returns a JSON export", async () => {
    await page.goto("/profile");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download my data" }).click();
    expect((await download).suggestedFilename()).toMatch(/^warewise-data-\d{4}-\d{2}-\d{2}\.json$/);
  });

  await test.step("Delete account removes everything and signs out", async () => {
    await deleteAccount(page);
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login/);
  });
});

test("swiping left passes and undo brings the card back", async ({ page, isMobile }) => {
  test.skip(isMobile, "mouse drag is covered on desktop; phones use the same pointer events");
  await signIn(page, newEmail("swipe"));
  await page.request.post("/api/v1/samples");
  await page.goto("/stylist");
  await page.getByRole("group", { name: "Quick occasions" }).getByRole("button", { name: "Casual outing" }).click();
  const card = page.locator('[aria-roledescription="swipe deck"] .cursor-grab');
  await expect(card).toBeVisible({ timeout: 90_000 });
  // Wait until the stylist has finished streaming looks, so the deck's count is final.
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeEnabled({ timeout: 90_000 });
  const label = await page.locator('[aria-roledescription="swipe deck"]').getAttribute("aria-label");

  // A real drag to the left, past the threshold.
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let dx = 0; dx >= -260; dx -= 40) await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2);
  await page.mouse.up();
  await expect(page.getByRole("button", { name: /Undo/ }).first()).toBeEnabled();

  await page.getByRole("button", { name: /Undo/ }).first().click();
  await expect(page.locator('[aria-roledescription="swipe deck"]')).toHaveAttribute("aria-label", label!);
  await deleteAccount(page);
});

test("keyboard: ⌘K palette jumps between pages", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard shortcuts are for desktop");
  await signIn(page, newEmail("keys"));
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Jump to…").fill("insights");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/insights/);
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/today/);
  await deleteAccount(page);
});
