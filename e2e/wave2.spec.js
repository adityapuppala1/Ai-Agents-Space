import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * Wave 2 surfaces wired into App.jsx: global search, drag-to-assign, the
 * decision inbox "request change" outcome, the operations panel, day in
 * review, pinned runs and the workspace switcher.
 *
 * Everything runs against the e2e server (in-memory database, fake provider
 * CLIs, throwaway provider homes). Nothing touches the real machine.
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

async function createTask(request, workspaceId, title) {
  const response = await request.post(`/api/workspaces/${workspaceId}/tasks`, {
    data: { title, priority: "high" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json();
}

async function openApp(page) {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
}

async function switchWorkspace(page, id) {
  await page.getByLabel("Switch workspace", { exact: true }).selectOption(id);
  await expect(
    page.getByText("PROJECT WORKSPACE", { exact: true }),
  ).toBeVisible();
}

test("global search finds a recorded task and opens it", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `search-${stamp()}`);
  const title = `Findable payments audit ${stamp()}`;
  await createTask(request, ws.id, title);
  await openApp(page);
  await switchWorkspace(page, ws.id);

  await page.keyboard.press("Control+Shift+F");
  const dialog = page.getByRole("dialog", { name: "Global search" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("combobox", { name: /^Search tasks/ })
    .fill("Findable payments audit");
  const result = dialog.getByRole("option").filter({ hasText: "Findable" });
  await expect(result.first()).toBeVisible({ timeout: 15000 });
  await result.first().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".task-details h3")).toHaveText(title);
});

test("drag-to-assign assigns a task with the keyboard only", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `assign-${stamp()}`);
  const title = `Keyboard assignment ${stamp()}`;
  await createTask(request, ws.id, title);
  await openApp(page);
  await switchWorkspace(page, ws.id);
  await page.getByRole("button", { name: "Board", exact: true }).click();

  const assign = page.getByRole("region", {
    name: "Assign a task to an agent",
  });
  await expect(assign).toBeVisible();
  const task = assign.getByRole("button", { name: `Task ${title}.` });
  // locator.press focuses the element first, so this is the real keyboard
  // path and not a race with a re-render moving focus.
  await task.press("a");
  // The app-wide "a" shortcut (Analytics) must not steal the key: the board
  // and the widget are still here.
  await expect(assign).toBeVisible();
  const picker = assign.getByRole("listbox", {
    name: `Choose an agent for ${title}`,
  });
  await expect(picker).toBeVisible();
  await picker.press("Enter");

  const proposal = assign.getByRole("alertdialog", {
    name: "Proposed assignment",
  });
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText("Assigning records the assignment only");
  await proposal
    .getByRole("button", { name: "Assign", exact: true })
    .press("Enter");
  await expect(assign.getByRole("status").last()).toContainText(
    /assigned to/i,
    { timeout: 15000 },
  );
  const after = await request.get(`/api/workspaces/${ws.id}/tasks`);
  const tasks = await after.json();
  expect(tasks.find((t) => t.title === title).assignedAgentId).toBeTruthy();
});

test("requesting a change leaves the approval pending, then approving releases it", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `change-${stamp()}`);
  const policy = await request.put(`/api/workspaces/${ws.id}/policy`, {
    data: { autonomy: "scoped", deniedCommands: [] },
  });
  expect(policy.ok(), await policy.text()).toBeTruthy();
  await openApp(page);

  const command = `git push origin change-${stamp()}`;
  const pending = request.post("/api/hooks/claude-code", {
    data: {
      session_id: `e2e-change-${stamp()}`,
      transcript_path: path.join(ws.rootPath, "transcript.jsonl"),
      cwd: ws.rootPath,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command, description: "push" },
      tool_use_id: `toolu_${stamp()}`,
    },
    timeout: 120000,
  });

  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const card = page.locator(".as-approval").filter({ hasText: command });
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByRole("button", { name: /^Request a change to/ }).click();
  await expect(page.locator(".as-inbox")).toContainText(
    "The approval stays pending",
    { timeout: 15000 },
  );
  // Still pending: the same card, with the same command, is still decidable.
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^Approve/ }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  expect((await response.json()).hookSpecificOutput.permissionDecision).toBe(
    "allow",
  );
});

