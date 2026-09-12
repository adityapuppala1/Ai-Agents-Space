import { test, expect } from "@playwright/test";

/**
 * Setup, after the first run: it stays on screen through its own steps, and a
 * starter workflow asks for the inputs its tasks name instead of creating
 * tasks titled "{{client}}".
 */

test("setup keeps its remaining steps and a starter workflow asks for its inputs", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .click();
  await page.getByRole("button", { name: /^Open setup\./ }).click();
  const setup = page.getByRole("region", { name: "Setup" });
  await expect(setup).toBeVisible();

  // Observed before: creating the sample workspace made "no project
  // workspace" false and setup vanished before its remaining steps.
  await setup
    .getByRole("button", { name: /Disposable sample workspace/ })
    .click();
  const name = `Sample ${Date.now().toString(36)}`;
  const form = setup.getByRole("form", { name: "Create a sample workspace" });
  await form.getByRole("textbox").first().fill(name);
  await form
    .getByRole("button", { name: "Create the sample workspace" })
    .click();
  await expect(setup).toContainText(`Created "${name}"`);
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: "One-click starter workflow" }),
  ).toBeVisible();

  // Observed before: "Create tasks" sent no inputs and the tasks were titled
  // with literal placeholders. Now the template's inputs are asked for.
  const templates = setup.locator(".as-onboard-templates > li");
  await templates.first().getByRole("button", { name: "Create tasks" }).click();
  const inputs = setup.getByRole("form", { name: /^Inputs for / });
  await expect(inputs).toBeVisible();
  const submit = inputs.getByRole("button", { name: /^Create \d* ?tasks$/ });
  await expect(submit).toBeDisabled();
  const fields = inputs.getByRole("textbox");
  for (let index = 0; index < (await fields.count()); index += 1)
    await fields.nth(index).fill(`E2E value ${index + 1}`);
  await submit.click();
  await expect(setup).toContainText(/Created \d+ tasks? from the template/);

  const workspaceId = await page.evaluate(() =>
    localStorage.getItem("agent-space-workspace"),
  );
  const tasks = await (
    await request.get(`/api/workspaces/${workspaceId}/tasks`)
  ).json();
  expect(tasks.length).toBeGreaterThan(0);
  for (const task of tasks) expect(task.title).not.toMatch(/\{\{/);
  expect(tasks.some((task) => task.title.includes("E2E value"))).toBe(true);

  // The server refuses a template without its inputs, whoever calls it.
  const refused = await request.post(
    `/api/workspaces/${workspaceId}/workflows`,
    {
      data: { templateId: "agency-delivery" },
    },
  );
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain("needs a value for");
});
