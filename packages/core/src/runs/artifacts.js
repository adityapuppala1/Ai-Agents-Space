import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSecretPath } from "../contracts.js";
import { git, isGitRepo, repoRoot } from "./worktree.js";

export const DIFF_LIMIT = 512 * 1024;
const UNTRACKED_FILE_LIMIT = 64 * 1024;

export const TEST_PATTERNS =
  /\b(npm (run )?test|npx (vitest|jest|mocha|playwright)|node --test|vitest|jest|pytest|mocha|playwright test|go test|cargo test|phpunit|dotnet test|mvn test|gradle test|rspec)\b/i;

function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text:
      text.slice(0, limit) +
      `\n\n[truncated: output exceeded ${Math.round(limit / 1024)} KB]\n`,
    truncated: true,
  };
}

function syntheticNewFileDiff(cwd, relPath) {
  const absolute = join(cwd, relPath);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return "";
    if (stat.size > UNTRACKED_FILE_LIMIT)
      return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n[untracked file omitted: ${stat.size} bytes]\n`;
    const buffer = readFileSync(absolute);
    if (buffer.includes(0))
      return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary files /dev/null and b/${relPath} differ\n`;
    const content = buffer.toString("utf8");
    const lines = content.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return (
      `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((line) => `+${line}`).join("\n") +
      "\n"
    );
  } catch {
    return "";
  }
}

/**
 * Captures `git diff` and `git status --porcelain` for a run cwd. Untracked
 * text files are appended as synthetic "new file" diffs so a run that only
 * created files still yields a reviewable patch. Secret paths are skipped.
 */
export async function captureGitDiff(cwd) {
  if (!(await isGitRepo(cwd)))
    return { diff: "", status: "", truncated: false, isRepo: false, files: [] };
  // Scope both commands to the run folder (`-- .`): from a subdirectory git
  // would otherwise report the whole repository, including unrelated dirty
  // files above the workspace. Porcelain paths are repository-relative.
  let root = cwd;
  try {
    root = await repoRoot(cwd);
  } catch {
    root = cwd;
  }
  const status = await git(
    ["status", "--porcelain", "--untracked-files=all", "--", "."],
    cwd,
  );
  let diff = await git(["diff", "--no-color", "--", "."], cwd);
  const files = [];
  const skipped = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").pop();
    if (/^"(.*)"$/.test(path)) path = path.slice(1, -1);
    if (path.startsWith("..")) continue;
    if (isSecretPath(path)) {
      skipped.push(path);
      continue;
    }
    files.push({ path, status: code.trim() || "M" });
    if (code === "??" && diff.length < DIFF_LIMIT)
      diff += syntheticNewFileDiff(root, path);
  }
  const limited = truncate(diff, DIFF_LIMIT);
  return {
    diff: limited.text,
    status,
    truncated: limited.truncated,
    isRepo: true,
    files,
    skipped,
  };
}

export function isTestCommand(command) {
  return TEST_PATTERNS.test(String(command ?? ""));
}

/**
 * Collects command events that look like test runs, with any output the
 * provider reported for them.
 */
export function captureTestOutput(events) {
  const results = [];
  for (const event of events) {
    const command =
      event.data?.command ??
      (typeof event.data?.input?.command === "string"
        ? event.data.input.command
        : null);
    const kind = event.kind;
    if (kind !== "test" && !(kind === "command" && isTestCommand(command)))
      continue;
    if (!command && kind !== "test") continue;
    results.push({
      command: command ?? event.message ?? event.summary ?? "",
      output: event.data?.output ?? event.data?.aggregated_output ?? null,
      exitCode: event.data?.exitCode ?? event.data?.exit_code ?? null,
      timestamp: event.timestamp,
      provenance: event.provenance,
    });
  }
  return results;
}

/** Last provider message text in the run, or null. */
export function finalMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "message") continue;
    const text = event.data?.text ?? event.message ?? event.summary;
    if (text) return String(text);
  }
  return null;
}

export function formatTestOutput(tests) {
  return tests
    .map((test) => {
      const head = `$ ${test.command}${
        test.exitCode !== null && test.exitCode !== undefined
          ? ` (exit ${test.exitCode})`
          : ""
      }`;
      return test.output ? `${head}\n${test.output}` : head;
    })
    .join("\n\n");
}
