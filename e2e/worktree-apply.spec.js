import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOMES } from "./global-setup.js";

/**
 * A sandboxed run's reviewed changes are applied to the working tree from the
 * run inspector: not before the review is accepted, only after a confirmation
 * that lists the files, and never as a commit.
 */
test("reviewed worktree changes are applied from the inspector, uncommitted", async ({
  page,
  request,
}) => {
  const name = `apply-${Date.now().toString(36)}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", ...args],
      { cwd: rootPath, encoding: "utf8" },
    );
  git("init", "-q");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const commits = () => git("rev-list", "--count", "HEAD").trim();

  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();
  // Sandbox: every run works in its own git worktree.
  const policy = await request.put(`/api/workspaces/${ws.id}/policy`, {
    data: { autonomy: "sandbox" },
  });
  expect(policy.ok(), await policy.text()).toBeTruthy();
  const task = await (
    await request.post(`/api/workspaces/${ws.id}/tasks`, {
      data: { title: "WRITE_FILE in the sandbox", priority: "high" },
    })
  ).json();
  const launched = await request.post(
    `/api/workspaces/${ws.id}/tasks/${task.id}/run`,
    { data: { provider: "claude-code" } },
  );
  expect(launched.ok(), await launched.text()).toBeTruthy();
  const run = await launched.json();
  expect(run.worktree).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/runs/${run.id}`)).json()).run?.status,
      { timeout: 40000 },
    )
    .toBe("completed");
  const target = path.join(rootPath, "fake-output.txt");
  expect(fs.existsSync(target)).toBe(false);

  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    ws.id,
  );
  await page.goto("/");
  await page
    .locator("aside")
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await page.locator("button.feed-row").first().click();
  const inspector = page.locator("dialog[open] .as-inspector");
  await expect(inspector).toBeVisible();
  await inspector.getByRole("tab", { name: "Files/diff" }).click();

  // Before the review is accepted, it says why it cannot be applied.
  await expect(inspector.locator(".as-apply-blocked")).toContainText(
    "Accept the review first",
  );
  await inspector.getByRole("button", { name: "Accept changes" }).click();

  // Accepted: it can be applied, after a confirmation listing the files.
  await inspector
    .getByRole("button", { name: "Apply to my working tree…" })
    .click();
  const confirm = inspector.getByRole("group", { name: "Apply changes" });
  await expect(confirm).toContainText("Copies 1 file into");
  await expect(confirm).toContainText("Nothing is committed");
  await expect(confirm.locator(".as-apply-files")).toContainText(
    "fake-output.txt",
  );
  await confirm.getByRole("button", { name: "Apply 1 file" }).click();
  await expect(inspector).toContainText("Applied 1 file to", {
    timeout: 15000,
  });
  await expect(inspector).toContainText("They are not committed");

  // In the working tree, uncommitted.
  expect(fs.existsSync(target)).toBe(true);
  expect(commits()).toBe("1");
  expect(git("status", "--porcelain")).toContain("?? fake-output.txt");
});
