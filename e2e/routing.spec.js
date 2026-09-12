import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * Routing and data rules: a workspace says where confidential work may go,
 * the ranking explains who would take it and why the others would not, the
 * task launcher shows the same reasons, and the server refuses a launch
 * that breaks the rule. Fake provider CLIs only.
 */
test("a data rule is set, explained in the ranking, shown in the launcher and enforced at launch", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const name = `routing-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const ws = await (
    await request.post("/api/workspaces", { data: { name, rootPath } })
  ).json();
  await page.addInitScript((id) => {
    localStorage.setItem("agent-space-workspace", id);
    localStorage.setItem(
      "agent-space-onboarding",
      JSON.stringify({ step: 0, done: [], dismissed: true }),
    );
  }, ws.id);
  await page.goto("/");

  // Settings → Edit policy → Routing and data rules.
  await page
    .getByRole("button", { name: "Workspace settings", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Edit policy" }).click();
  const card = page.getByRole("region", { name: "Routing and data rules" });
  await expect(card).toBeVisible();
  await card
    .getByLabel("Label for this workspace's tasks")
    .selectOption("confidential");
  await card.getByLabel("Confidential: any vendor").uncheck();
  await card.getByLabel("Confidential: Anthropic").check();
  await expect(card).toContainText("Only Anthropic");
  await card.getByRole("button", { name: "Save routing" }).click();
  await expect(card.getByRole("status").first()).toContainText("Routing saved");
  const stored = await (
    await request.get(`/api/workspaces/${ws.id}/policy`)
  ).json();
  expect(stored.dataSensitivity).toBe("confidential");
  expect(stored.dataRules.confidential).toEqual(["anthropic"]);

  // Who would take confidential work, and why not the others.
  await card.getByRole("button", { name: "Rank the assistants" }).click();
  const ranking = card.locator(".routing-ranking");
  await expect(ranking.locator("li.is-eligible").first()).toContainText(
    "Claude Code",
  );
  await expect(ranking.locator("li", { hasText: "Codex" })).toContainText(
    "Confidential work may go only to Anthropic",
  );

  // The server refuses the launch that breaks the rule, and says why.
  const task = await (
    await request.post(`/api/workspaces/${ws.id}/tasks`, {
      data: { title: "Customer export" },
    })
  ).json();
  const refused = await request.post(
    `/api/workspaces/${ws.id}/tasks/${task.id}/run`,
    { data: { provider: "codex" } },
  );
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain(
    "Confidential work may go only to Anthropic",
  );

  // The launcher shows the same: Codex is offered with the reason, not as a
  // choice, and the recommendation names who would take it.
  await page.keyboard.press("Escape");
  await page
    .locator("dialog[open]")
    .first()
    .waitFor({ state: "detached" })
    .catch(() => {});
  await page.goto("/");
  await page.getByRole("button", { name: "New task" }).first().click();
  const launcher = page.locator("dialog[open]");
  await launcher.getByRole("button", { name: "More options" }).click();
  const codex = launcher.locator("option", { hasText: "Codex" });
  // An <option> in a closed select: check the property itself.
  await expect(codex).toHaveJSProperty("disabled", true);
  await expect(codex).toContainText(
    "not for Confidential work (sends it to OpenAI)",
  );
  await expect(launcher.locator(".routing-note")).toContainText(
    "Recommended: Claude Code",
  );
});
