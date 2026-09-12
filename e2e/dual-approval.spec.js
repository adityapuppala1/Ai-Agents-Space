import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { HOMES } from "./global-setup.js";

/**
 * A request that needs two approvers can be finished from the Inbox: each
 * approver gives a name, the first approval is reported as one of two (the
 * run keeps waiting), the same name twice is refused in the server's words,
 * and a second, different name releases the run.
 */
test("the inbox finishes a dual approval with two named approvers", async ({
  page,
  request,
}) => {
  const name = `dual-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();
  // Commands need a human here (scoped, nothing hard-denied), and a command
  // approval needs two different approvers.
  const policy = await request.put(`/api/workspaces/${ws.id}/policy`, {
    data: {
      autonomy: "scoped",
      deniedCommands: [],
      dualApprovalFor: ["command"],
    },
  });
  expect(policy.ok(), await policy.text()).toBeTruthy();

  const pending = request.post("/api/hooks/claude-code", {
    data: {
      session_id: `e2e-dual-${Date.now().toString(36)}`,
      transcript_path: path.join(rootPath, "transcript.jsonl"),
      cwd: rootPath,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "git push origin release", description: "push" },
      tool_use_id: `toolu_${Date.now().toString(36)}`,
    },
    timeout: 120000,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const card = page
    .locator(".as-approval")
    .filter({ hasText: "git push origin release" });
  await expect(card).toBeVisible({ timeout: 20000 });
  const approvers = card.getByRole("group", { name: "Approvers" });
  await expect(approvers).toContainText("Needs 2 different approvers");
  await expect(approvers).toContainText("0 of 2 recorded");
  const nameField = card.getByLabel(/^Your name/);
  const feedback = page.locator(".as-feedback");

  // Without a name the approval is not sent, and the field is focused.
  await card.getByRole("button", { name: "Approve command" }).click();
  await expect(feedback).toContainText("Type your name first");
  await expect(nameField).toBeFocused();

  await nameField.fill("Alice");
  await card.getByRole("button", { name: "Approve command" }).click();
  await expect(feedback).toContainText("Approval 1 of 2 recorded, by Alice");
  await expect(feedback).toContainText("keeps waiting");
  await expect(approvers).toContainText("1 of 2 recorded (Alice)");
  // The field is cleared for the next approver.
  await expect(nameField).toHaveValue("");
  await expect(
    card.getByRole("button", { name: "Approve command" }),
  ).toContainText("Approve as second approver");

  // The same approver twice: refused, in the server's words.
  await nameField.fill("Alice");
  await card.getByRole("button", { name: "Approve command" }).click();
  await expect(feedback).toContainText("second, distinct approver");
  await expect(card).toBeVisible();

  // A second, different approver releases the run.
  await nameField.fill("Bob");
  await card.getByRole("button", { name: "Approve command" }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
  await expect(card).toHaveCount(0, { timeout: 15000 });

  // Both names are on the record.
  const decided = await (
    await request.get(`/api/approvals?workspace=${ws.id}`)
  ).json();
  const list = Array.isArray(decided) ? decided : (decided.approvals ?? []);
  const approval = list.find((entry) =>
    JSON.stringify(entry.payload ?? {}).includes("git push origin release"),
  );
  expect(approval?.status).toBe("approved");
  expect(approval?.decidedBy).toContain("Alice");
  expect(approval?.decidedBy).toContain("Bob");
});
