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

async function openApp(page, workspaceId = null) {
  if (workspaceId)
    await page.addInitScript(
      (id) => localStorage.setItem("agent-space-workspace", id),
      workspaceId,
    );
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
}

/**
 * A workspace of this test's own with one completed run from the fake Claude
 * CLI. Tests that need recorded runs used to rely on whichever workspace a
 * fresh browser opened first, which depended on what earlier specs created.
 */
async function workspaceWithRun(request, name) {
  const ws = await createWorkspace(request, name);
  const task = await createTask(request, ws.id, "WRITE_FILE and summarise");
  const launched = await request.post(
    `/api/workspaces/${ws.id}/tasks/${task.id}/run`,
    { data: { provider: "claude-code" } },
  );
  expect(launched.ok(), await launched.text()).toBeTruthy();
  const run = await launched.json();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/runs/${run.id}`)).json()).run?.status ??
        null,
      { timeout: 40000 },
    )
    .toBe("completed");
  return ws;
}

async function switchWorkspace(page, id) {
  await page.getByLabel("Switch workspace", { exact: true }).selectOption(id);
  await expect(
    page.getByText("Project workspace", { exact: true }),
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
  await page.getByRole("button", { name: "Task board", exact: true }).click();
  await page
    .getByRole("group", { name: "Task layout" })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  // Assignment repeats the task list, so it is folded until opened.
  await page.getByText("Assign tasks to agents", { exact: true }).click();

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

test("inbox decision keys act only on the request that has focus", async ({
  page,
  request,
}) => {
  const ws = await createWorkspace(request, `keys-${stamp()}`);
  const policy = await request.put(`/api/workspaces/${ws.id}/policy`, {
    data: { autonomy: "scoped", deniedCommands: [] },
  });
  expect(policy.ok(), await policy.text()).toBeTruthy();
  await openApp(page);

  const command = `git push origin keys-${stamp()}`;
  const pending = request.post("/api/hooks/claude-code", {
    data: {
      session_id: `e2e-keys-${stamp()}`,
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
  const inbox = page.getByRole("region", { name: "Decision inbox" });
  const card = inbox.locator(".as-approval").filter({ hasText: command });
  await expect(card).toBeVisible({ timeout: 20000 });

  // Observed before this fix: "A" with focus on another control approved the
  // first card. Now a decision key outside a card decides nothing.
  await inbox.getByRole("button", { name: "Refresh inbox" }).press("a");
  await expect(inbox).toContainText(
    "Decision keys act only on the request that has focus",
  );
  await expect(card).toBeVisible();
  // The app-wide "A" (Analytics) did not take over either.
  await expect(inbox).toBeVisible();

  // Typing in the note is text, never a decision.
  await card.getByRole("textbox").press("d");
  await expect(card.getByRole("textbox")).toHaveValue("d");
  await expect(card).toBeVisible();

  // With the card focused, "D" declines exactly that request.
  await card.press("d");
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  expect((await response.json()).hookSpecificOutput.permissionDecision).toBe(
    "deny",
  );
  await expect(card).toHaveCount(0, { timeout: 15000 });
});

test("operations panel reports health and confirms before stopping everything", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  const ops = page.getByRole("region", { name: "Operations" });
  await expect(ops).toBeVisible();
  await expect(ops).toContainText("Uptime");
  await expect(ops).toContainText(/schema \d+/);
  // Loaded values use the product's words, never raw detection ids.
  await expect(ops).toContainText(/Assistants available\s*\d+ of \d+/);
  await expect(ops).not.toContainText(/Providers ready|\bdetected\b/);

  // Deleting old records takes a second, explicit step. Cancelled here: the
  // suite shares one database.
  await ops.getByRole("button", { name: "Sweep now…" }).click();
  await expect(ops).toContainText("Delete every record older than");
  await ops
    .getByRole("group")
    .filter({ hasText: "Delete every record older than" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(ops.getByRole("button", { name: "Sweep now…" })).toBeVisible();

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

test("day in review is assembled from recorded events", async ({
  page,
  request,
}) => {
  const ws = await workspaceWithRun(request, `review-${stamp()}`);
  await openApp(page, ws.id);
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

test("a pinned run survives a reload", async ({ page, request }) => {
  const ws = await workspaceWithRun(request, `pin-${stamp()}`);
  await openApp(page, ws.id);
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await page.locator(".tl-label").first().click();
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

test("the workspace switcher says what is going on in each workspace", async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole("button", { name: /Open workspace switcher$/ }).click();
  // A dialog, not a menu: it holds text fields (create, rename), which a
  // menu may not.
  const menu = page.getByRole("dialog", { name: "Workspaces" });
  await expect(menu).toBeVisible();
  const list = menu.getByRole("list", { name: "All workspaces" });
  const demo = list.getByRole("button").filter({ hasText: "Demo workspace" });
  // The workspace you are in is the one that spells itself out: its folder
  // and its office theme, named in words and never shown as an id.
  const current = list.getByRole("button").filter({ has: page.locator(".ws-item-meta") });
  await expect(current).toHaveCount(1);
  await expect(current.locator(".ws-item-theme")).toHaveText(
    /^[A-Z][a-z]+( [a-z]+)*$/,
  );
  // Every other row is one line: a name, and at most one signal. A path on a
  // row you are only scanning past is what made this menu unreadable.
  await expect(demo.first()).toBeVisible();
  const signals = list.locator(".ws-item-signal");
  for (let i = 0; i < (await signals.count()); i += 1)
    await expect(signals.nth(i)).toHaveText(/^\d+ (attention|running)$/);
  // Detection status is global and lives in the top bar: no row repeats it.
  await expect(menu).not.toContainText(/\b(ready|detected|missing)\b/);
  // Zero counts are left out instead of reading "0 need attention".
  await expect(menu).not.toContainText(/\b0 (need|running|agents)/);
  // Managing is behind a second mode, so the default list is just a list.
  await expect(menu.getByRole("button", { name: /^Rename / })).toHaveCount(0);
  await menu.getByRole("button", { name: "Manage workspaces" }).click();
  await expect(
    menu.getByRole("button", { name: /^Rename / }).first(),
  ).toBeVisible();
  await menu.getByRole("button", { name: "Done managing" }).click();
  await expect(menu.getByRole("button", { name: /^Rename / })).toHaveCount(0);
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
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "Workspace settings" });
    await dialog.getByRole("button", { name: /^Environment/ }).click();
    return dialog;
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
  const tabs = stack.getByRole("tablist", { name: "Knowledge stores" });
  // Each store is its own tab; each panel either shows its content or names
  // the route it needs, and none may show an unexplained empty list.
  for (const [tab, region] of [
    ["Collections", "Knowledge collections"],
    ["Memory", "Scoped memory"],
    ["Handover briefs", "Handover brief"],
  ]) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(tabs.getByRole("tab", { name: tab })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(stack.getByRole("region", { name: region })).toBeVisible();
  }
  // Scope is chosen on the page, never taken from another page's selection.
  await expect(
    stack.getByLabel("What the brief is about", { exact: true }),
  ).toHaveValue("all");
  await tabs.getByRole("tab", { name: "Memory" }).click();
  await stack.getByRole("button", { name: "Run notes" }).click();
  await expect(stack).toContainText(/Choose a run|no runs yet/);
  // Arrow keys move between tabs.
  await tabs.getByRole("tab", { name: "Memory" }).press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "Handover briefs" }),
  ).toHaveAttribute("aria-selected", "true");
});
