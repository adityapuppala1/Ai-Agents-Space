import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIFF_LIMIT,
  captureGitDiff,
} from "../packages/core/src/runs/artifacts.js";

/**
 * Capturing a run's diff reads untracked files with readFileSync, on the
 * thread that also answers every HTTP request and WebSocket frame. That is
 * only safe because the loop stops calling it once the diff reaches
 * DIFF_LIMIT — the check on `diff.length` in captureGitDiff is load-bearing,
 * and it does not look load-bearing.
 *
 * It matters because `git status --untracked-files=all` lists every file
 * inside an untracked directory rather than the directory itself, so a run
 * that created a build folder or installed dependencies can report tens of
 * thousands of paths. Measured here at 4 000 files, the bound keeps the
 * worst pause in the tens of milliseconds; without it the reads continue for
 * every path returned.
 *
 * This test exists to fail if that bound is ever removed or moved.
 */

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "as-artifacts-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-b", "main");
  git("config", "user.email", "tester@example.invalid");
  git("config", "user.name", "Artifact Test");
  writeFileSync(join(dir, "README.md"), "tracked\n");
  git("add", "README.md");
  git("commit", "-m", "first");
  // An untracked folder, the way a build or a dependency install leaves one.
  mkdirSync(join(dir, "build"), { recursive: true });
  for (let i = 0; i < files; i += 1)
    writeFileSync(join(dir, "build", `chunk-${i}.txt`), `file ${i}\n`);
  return dir;
}

/**
 * Runs `work()` while a 5 ms interval ticks, and reports the longest gap
 * between ticks. On an unblocked loop that stays near 5 ms; every
 * synchronous read inside `work()` adds to it directly.
 */
async function worstLoopDelay(work) {
  let worst = 0;
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const gap = Number(now - last) / 1e6;
    if (gap > worst) worst = gap;
    last = now;
  }, 5);
  try {
    return { value: await work(), worst };
  } finally {
    clearInterval(timer);
  }
}

test("a diff over a huge untracked folder stays bounded and keeps the loop free", async (t) => {
  const dir = makeRepo(4000);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { value, worst } = await worstLoopDelay(() => captureGitDiff(dir));

  assert.equal(value.isRepo, true);
  assert.ok(value.files.length > 0, "it still reports what changed");
  // The bound the synchronous reads rely on.
  assert.ok(
    value.diff.length <= DIFF_LIMIT + 4096,
    `diff grew to ${value.diff.length} bytes past the ${DIFF_LIMIT} limit`,
  );
  // Capture may take a while; it may not take the whole thread while it does.
  // Measured in the tens of milliseconds, so a quarter second is generous and
  // still catches the bound being removed.
  assert.ok(
    worst < 250,
    `event loop blocked for ${worst.toFixed(0)} ms during capture`,
  );
  // Every path still comes back, whether or not its contents were read.
  assert.ok(
    value.files.every((file) => file.path),
    "every reported file has a path",
  );
});
