import { test, expect } from "@playwright/test";

test("office filters the scene, provides keyboard actions, and persists every environment", async ({
  page,
  request,
}) => {
  await request.post("/api/workspaces/demo/demo", { data: { running: false } });
  await page.addInitScript(() =>
    localStorage.setItem("agent-space-workspace", "demo"),
  );
  await page.goto("/");
  const scope = page.getByRole("region", { name: "Office controls" });
  await expect(scope).toBeVisible();
  // The toolbar states what kind of workspace this is and what is live.
  await expect(
    scope.getByText("Simulated preview", { exact: true }),
  ).toBeVisible();
  await expect(
    scope.getByText("Demo workspace", { exact: true }),
  ).toBeVisible();
  await expect(scope).toContainText(/on the floor/);
  await expect(scope).not.toContainText("[object Object]");
  // Count once the scene has drawn its labels; counting as soon as the
  // toolbar appears raced the 3D scene and could record zero.
  await expect(page.locator(".scene-label").first()).toBeVisible();
  const allCount = await page.locator(".scene-label").count();
  // Filters live in a popover so they never cover the floor.
  await scope.getByText("Filters", { exact: true }).click();
  await scope.getByRole("button", { name: /^Demo/ }).click();
  await expect(page.locator(".scene-label")).not.toHaveCount(0);
  await expect(
    page.locator(".scene-label").filter({ hasText: "Manual" }),
  ).toHaveCount(0);
  await scope.getByRole("button", { name: /^All assistants/ }).click();
  await expect(page.locator(".scene-label")).toHaveCount(allCount);
  const nova = page.getByRole("button", { name: "Inspect Nova", exact: true });
  await nova.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Agent actions" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Follow in 3D" }).click();
  await expect(page.locator(".office-follow")).toHaveText("Following Nova");
  await page.getByRole("button", { name: "Selected agent actions" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await scope.getByText("Environment", { exact: true }).click();
  for (const [id, label] of [
    ["garden", "Garden atelier"],
    ["midnight", "Midnight lab"],
    ["sandstone", "Desert studio"],
    ["operations", "Mission control"],
    ["studio", "Daylight studio"],
  ]) {
    await scope.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(`.office-theme-${id}`)).toBeVisible();
    expect(
      (await (await request.get("/api/workspaces/demo")).json()).theme,
    ).toBe(id);
  }
  await page.reload();
  await scope.getByText("Environment", { exact: true }).click();
  await expect(
    scope.getByRole("button", { name: "Daylight studio", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Escape closes the popover and returns focus to its toggle.
  await page.keyboard.press("Escape");
  await expect(
    scope.getByRole("button", { name: "Daylight studio", exact: true }),
  ).toHaveCount(0);
});

test("agent identity editor persists provider, skills, and 3D appearance", async ({
  page,
  request,
}) => {
  // Its own workspace: the task that puts Vector on the floor must not change
  // the demo task list other specs count, and tasks cannot be deleted.
  const created = await request.post("/api/workspaces", {
    data: { name: "Identity editor" },
  });
  expect(created.ok()).toBeTruthy();
  const workspaceId = (await created.json()).id;
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await page
    .locator("aside")
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("button", { name: "Add agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add an agent" });
  await dialog.locator("[name=name]").fill("Vector");
  await dialog.locator("[name=role]").fill("Research engineer");
  await dialog.locator("[name=provider]").selectOption("claude-code");
  await dialog.locator("[name=model]").fill("provider-default");
  await dialog.locator("[name=runtime]").fill("local-cli");
  await dialog
    .locator("[name=skills]")
    .fill("Research, citations, accessibility");
  await dialog.locator("[name=outfit]").selectOption("jacket");
  await dialog.locator("[name=accessory]").selectOption("headset");
  await dialog.locator("[name=pronouns]").fill("she/her");
  await dialog.getByRole("button", { name: "Add agent", exact: true }).click();
  await expect(page.getByText("Vector", { exact: true }).first()).toBeVisible();
  const agents = await (
    await request.get(`/api/workspaces/${workspaceId}/agents`)
  ).json();
  const saved = agents.find((agent) => agent.name === "Vector");
  expect(saved).toMatchObject({
    provider: "claude-code",
    model: "provider-default",
    runtime: "local-cli",
    skills: ["Research", "citations", "accessibility"],
  });
  expect(JSON.parse(saved.avatar)).toMatchObject({
    outfit: "jacket",
    accessory: "headset",
    pronouns: "she/her",
  });
  // Only agents with recorded work stand on the floor, so give Vector a task.
  const task = await (
    await request.post(`/api/workspaces/${workspaceId}/tasks`, {
      data: { title: "Vector field survey", priority: "medium" },
    })
  ).json();
  const assigned = await request.post(
    `/api/workspaces/${workspaceId}/tasks/${task.id}/assign`,
    { data: { agentId: saved.id } },
  );
  expect(assigned.ok()).toBeTruthy();
  await page
    .locator("aside")
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Vector", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "Inspect Vector", exact: true })
      .locator(".scene-pronouns"),
  ).toHaveText("she/her");
  // Vector's task is manual: nothing reports what it is doing, so the office
  // says only that the task is in progress, not the profile's working style.
  await expect(
    page
      .getByRole("button", { name: "Inspect Vector", exact: true })
      .locator(".scene-activity"),
  ).toHaveText("In progress (manual)");
  await expect(
    page.locator(".roster-item").filter({ hasText: "Vector" }),
  ).toContainText(/In progress\s*manual/);
  await page
    .getByRole("region", { name: "Office controls" })
    .getByText("Filters", { exact: true })
    .click();
  const roleScope = page.getByLabel("Filter office by role");
  await roleScope.getByRole("button", { name: /^Research engineer/ }).click();
  await expect(page.locator(".scene-label")).toHaveCount(1);
  await expect(page.locator(".scene-label")).toContainText("Vector");
  await expect(page.getByLabel("Agent capability details")).toContainText(
    "provider-default",
  );
  await expect(page.getByLabel("Agent capability details")).toContainText(
    "Research",
  );
});

test("a portable visual preset previews before it changes this workspace", async ({
  page,
  request,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("agent-space-workspace", "demo"),
  );
  await request.post("/api/workspaces/demo/visual-preset/apply", {
    data: {
      preset: {
        kind: "agent-space-visual-preset",
        version: 1,
        name: "Baseline office",
        theme: "studio",
        settings: { "ui.graphics": "medium", "ui.office.lighting": "day" },
      },
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace settings" })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Environment/ }).click();
  const upload = dialog.getByLabel("Import visual preset");
  await upload.setInputFiles({
    name: "midnight-office.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        kind: "agent-space-visual-preset",
        version: 1,
        name: "Midnight deployment room",
        theme: "midnight",
        settings: {
          "ui.graphics": "high",
          "ui.office.labelDensity": "active",
          "ui.office.lighting": "focus",
        },
      }),
    ),
  });
  const preview = dialog.getByLabel("Visual preset preview");
  await expect(preview).toContainText("Midnight deployment room");
  await expect(preview).toContainText("Theme");
  await expect(preview).toContainText("studio → midnight");
  expect((await (await request.get("/api/workspaces/demo")).json()).theme).toBe(
    "studio",
  );
  await preview.getByRole("button", { name: "Apply preset" }).click();
  await expect(
    page.getByText("Visual preset applied to this workspace"),
  ).toBeVisible();
  const current = await (await request.get("/api/workspaces/demo")).json();
  expect(current.theme).toBe("midnight");
  expect(current.settings.visual).toMatchObject({
    "ui.graphics": "high",
    "ui.office.labelDensity": "active",
    "ui.office.lighting": "focus",
  });
});

test("the system's reduce-motion setting stops the office's motion", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    ),
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/reduced-motion/);
  await page
    .locator("aside")
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Workspace settings" })
    .getByRole("button", { name: /^Environment/ })
    .click();
  // The app's own switch shows it is on, and why it cannot be turned off here.
  const toggle = page.getByRole("switch", { name: "Reduced motion" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeDisabled();
  await expect(
    page.getByText(/your system asks for less motion/),
  ).toBeVisible();
  await context.close();
});
