#!/usr/bin/env node
/**
 * Fake Gemini CLI for tests. Prints a minimal stream-json style stream:
 * init, one tool call, one message, and a result. Prompt keywords:
 * WRITE_FILE (writes fake-output.txt), HANG (60 s), FAIL (error result).
 * Accepts -C/--cwd <dir>, --model, --output-format, --version.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.9.0 [fake gemini]");
  process.exit(0);
}
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const prompt = opt("-p") ?? "";
const cwd = opt("-C") ?? opt("--cwd") ?? process.cwd();
const sessionId = randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

(async () => {
  emit({
    type: "init",
    session_id: sessionId,
    model: opt("--model") ?? "gemini-2.5-pro",
  });
  await sleep(10);
  emit({
    type: "tool_use",
    session_id: sessionId,
    tool_name: "read_file",
    input: { file_path: join(cwd, "README.md") },
    id: randomUUID(),
  });
  await sleep(10);
  emit({
    type: "tool_result",
    session_id: sessionId,
    content: "ok",
    id: randomUUID(),
  });
  if (/WRITE_FILE/.test(prompt))
    writeFileSync(
      join(cwd, "fake-output.txt"),
      `written by fake gemini ${sessionId}\n`,
    );
  await sleep(10);
  emit({
    type: "message",
    role: "assistant",
    content: "OK",
    session_id: sessionId,
    id: randomUUID(),
  });
  if (/HANG/.test(prompt)) await sleep(60000);
  const fail = /FAIL/.test(prompt);
  emit({
    type: "result",
    session_id: sessionId,
    status: fail ? "error" : "success",
    usage: { input_tokens: 12, output_tokens: 3 },
    id: randomUUID(),
  });
  process.exit(fail ? 1 : 0);
})();
