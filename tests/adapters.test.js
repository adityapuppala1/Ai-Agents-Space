import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeCodeAdapter } from "../packages/core/src/adapters/claudeCode.js";
import { codexAdapter } from "../packages/core/src/adapters/codex.js";
import {
  codexAppServerAdapter,
  APPROVAL_METHODS,
} from "../packages/core/src/adapters/codexAppServer.js";
import { copilotAdapter } from "../packages/core/src/adapters/copilot.js";
import { geminiAdapter } from "../packages/core/src/adapters/gemini.js";
import { cursorAdapter } from "../packages/core/src/adapters/cursor.js";
import {
  defaultAdapters,
  adapterFor,
  adapterCapabilities,
} from "../packages/core/src/adapters/index.js";
import {
  spawnProvider,
  splitArgs,
  resolveBinary,
  createLineSplitter,
} from "../packages/core/src/runs/process.js";
import {
  captureTestOutput,
  finalMessage,
} from "../packages/core/src/runs/artifacts.js";

const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/providers/${name}`, import.meta.url)),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((line) => line.trim());

const fakeCli = (name) =>
  fileURLToPath(new URL(`./fixtures/fake-cli/${name}`, import.meta.url));

function parseAll(adapter, lines) {
  const state = {};
  const events = [];
  for (const line of lines) events.push(...adapter.parse(line, state));
  return { state, events };
}

const binary = { command: "fake", args: [] };

test("claude adapter parses the verified headless stream", () => {
  const { state, events } = parseAll(
    claudeCodeAdapter,
    fixture("claude-headless-stream.jsonl"),
  );
  assert.equal(state.sessionId, "ecbb24d3-7973-43e1-a678-2dcedcc5ba0e");
  assert.equal(state.model, "claude-haiku-4-5-20251001");
  const init = events.find((e) => e.kind === "session.start");
  assert.ok(init);
  assert.ok(init.data.tools.includes("Read"));
  const read = events.find((e) => e.kind === "tool.start" && e.tool === "Read");
  assert.ok(read, "tool.start Read");
  assert.match(read.file, /hello\.txt$/);
  assert.equal(read.provenance, "provider");
  assert.equal(read.activity, "RESEARCHING");
  assert.ok(
    events.some((e) => e.kind === "file.read" && /hello\.txt$/.test(e.file)),
  );
  assert.ok(events.some((e) => e.kind === "tool.end"));
  const usage = events.find((e) => e.kind === "usage" && e.usage);
  assert.ok(usage);
  assert.equal(usage.usage.reportedBy, "provider");
  assert.ok(events.some((e) => e.kind === "message" && e.summary === "OK"));
  assert.ok(
    events.some((e) => e.kind === "status" && /rate limit/i.test(e.summary)),
  );
  // Thinking-token estimates are never recorded as usage.
  assert.ok(!events.some((e) => e.kind === "usage" && e.data?.estimated));
  assert.ok(
    events.every(
      (e) =>
        e.providerEventId === null || typeof e.providerEventId === "string",
    ),
  );
  const final = claudeCodeAdapter.finalize(state, 0);
  assert.equal(final.status, "completed");
  assert.equal(final.sessionId, state.sessionId);
  assert.equal(final.cost.usd, 0.0273145);
  assert.equal(final.cost.reportedBy, "provider");
  assert.equal(final.usage.output_tokens, 379);
  assert.equal(final.model, "claude-haiku-4-5-20251001");
  assert.equal(final.finalText, "OK");
  // Error results and premature exits are failures.
  assert.equal(claudeCodeAdapter.finalize({}, 1).status, "failed");
  assert.equal(
    claudeCodeAdapter.finalize(
      {
        result: { subtype: "error_max_turns", is_error: true, result: "boom" },
      },
      0,
    ).status,
    "failed",
  );
  // Permission denials are surfaced as status events.
  const denied = claudeCodeAdapter.parse(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "s",
      uuid: "u",
      permission_denials: [{ tool_name: "Bash" }],
      usage: {},
    }),
    {},
  );
  assert.ok(
    denied.some((e) => e.kind === "status" && e.data.denied.length === 1),
  );
});

test("claude adapter builds the documented command line per policy", () => {
  const propose = claudeCodeAdapter.build({
    prompt: "explain",
    binary,
    cwd: "C:\\work",
    policy: { autonomy: "propose" },
    model: "sonnet",
    extraDirs: ["C:\\other"],
    hooksInstalled: true,
  });
  const text = propose.args.join(" ");
  assert.match(text, /^-p explain --output-format stream-json --verbose/);
  assert.match(text, /--permission-mode plan/);
  assert.match(text, /--allowedTools Read Glob Grep --add-dir/);
  assert.doesNotMatch(text, /WebFetch|WebSearch/, "propose has network:false");
  const proposeNetwork = claudeCodeAdapter.build({
    prompt: "explain",
    binary,
    cwd: "C:\\work",
    policy: { autonomy: "propose", allowedNetwork: true },
  });
  assert.match(
    proposeNetwork.args.join(" "),
    /--allowedTools Read Glob Grep WebFetch WebSearch/,
  );
  assert.match(text, /--model sonnet/);
  assert.match(text, /--add-dir C:\\other/);
  assert.match(text, /--include-hook-events/);
  assert.doesNotMatch(text, /--bare/);
  const sandbox = claudeCodeAdapter.build({
    prompt: "do",
    binary,
    cwd: "C:\\work",
    policy: { autonomy: "sandbox" },
    resumeSessionId: "abc",
  });
  const sandboxText = sandbox.args.join(" ");
  assert.match(sandboxText, /--permission-mode acceptEdits/);
  assert.match(
    sandboxText,
    /--allowedTools Read Edit Write MultiEdit Glob Grep Bash/,
  );
  assert.match(sandboxText, /--resume abc/);
  assert.doesNotMatch(sandboxText, /--include-hook-events/);
  assert.equal(sandbox.stdin, "ignore");
});

test("copilot adapter parses the verified headless stream", () => {
  const { state, events } = parseAll(
    copilotAdapter,
    fixture("copilot-headless-stream.jsonl"),
  );
  assert.equal(state.sessionId, "9869997d-2b31-4869-ac28-363005a10279");
  assert.equal(state.model, "claude-haiku-4.5");
  const view = events.find((e) => e.kind === "tool.start" && e.tool === "view");
  assert.ok(view, "tool.start view");
  assert.match(view.file, /hello\.txt$/);
  assert.ok(events.some((e) => e.kind === "file.read"));
  assert.ok(events.some((e) => e.kind === "tool.end" && e.tool === "view"));
  assert.ok(events.some((e) => e.kind === "message" && e.summary === "OK"));
  assert.ok(events.some((e) => e.kind === "prompt" && e.provenance === "user"));
  assert.ok(events.some((e) => e.kind === "usage"));
  assert.ok(
    events.some((e) => e.kind === "turn.start") &&
      events.some((e) => e.kind === "turn.end"),
  );
  // Ephemeral deltas are ignored.
  assert.ok(
    !events.some((e) => /reasoning_delta|tool_call_delta/.test(e.summary)),
  );
  const final = copilotAdapter.finalize(state, 0);
  assert.equal(final.status, "completed");
  assert.equal(final.usage.premiumRequests, 0.33);
  assert.equal(final.sessionId, "9869997d-2b31-4869-ac28-363005a10279");
  const withFiles = copilotAdapter.parse(
    JSON.stringify({
      type: "result",
      sessionId: "x",
      exitCode: 0,
      usage: { codeChanges: { filesModified: ["C:\\w\\a.js"] } },
    }),
    {},
  );
  const edit = withFiles.find((e) => e.kind === "file.edit");
  assert.equal(edit.file, "C:\\w\\a.js");
  assert.equal(edit.provenance, "provider");
  assert.equal(
    copilotAdapter.finalize({ result: { exitCode: 1 } }, 0).status,
    "failed",
  );
});

test("copilot adapter builds repeated --allow-tool flags for propose and --allow-all-tools otherwise", () => {
  const propose = copilotAdapter.build({
    prompt: "p",
    binary,
    cwd: "C:\\w",
    policy: { autonomy: "propose" },
  });
  const flags = propose.args.filter((a) => a === "--allow-tool").length;
  assert.equal(flags, 3);
  assert.match(
    propose.args.join(" "),
    /--allow-tool view --allow-tool grep --allow-tool glob/,
  );
  assert.doesNotMatch(propose.args.join(" "), /--allow-all-tools/);
  const scoped = copilotAdapter.build({
    prompt: "p",
    binary,
    cwd: "C:\\w",
    policy: { autonomy: "scoped" },
    model: "gpt-5",
    resumeSessionId: "s1",
    extraDirs: ["D:\\x"],
  });
  const text = scoped.args.join(" ");
  assert.match(text, /--allow-all-tools/);
  assert.match(text, /--model gpt-5/);
  assert.match(text, /--resume s1/);
  assert.match(text, /--add-dir D:\\x/);
  assert.match(text, /--output-format json/);
});

test("codex exec adapter parses a synthesized stream and the rate-limit error fixture", () => {
  const stream = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i0", type: "reasoning" } },
    {
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Working" },
    },
    {
      type: "item.started",
      item: { id: "i2", type: "command_execution", command: "npm test" },
    },
    {
      type: "item.completed",
      item: {
        id: "i2",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "1 passing",
        exit_code: 0,
      },
    },
    {
      type: "item.completed",
      item: {
        id: "i3",
        type: "file_change",
        changes: [
          { path: "src/a.js", kind: "update" },
          { path: "src/b.js", kind: "add" },
        ],
      },
    },
    {
      type: "item.completed",
      item: { id: "i4", type: "todo_list", items: [{ text: "x" }] },
    },
    {
      type: "item.completed",
      item: { id: "i5", type: "error", message: "minor" },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
    },
  ].map((r) => JSON.stringify(r));
  const { state, events } = parseAll(codexAdapter, [
    "not json noise",
    ...stream,
  ]);
  assert.equal(state.sessionId, "thread-1");
  assert.ok(events.some((e) => e.kind === "session.start"));
  assert.ok(events.some((e) => e.kind === "reasoning"));
  assert.ok(
    !events.some((e) => e.kind === "reasoning" && e.data.text),
    "reasoning content skipped",
  );
  assert.ok(
    events.some((e) => e.kind === "message" && e.summary === "Working"),
  );
  const tests = events.filter((e) => e.kind === "test");
  assert.ok(tests.length >= 1);
  const done = tests.find((e) => e.data.exitCode === 0);
  assert.equal(done.data.output, "1 passing");
  const edits = events.filter((e) => e.kind === "file.edit");
  assert.deepEqual(
    edits.map((e) => e.file),
    ["src/a.js", "src/b.js"],
  );
  assert.ok(events.some((e) => e.kind === "status" && /Plan/.test(e.summary)));
  assert.ok(events.some((e) => e.kind === "error" && e.summary === "minor"));
  const usage = events.find((e) => e.kind === "usage");
  assert.equal(usage.usage.input_tokens, 10);
  const final = codexAdapter.finalize(state, 0);
  assert.equal(final.status, "completed");
  assert.equal(final.usage.output_tokens, 5);
  assert.equal(
    captureTestOutput(events.map((e) => ({ ...e, message: e.summary })))
      .length >= 1,
    true,
  );

  const failed = parseAll(
    codexAdapter,
    fixture("codex-exec-stream-error.jsonl"),
  );
  assert.equal(failed.state.sessionId, "01a086a8-7217-73e0-95ae-82993dd5bdf9");
  assert.ok(
    failed.events.some(
      (e) => e.kind === "error" && /usage limit/.test(e.summary),
    ),
  );
  const failedFinal = codexAdapter.finalize(failed.state, 1);
  assert.equal(failedFinal.status, "failed");
  assert.match(failedFinal.error, /usage limit/);
});

test("codex exec adapter builds the documented command with sandbox per policy and resume", () => {
  const propose = codexAdapter.build({
    prompt: "p",
    binary,
    cwd: "C:\\w",
    policy: { autonomy: "propose" },
  });
  assert.deepEqual(propose.args.slice(0, 1), ["exec"]);
  assert.match(
    propose.args.join(" "),
    /--json --skip-git-repo-check -C C:\\w -s read-only p$/,
  );
  const sandbox = codexAdapter.build({
    prompt: "p",
    binary,
    cwd: "C:\\w",
    policy: { autonomy: "sandbox" },
    model: "o3",
    resumeSessionId: "t1",
  });
  assert.deepEqual(sandbox.args.slice(0, 3), ["exec", "resume", "t1"]);
  assert.match(sandbox.args.join(" "), /-s workspace-write/);
  assert.match(sandbox.args.join(" "), /-m o3/);
  assert.equal(sandbox.stdin, "ignore");
});

test("codex approval method table covers v2 and legacy names with schema enums", () => {
  assert.deepEqual(
    APPROVAL_METHODS["item/commandExecution/requestApproval"].approve,
    { decision: "accept" },
  );
  assert.deepEqual(
    APPROVAL_METHODS["item/commandExecution/requestApproval"].deny,
    { decision: "decline" },
  );
  assert.deepEqual(
    APPROVAL_METHODS["item/fileChange/requestApproval"].approve,
    { decision: "accept" },
  );
  assert.deepEqual(APPROVAL_METHODS.execCommandApproval.approve, {
    decision: "approved",
  });
  assert.deepEqual(APPROVAL_METHODS.execCommandApproval.deny, {
    decision: "denied",
  });
  assert.deepEqual(APPROVAL_METHODS.applyPatchApproval.deny, {
    decision: "denied",
  });
  assert.deepEqual(
    APPROVAL_METHODS["item/permissions/requestApproval"].deny(),
    { permissions: {} },
  );
  assert.equal(
    APPROVAL_METHODS["item/permissions/requestApproval"].approve({
      permissions: { network: { enabled: true } },
    }).permissions.network.enabled,
    true,
  );
});

async function runAppServer({ approvals, prompt = "run tests", extra = {} }) {
  const state = { sessionId: null };
  const events = [];
  const services = { ...(approvals ? { approvals } : {}), ...extra };
  const launch = codexAppServerAdapter.build({
    prompt,
    binary: { command: process.execPath, args: [fakeCli("codex.js")] },
    cwd: process.cwd(),
    policy: { autonomy: "sandbox" },
  });
  assert.equal(launch.stdin, "pipe");
  assert.equal(launch.args.at(-1), "app-server");
  let child;
  const exit = new Promise((resolve) => {
    child = spawnProvider({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      stdin: launch.stdin,
      onLine: (line) => {
        for (const event of codexAppServerAdapter.parse(line, state))
          events.push(event);
        if (state.finished) child.stdin.end();
      },
      onExit: (code) => resolve(code),
    });
  });
  codexAppServerAdapter.attach(child, state, {
    run: { id: "run-1", workspaceId: "ws", taskId: "task" },
    services,
    launch,
    emit: (event) => events.push(event),
    fail: (message) => events.push({ kind: "error", summary: message }),
  });
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await exit;
  clearTimeout(timer);
  return { state, events, code };
}

test("codex app-server adapter drives JSON-RPC and routes approvals to services.approvals", async () => {
  const requests = [];
  const approvals = {
    request(input) {
      requests.push(input);
      return { id: "appr-1", status: "pending", ...input };
    },
    async wait(id) {
      assert.equal(id, "appr-1");
      return { id, status: "approved", decision: "approve" };
    },
  };
  const { state, events, code } = await runAppServer({ approvals });
  assert.equal(code, 0);
  assert.ok(state.sessionId, "thread id captured");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, "command");
  assert.equal(requests[0].payload.command, "npm test");
  assert.equal(requests[0].provider, "codex");
  assert.equal(requests[0].providerRef, "cmd_1");
  assert.equal(requests[0].runId, "run-1");
  const decision = events.find((e) => e.kind === "approval.decision");
  assert.ok(decision);
  assert.equal(decision.data.approved, true);
  assert.equal(decision.provenance, "user");
  assert.ok(events.some((e) => e.kind === "session.start"));
  assert.ok(events.some((e) => e.kind === "turn.start"));
  const test = events.find((e) => e.kind === "test" && e.data.exitCode === 0);
  assert.ok(test, "command completed after approval");
  assert.ok(
    events.some((e) => e.kind === "message" && e.summary === "Tests passed"),
  );
  assert.ok(events.some((e) => e.kind === "turn.end"));
  const final = codexAppServerAdapter.finalize(state, code);
  assert.equal(final.status, "completed");
  assert.equal(final.usage.input_tokens, 200);
  assert.equal(final.model, "gpt-5-codex");
});

test("codex app-server adapter denies approvals when no approval service exists", async () => {
  const { events, code, state } = await runAppServer({ approvals: null });
  assert.equal(code, 0);
  const decision = events.find((e) => e.kind === "approval.decision");
  assert.ok(decision);
  assert.equal(decision.data.approved, false);
  assert.equal(decision.provenance, "system");
  assert.match(decision.summary, /Approval service unavailable/);
  assert.ok(
    events.some(
      (e) => e.kind === "message" && e.summary === "Command was declined",
    ),
  );
  assert.equal(codexAppServerAdapter.finalize(state, code).status, "completed");
});

test("codex app-server requests go through the workspace policy first", async () => {
  // A command the policy denies is refused without asking anyone, audited.
  const asked = [];
  const audit = [];
  const deny = await runAppServer({
    approvals: {
      request(input) {
        asked.push(input);
        return { id: "appr-x", status: "pending" };
      },
      async wait() {
        return { status: "approved", decision: "approve" };
      },
    },
    extra: {
      policy: {
        evaluate: ({ request }) => ({
          decision: "deny",
          rule: "command.denied",
          reason: `Command matches the denied list entry “${request.command}”.`,
        }),
      },
      audit: { record: (entry) => audit.push(entry) },
    },
  });
  assert.equal(asked.length, 0, "a denied request never reaches a person");
  const denied = deny.events.find((e) => e.kind === "approval.decision");
  assert.equal(denied.data.approved, false);
  assert.equal(denied.data.rule, "command.denied");
  assert.equal(denied.provenance, "system");
  assert.match(denied.summary, /Denied by policy/);
  assert.ok(
    deny.events.some(
      (e) => e.kind === "message" && e.summary === "Command was declined",
    ),
  );
  assert.equal(audit.at(-1).action, "codex.deny");
  assert.equal(audit.at(-1).details.rule, "command.denied");

  // A request that goes to a person carries the rule (so rule-based dual
  // approval applies) and the policy's reason.
  const requests = [];
  await runAppServer({
    approvals: {
      request(input) {
        requests.push(input);
        return { id: "appr-2", status: "pending", ...input };
      },
      async wait(id) {
        return { id, status: "approved", decision: "approve" };
      },
    },
    extra: {
      policy: {
        evaluate: () => ({
          decision: "ask",
          rule: "command.risky",
          reason: "Risky command needs a human decision.",
        }),
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].rule, "command.risky");
  assert.match(requests[0].reason, /Risky command needs a human decision/);
});

test("codex app-server adapter reports failed turns and interrupts", async () => {
  const failed = await runAppServer({ approvals: null, prompt: "FAIL" });
  const final = codexAppServerAdapter.finalize(failed.state, failed.code);
  assert.equal(final.status, "failed");
  assert.match(final.error, /Fake failure/);
  assert.equal(
    codexAppServerAdapter.finalize({ turnStatus: "interrupted" }, 0).status,
    "cancelled",
  );
  assert.equal(codexAppServerAdapter.finalize({}, 0).status, "failed");
});

test("gemini and cursor adapters build documented commands and parse tolerantly", () => {
  const gemini = geminiAdapter.build({
    prompt: "hi",
    binary,
    cwd: "C:\\w",
    policy: { autonomy: "propose" },
  });
  // Flags verified from `gemini --help` 0.59.0 on this machine: -p, -o, and
  // --approval-mode (propose -> plan). A fresh run gets a --session-id it can
  // be resumed with, so the uuid is checked by shape, not by value.
  assert.deepEqual(gemini.args.slice(0, 6), [
    "-p",
    "hi",
    "-o",
    "stream-json",
    "--approval-mode",
    "plan",
  ]);
  assert.equal(gemini.args[6], "--session-id");
  assert.match(gemini.args[7], /^[0-9a-f-]{36}$/);
  assert.ok(
    !gemini.args.includes("--skip-trust") && !gemini.args.includes("-y"),
  );
  // cursor-agent is not installed anywhere we can verify, so the adapter
  // refuses to build a command instead of pretending it can launch one.
  assert.throws(
    () =>
      cursorAdapter.build({
        prompt: "hi",
        binary,
        cwd: "C:\w",
        policy: { autonomy: "propose" },
      }),
    /cursor-agent is not installed/,
  );
  assert.equal(geminiAdapter.capabilities.launch, "experimental");
  assert.equal(cursorAdapter.capabilities.launch, "unsupported");
  assert.equal(geminiAdapter.supportsResume, false);
  const lines = [
    { type: "init", session_id: "g1", model: "gemini-2.5-pro" },
    {
      type: "tool_use",
      tool_name: "write_file",
      input: { file_path: "C:\\w\\a.txt" },
      id: "t1",
    },
    { type: "tool_result", content: "ok", id: "t2" },
    { role: "assistant", content: "All done" },
    {
      type: "result",
      status: "success",
      usage: { input_tokens: 4, output_tokens: 1 },
      id: "r1",
    },
    { type: "weird_thing" },
  ].map((r) => JSON.stringify(r));
  const { state, events } = parseAll(geminiAdapter, ["garbage", ...lines]);
  assert.equal(state.sessionId, "g1");
  assert.equal(state.model, "gemini-2.5-pro");
  assert.ok(events.some((e) => e.kind === "session.start"));
  assert.ok(
    events.some((e) => e.kind === "file.edit" && e.file === "C:\\w\\a.txt"),
  );
  assert.ok(events.some((e) => e.kind === "tool.end"));
  assert.ok(
    events.some((e) => e.kind === "message" && e.summary === "All done"),
  );
  assert.ok(
    events.some((e) => e.kind === "usage" && e.usage.input_tokens === 4),
  );
  assert.ok(
    events.some((e) => e.kind === "status" && /weird_thing/.test(e.summary)),
  );
  assert.equal(geminiAdapter.finalize(state, 0).status, "completed");
  assert.equal(
    finalMessage(events.map((e) => ({ ...e, message: e.summary }))),
    "All done",
  );
  const errored = parseAll(cursorAdapter, [
    JSON.stringify({ type: "error", message: "nope" }),
  ]);
  assert.equal(cursorAdapter.finalize(errored.state, 0).status, "failed");
});

test("adapter registry selects codex app-server only when the setting is on", () => {
  assert.equal(adapterFor("codex").id, "codex");
  assert.equal(
    adapterFor("codex", { settings: { get: () => true } }).id,
    "codex-app-server",
  );
  assert.equal(
    adapterFor("claude-code", { settings: { get: () => true } }).id,
    "claude-code",
  );
  assert.equal(adapterFor("nope"), null);
  const caps = adapterCapabilities();
  assert.equal(caps["claude-code"].launch, "verified");
  assert.equal(caps.codex.launch, "verified");
  assert.equal(caps.gemini.launch, "experimental");
  assert.equal(Object.keys(defaultAdapters).length, 6);
});

test("process helpers: splitArgs, resolveBinary overrides, line splitter", () => {
  assert.deepEqual(splitArgs("node \"C:\\Program Files\\x.js\" --flag 'a b'"), [
    "node",
    "C:\\Program Files\\x.js",
    "--flag",
    "a b",
  ]);
  const resolved = resolveBinary("claude-code", {
    AGENT_SPACE_BIN_CLAUDE_CODE: 'node "C:\\tools\\claude.js"',
  });
  assert.deepEqual(resolved, {
    command: "node",
    args: ["C:\\tools\\claude.js"],
    resolved: true,
    source: "env",
  });
  const missing = resolveBinary(
    "cursor",
    { PATH: "" },
    { which: () => null, noCache: true },
  );
  assert.equal(missing.resolved, false);
  const found = resolveBinary(
    "gemini",
    { PATH: "x" },
    {
      which: (name) => (name === "gemini" ? "C:\\bin\\gemini.cmd" : null),
      noCache: true,
    },
  );
  assert.equal(found.command, "C:\\bin\\gemini.cmd");
  const lines = [];
  const push = createLineSplitter((line) => lines.push(line));
  push('{"a":1}\r\n{"b":');
  push("2}\n\n   \npartial");
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  push.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "partial"]);
});

test("claude adapter emits usage once per message id, not once per transcript line", () => {
  const state = {};
  const usage = {
    input_tokens: 18,
    output_tokens: 3,
    cache_read_input_tokens: 63555,
  };
  const lineFor = (uuid, block) =>
    JSON.stringify({
      type: "assistant",
      uuid,
      session_id: "s",
      message: { id: "msg_1", model: "m", content: [block], usage },
    });
  const events = [
    ...claudeCodeAdapter.parse(
      lineFor("u1", { type: "text", text: "hi" }),
      state,
    ),
    ...claudeCodeAdapter.parse(
      lineFor("u2", {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "a.js" },
      }),
      state,
    ),
  ];
  const usages = events.filter((e) => e.kind === "usage");
  assert.equal(usages.length, 1, "same message.id counted once");
  assert.equal(usages[0].providerEventId, "claude-code:msg_1:usage");
  assert.equal(usages[0].usage.input_tokens, 18);
  assert.equal(usages[0].usage.cache_read_input_tokens, 63555);
});
