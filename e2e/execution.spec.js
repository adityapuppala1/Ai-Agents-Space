import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HOMES } from "./global-setup.js";

/**
 * Execution flows against the e2e server: fake provider CLIs
 * (AGENT_SPACE_BIN_*), throwaway provider homes (CLAUDE_CONFIG_DIR etc.)
 * and an in-memory database. Nothing here touches the real machine.
 */

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

test("connections view lists providers with statuses and capability chips", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Local task API", exact: true }),
  ).toBeVisible();
  const table = page.locator(".as-conn-table");
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  for (const label of ["Claude Code", "Codex", "Copilot"])
    await expect(rows.filter({ hasText: label })).toHaveCount(1, {
      timeout: 15000,
    });
  const claude = rows.filter({ hasText: "Claude Code" });
  // Columns: Provider (row header), Kind, Alias, Status, ...
  // The fake CLI answers --version, so Claude Code is at least "detected".
  await expect(claude.locator("td").nth(2)).toHaveText(/ready|detected/);
  await expect(claude.locator(".as-cap").first()).toBeVisible();
  await expect(claude.locator(".as-cap-verified").first()).toBeVisible();
  const cursor = rows.filter({ hasText: "Cursor" });
  await expect(cursor.locator("td").nth(2)).toHaveText(
    /missing|detected|unknown|error/,
  );
});

test("Run now launches a managed run through the fake Claude CLI", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `run-${stamp()}`);
  await openApp(page);
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption(ws.id);
  await expect(
    page.getByText("PROJECT WORKSPACE", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Task name", { exact: true })
    .fill("WRITE_FILE and summarise the project");
  await page
    .getByLabel("Provider", { exact: true })
    .selectOption("claude-code");
  await page.getByRole("button", { name: "Run now", exact: true }).click();

  const spotlight = page.locator(".inspector-main");
  await expect(
    spotlight.locator(".as-provider-claude-code").first(),
  ).toContainText("Claude Code", { timeout: 20000 });
  await expect(spotlight.locator(".as-run-status").first()).toHaveText(
    /Completed/,
    { timeout: 40000 },
  );
  await spotlight
    .getByRole("button", { name: "Open run inspector", exact: true })
    .click();
  const inspector = page.locator("dialog[open] .as-inspector");
  await expect(inspector).toBeVisible();
  await expect(
    inspector.locator(".as-provider-claude-code").first(),
  ).toContainText("Claude Code");
  await inspector.getByRole("tab", { name: "Live activity" }).click();
  await expect(inspector.locator(".as-event").first()).toBeVisible();
  await expect(inspector.locator(".as-prov-provider").first()).toBeVisible();
  await expect(inspector.locator(".as-inferred").first()).toBeVisible();
  await inspector.getByRole("tab", { name: "Files/diff" }).click();
  await expect(inspector.locator(".as-artifact").first()).toBeVisible();
  await expect(inspector.locator(".as-artifact-list")).toContainText(
    /Final message|Changes \(git diff\)|Test output/,
  );
  await inspector.getByRole("tab", { name: "Usage" }).click();
  await expect(inspector.locator(".as-usage")).toContainText(
    /reported by provider/,
  );
  expect(fs.existsSync(path.join(ws.rootPath, "fake-output.txt"))).toBe(true);
});

