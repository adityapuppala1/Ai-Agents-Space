#!/usr/bin/env node
/**
 * Fake Codex CLI for tests.
 *   codex --version                      → "codex-cli 0.152.1"
 *   codex exec [--json] [-C dir] ... "<prompt>"
 *   codex exec resume <thread_id> "<prompt>"
 *   codex app-server                     → JSON-RPC 2.0 over stdio (fake)
 * Prompt keywords: WRITE_FILE (writes fake-output.txt), HANG (waits 60 s or,
 * in app-server mode, until turn/interrupt), FAIL (turn.failed).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.152.1");
  process.exit(0);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

if (args[0] === "app-server") {
  runAppServer();
} else if (args[0] === "exec") {
  runExec();
} else {
  console.error(`fake codex: unknown command ${args[0] ?? ""}`);
  process.exit(2);
}

function execPrompt() {
  // Prompt is the last positional argument that is not an option value.
  const flagsWithValue = new Set([
    "-C",
    "--cwd",
    "-s",
    "-m",
    "-o",
    "--add-dir",
  ]);
  let prompt = "";
  for (let i = 1; i < args.length; i++) {
    if (flagsWithValue.has(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith("-")) continue;
    if (args[i] === "resume") {
      i++;
      continue;
    }
    prompt = args[i];
  }
  return prompt;
}

async function runExec() {
  const resumeIndex = args.indexOf("resume");
  const resumeId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  const cwd = opt("-C") ?? opt("--cwd") ?? process.cwd();
  const prompt = execPrompt();
  const threadId = resumeId ?? randomUUID();
  console.error("fake codex: warning noise on stderr");
  emit({ type: "thread.started", thread_id: threadId });
  await sleep(10);
  emit({ type: "turn.started" });
  await sleep(10);
  if (/FAIL/.test(prompt)) {
    emit({ type: "error", message: "Fake failure requested by prompt" });
    emit({
      type: "turn.failed",
      error: { message: "Fake failure requested by prompt" },
    });
    process.exit(1);
  }
  emit({ type: "item.started", item: { id: "item_0", type: "reasoning" } });
  await sleep(10);
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: resumeId ? `Resumed ${threadId}: working on it` : "Working on it",
    },
  });
  await sleep(10);
  emit({
    type: "item.started",
    item: {
      id: "item_2",
      type: "command_execution",
      command: "npm test",
      status: "in_progress",
    },
  });
  await sleep(10);
  emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "1 passing\n",
      exit_code: 0,
      status: "completed",
    },
  });
  await sleep(10);
  if (/WRITE_FILE/.test(prompt))
    writeFileSync(
      join(cwd, "fake-output.txt"),
      `written by fake codex thread ${threadId}\n`,
    );
  emit({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "file_change",
      status: "completed",
      changes: [{ path: join(cwd, "fake-output.txt"), kind: "add" }],
    },
  });
  await sleep(10);
  if (/HANG/.test(prompt)) await sleep(60000);
  emit({
    type: "item.completed",
    item: {
      id: "item_4",
      type: "agent_message",
      text: "Done: wrote fake-output.txt",
    },
  });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 35 },
  });
  process.exit(0);
}

function runAppServer() {
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const notify = (method, params) => send({ method, params });
  let nextRequestId = 1000;
  const pendingRequests = new Map();
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextRequestId++;
      pendingRequests.set(id, resolve);
      send({ id, method, params });
    });
  const threads = new Map();
  let interruptResolve = null;

  const rl = createInterface({ input: process.stdin });
  rl.on("close", () => process.exit(0));
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const resolve = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      resolve?.(message.result ?? message.error ?? null);
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        send({
          id: message.id,
          result: { serverInfo: { name: "fake-codex", version: "0.152.1" } },
        });
        break;
      case "thread/start": {
        const id = randomUUID();
        threads.set(id, {
          cwd: params.cwd ?? process.cwd(),
          sandbox: params.sandbox ?? null,
        });
        send({
          id: message.id,
          result: {
            thread: { id, cwd: params.cwd ?? process.cwd() },
            model: params.model ?? "gpt-5-codex",
            sandbox: params.sandbox ?? "workspace-write",
            approvalPolicy: params.approvalPolicy ?? "on-request",
          },
        });
        notify("thread/started", {
          thread: { id, cwd: params.cwd ?? process.cwd() },
        });
        break;
      }
      case "thread/resume": {
        const id = params.threadId ?? randomUUID();
        threads.set(id, { cwd: params.cwd ?? process.cwd(), resumed: true });
        send({ id: message.id, result: { thread: { id } } });
        break;
      }
      case "turn/start": {
        const threadId = params.threadId;
        const turnId = randomUUID();
        const text = (params.input ?? []).map((i) => i.text ?? "").join(" ");
        const thread = threads.get(threadId) ?? { cwd: process.cwd() };
        send({
          id: message.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        });
        notify("turn/started", {
          threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        await sleep(10);
        notify("item/completed", {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            id: "msg_1",
            type: "agentMessage",
            text: "Planning the change",
          },
        });
        await sleep(10);
        if (/HANG/.test(text)) {
          await new Promise((resolve) => {
            interruptResolve = resolve;
          });
          notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "interrupted" },
          });
          return;
        }
        notify("item/started", {
          threadId,
          turnId,
          item: {
            id: "cmd_1",
            type: "commandExecution",
            command: "npm test",
            cwd: thread.cwd,
            status: "inProgress",
          },
        });
        const decision = await request(
          "item/commandExecution/requestApproval",
          {
            threadId,
            turnId,
            itemId: "cmd_1",
            approvalId: null,
            command: "npm test",
            cwd: thread.cwd,
            reason: "Run the test suite",
            kind: "command",
          },
        );
        const accepted =
          decision?.decision === "accept" ||
          decision?.decision === "acceptForSession";
        notify("item/completed", {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            id: "cmd_1",
            type: "commandExecution",
            command: "npm test",
            cwd: thread.cwd,
            status: accepted ? "completed" : "declined",
            exitCode: accepted ? 0 : null,
            aggregatedOutput: accepted ? "1 passing\n" : "",
          },
        });
        if (/WRITE_FILE/.test(text)) {
          writeFileSync(
            join(thread.cwd, "fake-output.txt"),
            `written by fake codex app-server\n`,
          );
          notify("item/completed", {
            threadId,
            turnId,
            completedAtMs: Date.now(),
            item: {
              id: "fc_1",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: join(thread.cwd, "fake-output.txt"),
                  kind: "add",
                  diff: "+written",
                },
              ],
            },
          });
        }
        notify("thread/tokenUsage/updated", {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: 200,
              cachedInputTokens: 50,
              outputTokens: 60,
              reasoningOutputTokens: 0,
              totalTokens: 260,
            },
            last: {
              inputTokens: 200,
              cachedInputTokens: 50,
              outputTokens: 60,
              reasoningOutputTokens: 0,
              totalTokens: 260,
            },
          },
        });
        notify("item/completed", {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            id: "msg_2",
            type: "agentMessage",
            text: accepted ? "Tests passed" : "Command was declined",
          },
        });
        if (/FAIL/.test(text)) {
          notify("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              status: "failed",
              error: { message: "Fake failure requested by prompt" },
            },
          });
          return;
        }
        notify("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed" },
        });
        break;
      }
      case "turn/interrupt":
        send({ id: message.id, result: {} });
        interruptResolve?.();
        break;
      default:
        if (message.id !== undefined)
          send({
            id: message.id,
            error: {
              code: -32601,
              message: `unknown method ${message.method}`,
            },
          });
    }
  });
}
