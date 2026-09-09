#!/usr/bin/env node
/**
 * Fake GitHub Copilot CLI for tests. Replays tests/fixtures/providers/
 * copilot-headless-stream.jsonl with a fresh session id (or --resume id).
 * Prompt keywords: WRITE_FILE (writes fake-output.txt, reports it in
 * result.usage.codeChanges.filesModified), HANG (60 s), FAIL (exitCode 1).
 * Accepts -C/--cwd <dir>, --allow-tool (repeated or "a,b"), --allow-all-tools,
 * --add-dir, --model, --version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.0.80 [fake]");
  process.exit(0);
}
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const allowed = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--allow-tool")
    allowed.push(...String(args[i + 1] ?? "").split(","));
  else if (args[i].startsWith("--allow-tool="))
    allowed.push(...args[i].slice(13).split(","));
}
const prompt = opt("-p") ?? "";
const resume = opt("--resume");
const cwd = opt("-C") ?? opt("--cwd") ?? process.cwd();
const sessionId = resume ?? randomUUID();
const fixture = fileURLToPath(
  new URL("../providers/copilot-headless-stream.jsonl", import.meta.url),
);
const lines = readFileSync(fixture, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

(async () => {
  emit({
    type: "session.start",
    data: { sessionId, copilotVersion: "1.0.80", context: { cwd } },
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  });
  const filesModified = [];
  for (const record of lines) {
    if (record.type === "result") break;
    const copy = { ...record, id: randomUUID() };
    if (copy.type === "user.message")
      copy.data = { ...copy.data, content: prompt || copy.data.content };
    emit(copy);
    await sleep(5);
  }
  if (/WRITE_FILE/.test(prompt)) {
    const file = join(cwd, "fake-output.txt");
    writeFileSync(file, `written by fake copilot session ${sessionId}\n`);
    filesModified.push(file);
    const toolCallId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    emit({
      type: "tool.execution_start",
      data: {
        toolCallId,
        toolName: "create",
        arguments: { path: file, content: "x" },
        turnId: "2",
      },
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    await sleep(5);
    emit({
      type: "tool.execution_complete",
      data: { toolCallId, success: true, result: { content: "File created" } },
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }
  if (/HANG/.test(prompt)) await sleep(60000);
  const fail = /FAIL/.test(prompt);
  emit({
    type: "result",
    timestamp: new Date().toISOString(),
    sessionId,
    exitCode: fail ? 1 : 0,
    usage: {
      premiumRequests: 0.33,
      totalApiDurationMs: 5707,
      sessionDurationMs: 10013,
      codeChanges: {
        linesAdded: filesModified.length,
        linesRemoved: 0,
        filesModified,
      },
    },
  });
  process.exit(fail ? 1 : 0);
})();