test("a Claude Code hook approval flows through the inbox", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `hooks-${stamp()}`);
  // The default policy hard-denies "git push"; scoped + an empty denied list
  // turns it into a risky command that asks for a human decision.
  const policy = await request.put(`/api/workspaces/${ws.id}/policy`, {
    data: { autonomy: "scoped", deniedCommands: [] },
  });
  expect(policy.ok(), await policy.text()).toBeTruthy();

  await openApp(page);
  const badge = page.getByTestId("inbox-badge");
  // Baseline from the API (the badge may not have received its first global
  // snapshot yet); earlier tests can leave review-pending tasks in the inbox.
  const inboxBefore = await request.get("/api/inbox");
  expect(inboxBefore.ok(), await inboxBefore.text()).toBeTruthy();
  const before = Number((await inboxBefore.json()).counts?.total ?? 0);
  if (before > 0) await expect(badge).toHaveText(String(before));

  const sessionId = `e2e-hook-${stamp()}`;
  const pending = request.post("/api/hooks/claude-code", {
    data: {
      session_id: sessionId,
      transcript_path: path.join(ws.rootPath, "transcript.jsonl"),
      cwd: ws.rootPath,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "git push origin main", description: "push" },
      tool_use_id: `toolu_${stamp()}`,
    },
    timeout: 120000,
  });

  await expect(badge).toHaveText(String(before + 1), { timeout: 20000 });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const card = page
    .locator(".as-approval")
    .filter({ hasText: "git push origin main" });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".as-provider-claude-code")).toContainText(
    "Claude Code",
  );
  await card
    .getByRole("button", { name: "Approve command", exact: true })
    .click();

  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
  if (before === 0) await expect(badge).toHaveCount(0, { timeout: 15000 });
  else await expect(badge).toHaveText(String(before), { timeout: 15000 });
});

test("a live Claude Code session appears with an auto-created workspace", async ({
  page,
}) => {
  const name = `live-${stamp()}`;
  const cwd = path.join(HOMES.projects, name);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# live\n");
  const sessionId = randomUUID();
  // Claude Code names the transcript folder after the cwd with every
  // non-alphanumeric character replaced by "-".
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = path.join(HOMES.claude, "projects", slug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(HOMES.claude, "sessions"), { recursive: true });
  const now = Date.now();
  const line = (record) => `${JSON.stringify(record)}\n`;
  const base = {
    isSidechain: false,
    userType: "external",
    entrypoint: "cli",
    cwd,
    sessionId,
    version: "2.1.266",
    gitBranch: "main",
  };
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    line({
      ...base,
      parentUuid: null,
      type: "user",
      message: {
        role: "user",
        content: "Summarise this project for the live session test",
      },
      uuid: randomUUID(),
      timestamp: new Date(now - 4000).toISOString(),
    }) +
      line({
        ...base,
        parentUuid: null,
        type: "assistant",
        message: {
          model: "claude-haiku-4-5",
          id: `msg_${stamp()}`,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `toolu_${stamp()}`,
              name: "Read",
              input: { file_path: path.join(cwd, "README.md") },
            },
          ],
          usage: { input_tokens: 12, output_tokens: 6 },
        },
        uuid: randomUUID(),
        timestamp: new Date(now - 2000).toISOString(),
      }),
  );
  // Registry entry whose pid is this test runner, so the session counts as live.
  fs.writeFileSync(
    path.join(HOMES.claude, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: now - 5000,
      version: "2.1.266",
      kind: "interactive",
      entrypoint: "cli",
    }),
  );

  await openApp(page);
  const select = page.getByLabel("Switch workspace", { exact: true });
  await expect(select.locator("option").filter({ hasText: name })).toHaveCount(
    1,
    { timeout: 30000 },
  );
  await page
    .getByRole("button", { name: "Live sessions", exact: true })
    .click();
  const card = page
    .locator(".as-live-item")
    .filter({ hasText: "Summarise this project" });
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.locator(".as-provider-claude-code")).toContainText(
    "Claude Code",
  );
  await expect(card).toContainText(/Researching/, { timeout: 15000 });
  await expect(card.locator(".as-inferred").first()).toBeVisible();
  await expect(card).toContainText(name);
  await card.getByRole("button", { name: /^Open workspace/ }).click();
  await expect(
    page.getByText("PROJECT WORKSPACE", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Claude Code", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator(".agent-card").filter({ hasText: "auto" }),
  ).toHaveCount(1);
});

test("Ctrl+K opens the command palette and navigates to Analytics", async ({
  page,
}) => {
  await openApp(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("Analytics");
  await expect(palette.getByRole("option").first()).toContainText("Analytics");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Analytics" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analytics", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await page.keyboard.press("w");
  await expect(
    page.getByRole("button", { name: "Workspace", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
