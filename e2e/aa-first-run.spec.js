import { test, expect } from "@playwright/test";

/**
 * First-run behaviour.
 *
 * The file name starts with "aa-" on purpose: Playwright runs spec files in
 * path order and this suite must see the server before any other test creates
 * a project workspace, because the setup panel only appears while the database
 * holds nothing but the demo workspace and no provider is ready to launch.
 */

test("setup appears on a fresh database, is skippable, and stays reachable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();

  const setup = page.getByRole("region", { name: "Setup" });
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "Set up Agent Space" }),
  ).toBeVisible();
  // Nothing is blocking: the workspace is usable behind the panel.
  await expect(
    page.getByRole("button", { name: "Inspect Nova", exact: true }),
  ).toBeVisible();

  await setup.getByRole("button", { name: "Skip for now" }).click();
  await expect(setup).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Setup" })).toHaveCount(0);

  // A persistent way back in from settings.
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await page.getByRole("button", { name: /^Open setup\./ }).click();
  await expect(page.getByRole("region", { name: "Setup" })).toBeVisible();
});
