import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

const stamp = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function createWorkspace(request, name) {
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const response = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { ...(await response.json()), rootPath };
}

async function openApp(page) {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
}

/**
 * Talking to an agent.
 *
 * A headless provider run is one shot, so a reply is not a chat message: it
 * resumes the provider's session as a new attempt. These tests check that the
 * interface says so, that the exchange is assembled from what was actually
 * recorded, and that a reply really does produce a second attempt.
 */

test("the conversation shows what was asked and what the agent answered", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `talk-${stamp()}`);
  await openApp(page);
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption(ws.id);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Task name", { exact: true })
    .fill("WRITE_FILE and summarise the project");
  await page
    .getByLabel("Provider", { exact: true })
    .selectOption("claude-code");
  await page.getByRole("button", { name: "Run now", exact: true }).click();

  const spotlight = page.locator(".inspector-main");
  await expect(spotlight.locator(".as-run-status").first()).toHaveText(
    /Completed/,
    { timeout: 40000 },
  );
  await spotlight
    .getByRole("button", { name: "Open run inspector", exact: true })
    .click();
  const inspector = page.locator("dialog[open] .as-inspector");
  await inspector.getByRole("tab", { name: "Conversation" }).click();

  const turns = inspector.locator(".as-turn");
  await expect(turns.first()).toBeVisible({ timeout: 15000 });
  // The prompt is the person's turn, and it is the prompt that was sent.
  await expect(turns.first()).toHaveClass(/you/);
  await expect(turns.first()).toContainText("WRITE_FILE");
  // The agent's turn comes from a recorded provider message.
  await expect(inspector.locator(".as-turn.agent").first()).toBeVisible();

  // Replying is offered, and says plainly that it starts a new attempt.
  const reply = inspector.getByRole("textbox", { name: /Reply/ });
  await expect(reply).toBeVisible();
  await expect(inspector.locator(".as-reply")).toContainText(/new attempt/);
});

test("a reply starts a second attempt and joins the same exchange", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `reply-${stamp()}`);
  await openApp(page);
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption(ws.id);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Task name", { exact: true })
    .fill("WRITE_FILE and summarise the project");
  await page
    .getByLabel("Provider", { exact: true })
    .selectOption("claude-code");
  await page.getByRole("button", { name: "Run now", exact: true }).click();

  const spotlight = page.locator(".inspector-main");
  await expect(spotlight.locator(".as-run-status").first()).toHaveText(
    /Completed/,
    { timeout: 40000 },
  );
  await spotlight
    .getByRole("button", { name: "Open run inspector", exact: true })
    .click();
  const inspector = page.locator("dialog[open] .as-inspector");
  await inspector.getByRole("tab", { name: "Conversation" }).click();
  await expect(inspector.locator(".as-turn").first()).toBeVisible({
    timeout: 15000,
  });
  const before = await inspector.locator(".as-turn").count();

  await inspector
    .getByRole("textbox", { name: /Reply/ })
    .fill("Also mention the test command");
  await inspector.getByRole("button", { name: /Send reply/ }).click();

  // The reply appears as a turn of its own, and the exchange grows.
  await expect(
    inspector.locator(".as-turn.you", {
      hasText: "Also mention the test command",
    }),
  ).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => inspector.locator(".as-turn").count(), {
      timeout: 30000,
    })
    .toBeGreaterThan(before);
  // Once there is more than one attempt, each turn says which it belongs to,
  // so a resumed session never looks like one unbroken conversation.
  await expect(inspector.locator(".as-turn-attempt").first()).toBeVisible({
    timeout: 30000,
  });
  if (process.env.AGENT_SPACE_CAPTURE)
    await inspector.screenshot({ path: process.env.AGENT_SPACE_CAPTURE });
});