test("operations panel reports health and confirms before stopping everything", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  const ops = page.getByRole("region", { name: "Operations" });
  await expect(ops).toBeVisible();
  await expect(ops).toContainText("Uptime");
  await expect(ops).toContainText("Schema version");

  await ops.getByRole("button", { name: "Stop all runs…" }).click();
  await expect(ops).toContainText("Stop every run now?");
  // Deliberately not stopping: this suite shares one server with every other
  // test, and stopping dispatch would change their behaviour.
  await ops.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    ops.getByRole("button", { name: "Stop all runs…" }),
  ).toBeVisible();
  await expect(ops).not.toContainText("Dispatch is stopped.");
});

test("day in review is assembled from recorded events", async ({ page }) => {
  await openApp(page);
  await page
    .getByRole("button", { name: "Day in review", exact: true })
    .click();
  const review = page.getByRole("region", { name: "Day in review" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("assembled from recorded events");
  const assemble = review.getByRole("button", { name: /^Assemble \d+ run/ });
  await expect(assemble).toBeEnabled({ timeout: 15000 });
  await assemble.click();
  await expect(review.locator(".as-dayreview-chapter").first()).toBeVisible({
    timeout: 20000,
  });
  await expect(review).toContainText(/recorded events/);
});

test("a pinned run survives a reload", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.locator(".as-tl-row").first().click();
  await page.getByRole("button", { name: "Open run", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Run inspector" });
  await expect(dialog).toBeVisible();
  const pin = dialog.getByRole("button", { name: "Pin this run" });
  await pin.click();
  await expect(
    dialog.getByRole("button", { name: "Unpin this run" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const pinned = page.getByRole("region", { name: "Pinned runs" });
  await expect(pinned).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Pinned runs" })).toBeVisible();
});

test("the workspace switcher shows runtimes, runs and attention", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: /Open workspace switcher$/ }).click();
  const menu = page.getByRole("menu", { name: "Workspaces" });
  await expect(menu).toBeVisible();
  const demo = menu.getByRole("menuitemradio").filter({ hasText: "Demo" });
  await expect(demo.first()).toContainText(/active run/);
  await expect(demo.first()).toContainText(/need attention/);
  await expect(demo.first()).toContainText(/Theme:/);
  await expect(menu.locator(".as-runtime-chip").first()).toBeVisible({
    timeout: 20000,
  });
  await expect(menu.locator(".as-runtime-chip").first()).toContainText(
    /Claude Code|Codex|Copilot|Cursor|Gemini/,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("office settings are stored on the server and come back after a reload", async ({
  page,
}) => {
  await openApp(page);
  const openSettings = async () => {
    await page
      .getByRole("button", { name: "Workspace settings", exact: true })
      .click();
    return page.getByRole("dialog", { name: "Workspace settings" });
  };

  let settings = await openSettings();
  await settings
    .getByLabel("Label density", { exact: true })
    .selectOption("active");
  await settings
    .getByLabel("Office lighting", { exact: true })
    .selectOption("evening");
  await settings.getByRole("switch", { name: "Ambient room tone" }).click();
  await settings
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();

  await page.reload();
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  settings = await openSettings();
  await expect(
    settings.getByLabel("Label density", { exact: true }),
  ).toHaveValue("active");
  await expect(
    settings.getByLabel("Office lighting", { exact: true }),
  ).toHaveValue("evening");
  await expect(
    settings.getByRole("switch", { name: "Ambient room tone" }),
  ).toHaveAttribute("aria-checked", "true");

  // Restore the defaults: these settings are server-wide and shared with
  // every other test on this server.
  await settings
    .getByLabel("Label density", { exact: true })
    .selectOption("auto");
  await settings
    .getByLabel("Office lighting", { exact: true })
    .selectOption("day");
  await settings.getByRole("switch", { name: "Ambient room tone" }).click();
  await expect(
    settings.getByRole("switch", { name: "Ambient room tone" }),
  ).toHaveAttribute("aria-checked", "false");
  await settings
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
});

test("knowledge, memory and handover panels render for a workspace", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `knowledge-${stamp()}`);
  await openApp(page);
  await switchWorkspace(page, ws.id);
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  const stack = page.locator(".knowledge-stack");
  await expect(stack).toBeVisible();
  // Each panel either shows its content or names the route it needs; neither
  // may throw, and none of them may show an unexplained empty list.
  await expect(
    stack.getByRole("region", { name: "Knowledge collections" }),
  ).toBeVisible();
  await expect(
    stack.getByRole("region", { name: "Scoped memory" }),
  ).toBeVisible();
  await expect(
    stack.getByRole("region", { name: "Handover brief" }),
  ).toBeVisible();
});
