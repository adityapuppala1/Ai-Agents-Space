#!/usr/bin/env node
/**
 * Fake Claude Code CLI for tests. Replays tests/fixtures/providers/
 * claude-headless-stream.jsonl line by line (10 ms apart) with a fresh
 * session id (or the one given to --resume). Prompt keywords:
 *   WRITE_FILE → writes fake-output.txt into cwd and emits an Edit tool_use
 *   HANG       → sleeps 60 s before the result (for cancel tests)
 *   FAIL       → emits an error result and exits 1
 *   SNIPPET    → emits one message holding three fenced blocks: an untargeted
 *                python one, a js one that names src/app.js, and a text one
 * Accepts -C/--cwd <dir> and --version. Never touches real provider homes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.258 (Claude Code) [fake]");
  process.exit(0);
}
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const prompt = opt("-p") ?? "";
const resume = opt("--resume");
const cwd = opt("-C") ?? opt("--cwd") ?? process.cwd();
const sessionId = resume ?? randomUUID();
const fixture = fileURLToPath(
  new URL("../providers/claude-headless-stream.jsonl", import.meta.url),
);
const lines = readFileSync(fixture, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

const rewrite = (record) => {
  const copy = { ...record, session_id: sessionId };
  if (copy.type === "system" && copy.subtype === "init") copy.cwd = cwd;
  if (copy.uuid) copy.uuid = randomUUID();
  return copy;
};

const wantsWrite = /WRITE_FILE/.test(prompt);
const wantsHang = /HANG/.test(prompt);
const wantsFail = /FAIL/.test(prompt);
const wantsSnippet = /SNIPPET/.test(prompt);

const fence = "```";
const snippetMessage = [
  "Here is the sorting helper you asked about:",
  "",
  `${fence}python`,
  "def sort_pairs(pairs):",
  "    return sorted(pairs, key=lambda pair: (pair[1], pair[0]))",
  fence,
  "",
  "And the same idea for the entry point:",
  "",
  `${fence}js src/app.js`,
  "export const boot = () => start();",
  'console.log("ready");',
  fence,
  "",
  `${fence}text`,
  "build finished in 4.2 seconds",
  "0 errors, 0 warnings reported",
  fence,
].join("\n");

(async () => {
  for (const record of lines) {
    if (record.type === "result") break;
    emit(rewrite(record));
    await sleep(10);
  }
  if (wantsWrite) {
    const file = join(cwd, "fake-output.txt");
    writeFileSync(file, `written by fake claude for session ${sessionId}\n`);
    const toolId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    emit({
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: `msg_fake_${randomUUID().slice(0, 8)}`,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: "Write",
            input: { file_path: file, content: "written by fake claude" },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(10);
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: toolId, type: "tool_result", content: "File written" },
        ],
      },
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(10);
    emit({
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: `msg_fake_${randomUUID().slice(0, 8)}`,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `${toolId}_test`,
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(10);
    emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: `${toolId}_test`,
            type: "tool_result",
            content: "1 passing",
          },
        ],
      },
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(10);
  }
  if (wantsSnippet) {
    emit({
      type: "assistant",
      message: {
        model: "claude-haiku-4-5-20251001",
        id: `msg_fake_${randomUUID().slice(0, 8)}`,
        role: "assistant",
        content: [{ type: "text", text: snippetMessage }],
        usage: { input_tokens: 4, output_tokens: 9 },
      },
      session_id: sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(10);
  }
  if (wantsHang) await sleep(60000);
  const result = rewrite(lines.find((record) => record.type === "result"));
  if (resume) result.result = `Resumed ${sessionId}: OK`;
  if (wantsFail) {
    result.subtype = "error_during_execution";
    result.is_error = true;
    result.result = "Fake failure requested by prompt";
    emit(result);
    process.exit(1);
  }
  emit(result);
  process.exit(0);
})();
