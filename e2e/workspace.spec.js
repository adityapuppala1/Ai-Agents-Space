import { test, expect } from "@playwright/test";

test("workspace remains usable when WebGL is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type.startsWith("webgl")) return null;
      return original.call(this, type, ...args);
    };
  });
  await page.goto("/");
  await expect(
    page.getByText("The team is still here.", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".scene-fallback")
    .getByRole("button", { name: /Sage/ })
    .click();
  await expect(
    page.getByText("Ready for what’s next.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Task board", exact: true })
    .first()
    .click();
  await expect(page.locator(".task-row")).toHaveCount(7);
});

test("office renders and manual task lifecycle synchronizes across tabs", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Nova", exact: true }),
  ).toBeVisible();
  // The office now also renders a minimap canvas; the 3D scene canvas is first.
  await expect(page.locator(".office-canvas canvas").first()).toBeVisible();
  await page.waitForFunction(
    () => document.querySelector(".scene-label")?.style.left,
  );
  await page.screenshot({
    path: "artifacts/workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Pause demo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume demo", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect Orbit", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review deployment configuration" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Reset camera", exact: true }).click();
  const second = await context.newPage();
  await second.goto("/");
  await second
    .getByRole("button", { name: "Task board", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Task name", { exact: true })
    .fill("Review the finished workspace");
  await page
    .getByLabel("Description")
    .fill("Verify the local preview and finish the review.");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator(".task-details h3")).toHaveText(
    "Review the finished workspace",
  );
  await expect(
    second
      .locator(".task-row")
      .filter({ hasText: "Review the finished workspace" }),
  ).toBeVisible();
  await page
    .getByLabel("Available agent", { exact: true })
    .selectOption("sage");
  await page.getByRole("button", { name: "Assign task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "+10% progress", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "+10% progress", exact: true })
    .click();
  await expect(page.locator(".progress-heading strong")).toHaveText("10%");
  await page.getByRole("button", { name: "Pause task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume task", exact: true }).click();
  await page
    .getByRole("button", { name: "Mark complete", exact: true })
    .click();
  await expect(page.locator(".completed-note")).toBeVisible();
  await expect(
    second
      .locator(".task-row")
      .filter({ hasText: "Review the finished workspace" })
      .getByText("Completed", { exact: true }),
  ).toBeVisible();
  await second.reload();
  await expect(
    second.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await page.getByRole("switch", { name: "Dark appearance" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .getByRole("button", { name: "Use light theme", exact: true })
    .click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local task API", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("workspaces are isolated and agent edits persist across reloads", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption("__new");
  await page.getByLabel("Workspace name", { exact: true }).fill("Storefront");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByLabel("Switch workspace", { exact: true }),
  ).toHaveValue(/^storefront/);
  await expect(
    page.getByText("PROJECT WORKSPACE", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Task board", exact: true })
    .first()
    .click();
  await expect(page.locator(".task-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Inspect Nova", exact: true }).click();
  await page.getByRole("button", { name: "Edit Nova", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Nova Prime");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Inspect Nova Prime", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Switch workspace", { exact: true }),
  ).toHaveValue(/^storefront/);
  await expect(
    page.getByRole("button", { name: "Inspect Nova Prime", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption("demo");
  await expect(
    page.getByRole("button", { name: "Inspect Nova", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("DEMO WORKSPACE", { exact: true })).toBeVisible();
});

test("mobile layout fits viewport and keyboard can create a task", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Inspect Nova", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(
    () => document.querySelector(".scene-label")?.style.left,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/workspace-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByLabel("Task name", { exact: true })).toBeFocused();
  await page
    .getByLabel("Task name", { exact: true })
    .fill("Mobile keyboard task");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.locator(".task-details h3")).toHaveText(
    "Mobile keyboard task",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
