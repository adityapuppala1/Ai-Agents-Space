import { createHash } from "node:crypto";
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

// ----------------------------------------------------------------- snippets

/** Below these a fence is a fragment quoted in prose, not a reusable block. */
export const SNIPPET_MIN_LINES = 2;
export const SNIPPET_MIN_CHARS = 40;
export const SNIPPET_MAX_CHARS = 64 * 1024;
/** Artifacts materialized per run; anything past this is reported, not dropped. */
export const SNIPPET_LIMIT = 20;
/** Ceiling on raw candidates a chatty run may hold in memory before capture. */
export const SNIPPET_CANDIDATE_LIMIT = 200;

/** Fences that carry prose or captured output rather than source code. */
export const NON_CODE_LANGUAGES = new Set([
  "text",
  "txt",
  "plaintext",
  "plain",
  "output",
  "log",
  "console",
  "md",
  "markdown",
]);

/** A patch names the files it applies to, and the `diff` artifact covers it. */
export const FILE_TARGET_LANGUAGES = new Set(["diff", "patch"]);

const LANGUAGE_ALIASES = new Map([
  ["js", "javascript"],
  ["ts", "typescript"],
  ["py", "python"],
  ["sh", "shell"],
  ["ps1", "powershell"],
  ["yml", "yaml"],
]);

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const PATH_TOKEN =
  /(?:^|[\s:=("'`*[])([\w.$-]+(?:[\\/][\w.$-]+)*\.[A-Za-z0-9]{1,8})(?=["'`)\]\s*]|$)/;
const DOTFILE_TOKEN =
  /(?:^|[\s:=("'`*[])((?:[\w.$-]+[\\/])*\.[A-Za-z][\w.$-]*)(?=["'`)\]\s*]|$)/;
const COMMENT_PREFIX = /^\s*(?:\/\/+|#+|--|;+|<!--|\/\*+|\*)\s*/;
const LOOKS_LIKE_PATH = /[\\/]|\.[A-Za-z0-9]{1,8}$/;
/** Characters of message text kept before a fence, for file-mention checks. */
const HINT_WINDOW = 200;

/**
 * The fence info string is the only source of a snippet's language. Sniffing
 * the body would present an inference as a provider fact, so an unlabelled
 * fence reports `null` and the UI says the language was not reported.
 */
export function normalizeLanguage(info) {
  const raw = typeof info === "string" && info.trim() ? info.trim() : null;
  if (!raw)
    return { language: null, languageRaw: null, languageSource: "none" };
  const token = raw.split(/[\s,:{]/)[0].toLowerCase();
  if (!token || LOOKS_LIKE_PATH.test(token))
    return { language: null, languageRaw: raw, languageSource: "none" };
  return {
    language: LANGUAGE_ALIASES.get(token) ?? token,
    languageRaw: raw,
    languageSource: "fence",
  };
}

/** CRLF, trailing spaces and trailing blank lines are not content. */
export function normalizeSnippetBody(body) {
  const lines = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Identity of a block, so the same code quoted twice is one artifact. */
export function snippetDigest(language, body) {
  return createHash("sha256")
    .update(`${language ?? ""}\n${normalizeSnippetBody(body)}`)
    .digest("hex");
}

function pathIn(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const match = PATH_TOKEN.exec(text) ?? DOTFILE_TOKEN.exec(text);
  return match ? match[1] : null;
}

/**
 * The path a fence points at, if it names one: in the info string
 * (```js src/app.js), in the line above it (**src/app.js**), or in a leading
 * line comment (// src/app.js). Returns null when nothing names a file.
 */
export function fileHintFor({
  info = null,
  precedingLine = null,
  firstBodyLine = null,
} = {}) {
  const fromInfo = pathIn(info);
  if (fromInfo) return fromInfo;
  const fromPreceding = pathIn(precedingLine);
  if (fromPreceding) return fromPreceding;
  if (typeof firstBodyLine === "string" && COMMENT_PREFIX.test(firstBodyLine))
    return pathIn(firstBodyLine.replace(COMMENT_PREFIX, ""));
  return null;
}

/**
 * Walks lines rather than matching one regex, so a four-backtick fence that
 * wraps a three-backtick fence stays a single block. Returns every candidate;
 * filtering, and the reason for each drop, belongs to selectSnippets.
 */
export function extractSnippets(text, { origin = {} } = {}) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!source.includes("```") && !source.includes("~~~")) return [];
  const lines = source.split("\n");
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const snippets = [];
  let scanFrom = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const marker = open[1][0];
    const width = open[1].length;
    const info = open[2].trim();
    // CommonMark: a backtick info string may not itself contain a backtick.
    if (marker === "`" && info.includes("`")) continue;
    const body = [];
    let closed = false;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      const close = FENCE_CLOSE.exec(lines[j]);
      if (close && close[1][0] === marker && close[1].length >= width) {
        closed = true;
        end = j;
        break;
      }
      body.push(lines[j]);
    }
    let preceding = null;
    for (let k = i - 1; k >= scanFrom && preceding === null; k--)
      if (lines[k].trim()) preceding = lines[k];
    const { language, languageRaw, languageSource } = normalizeLanguage(info);
    const content = body.join("\n");
    const normalized = normalizeSnippetBody(content);
    snippets.push({
      index: snippets.length,
      language,
      languageRaw,
      languageSource,
      body: content,
      digest: snippetDigest(language, content),
      lines: normalized ? normalized.split("\n").length : 0,
      chars: normalized.length,
      bytes: Buffer.byteLength(content),
      fileHint: fileHintFor({
        info,
        precedingLine: preceding,
        firstBodyLine: body[0] ?? null,
      }),
      hintWindow: source.slice(Math.max(0, starts[i] - HINT_WINDOW), starts[i]),
      closed,
      origin: { ...origin },
    });
    i = end;
    scanFrom = end + 1;
  }
  return snippets;
}

const baseName = (path) =>
  String(path ?? "")
    .split(/[\\/]/)
    .pop() ?? "";

/**
 * A block that names a file is already covered by the run's diff; only the
 * ones with no target become snippet artifacts.
 */
export function hasFileTarget(snippet, { touchedFiles = new Set() } = {}) {
  if (snippet?.fileHint)
    return { targeted: true, reason: `names ${snippet.fileHint}` };
  if (snippet?.language && FILE_TARGET_LANGUAGES.has(snippet.language))
    return {
      targeted: true,
      reason: `a ${snippet.language} block names its own files`,
    };
  const window = String(snippet?.hintWindow ?? "");
  for (const file of touchedFiles) {
    const base = baseName(file);
    if (base.length < 3) continue;
    if (window.includes(base))
      return {
        targeted: true,
        reason: `introduced as ${base}, a file this run touched`,
      };
  }
  return { targeted: false, reason: "no file target" };
}

/**
 * Applies the filters in order and records a reason for every drop, so a run
 * can always account for the fences it saw but did not materialize.
 */
export function selectSnippets(
  collected,
  {
    touchedFiles = new Set(),
    existingDigests = new Set(),
    limit = SNIPPET_LIMIT,
  } = {},
) {
  const kept = [];
  const skipped = [];
  const seen = new Set(existingDigests);
  for (const snippet of collected ?? []) {
    const drop = (reason, detail = null) =>
      skipped.push({
        digest: snippet.digest,
        language: snippet.language ?? null,
        lines: snippet.lines,
        reason,
        detail,
      });
    if (!snippet.closed) {
      drop("unterminated", "the fence was never closed in the message text");
      continue;
    }
    if (
      snippet.lines < SNIPPET_MIN_LINES ||
      snippet.chars < SNIPPET_MIN_CHARS
    ) {
      drop(
        "too-short",
        `${snippet.lines} line(s) and ${snippet.chars} chars; the minimum is ${SNIPPET_MIN_LINES} lines and ${SNIPPET_MIN_CHARS} chars`,
      );
      continue;
    }
    if (snippet.language && NON_CODE_LANGUAGES.has(snippet.language)) {
      drop("non-code-language", `the fence is labelled ${snippet.language}`);
      continue;
    }
    // Checked before the file-target rule, which would otherwise absorb it.
    if (snippet.fileHint && isSecretPath(snippet.fileHint)) {
      drop("secret", `the block names ${snippet.fileHint}`);
      continue;
    }
    const target = hasFileTarget(snippet, { touchedFiles });
    if (target.targeted) {
      drop("targeted", target.reason);
      continue;
    }
    if (seen.has(snippet.digest)) {
      drop("duplicate", "the same code was already captured for this run");
      continue;
    }
    if (kept.length >= limit) {
      drop("over-limit", `only the first ${limit} snippets are materialized`);
      continue;
    }
    seen.add(snippet.digest);
    const oversize = snippet.body.length > SNIPPET_MAX_CHARS;
    kept.push(
      oversize
        ? {
            ...snippet,
            body: `${snippet.body.slice(0, SNIPPET_MAX_CHARS)}\n\n[truncated: snippet exceeded ${Math.round(
              SNIPPET_MAX_CHARS / 1024,
            )} KB]\n`,
            truncated: true,
          }
        : { ...snippet, truncated: false },
    );
  }
  return { kept, skipped, omitted: skipped.length };
}

/** One line naming how many fences were skipped and why. */
export function summarizeSkips(skipped) {
  const counts = new Map();
  for (const entry of skipped ?? [])
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
}
