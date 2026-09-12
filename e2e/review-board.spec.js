import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOMES } from "./global-setup.js";

/**
 * The review table says what the review is about.
 *
 * The board is a canvas texture, so what it draws cannot be read from the
 * DOM. What this test can check honestly is the data the board is given: the
 * changed files recorded on the run's own diff artifact. If that is wrong,
 * the wall is wrong.
 */

const stamp = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

test("a run's diff records which files changed, for the review table to name", async ({
  request,
}) => {
  const name = `review-${stamp()}`;
  const rootPath = path.join(HOMES.projects, name);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`);
  // A diff only exists where git can produce one: captureGitDiff reports
  // isRepo:false for a plain folder and records no diff artifact at all.
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: rootPath,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-b", "main");
  git("config", "user.email", "tester@example.invalid");
  git("config", "user.name", "Review Board Test");
  git("add", "README.md");
  git("commit", "-m", "first");
  const created = await request.post("/api/workspaces", {
    data: { name, rootPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const ws = await created.json();

  const task = await request.post(`/api/workspaces/${ws.id}/tasks`, {
    data: { title: "WRITE_FILE and summarise the project" },
  });
  expect(task.ok(), await task.text()).toBeTruthy();
  const { id: taskId } = await task.json();

  const launched = await request.post(
    `/api/workspaces/${ws.id}/tasks/${taskId}/run`,
    { data: { provider: "claude-code" } },
  );
  expect(launched.ok(), await launched.text()).toBeTruthy();
  const run = await launched.json();

  // Wait for the run to finish and its artifacts to be captured.
  let artifacts = [];
  for (let i = 0; i < 60; i += 1) {
    const response = await request.get(`/api/runs/${run.id}/artifacts`);
    if (response.ok()) {
      artifacts = await response.json();
      if (artifacts.some((a) => a.kind === "diff")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const diff = artifacts.find((a) => a.kind === "diff");
  expect(diff, "the run recorded a diff artifact").toBeTruthy();
  const files = diff.metadata?.files;
  expect(Array.isArray(files), "the diff names the files it changed").toBe(
    true,
  );
  expect(files.length).toBeGreaterThan(0);
  // Each entry is a path the board can shorten to a file name.
  for (const file of files) expect(typeof file.path).toBe("string");
  // The fake CLI writes this file, so it must be among them.
  expect(files.some((file) => file.path.includes("fake-output"))).toBe(true);
});
