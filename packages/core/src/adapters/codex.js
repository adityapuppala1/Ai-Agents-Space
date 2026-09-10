import {
  defineAdapter,
  permissionsFor,
  event,
  clip,
  smallData,
  usageFromTokens,
} from "./base.js";
import { isTestCommand } from "../runs/artifacts.js";

const PROVIDER = "codex";

export function sandboxFor(policy) {
  const perms = permissionsFor(policy);
  return perms.autonomy === "propose" ? "read-only" : "workspace-write";
}

/**
 * Converts one Codex exec item (`item.started` / `item.completed`) into
 * normalized events. Shared with the app-server adapter, whose item shapes
 * are camelCased variants of the same records.
 */
export function codexItemEvents(item, { phase, sessionId, timestamp }) {
  if (!item || typeof item !== "object") return [];
  const type = String(item.type ?? "");
  const id = item.id ?? null;
  const key = (suffix) =>
    id ? `${PROVIDER}:${sessionId ?? "?"}:${id}:${suffix}` : null;
  const base = { sessionId: sessionId ?? null, timestamp };
  const events = [];
  const completed = phase === "completed";

  switch (type) {
    case "command_execution":
    case "commandExecution": {
      const command = Array.isArray(item.command)
        ? item.command.join(" ")
        : String(item.command ?? "");
      const output = item.aggregated_output ?? item.aggregatedOutput ?? null;
      const exitCode = item.exit_code ?? item.exitCode ?? null;
      const test = isTestCommand(command);
      if (!completed) {
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key("start"),
            kind: "tool.start",
            tool: "command_execution",
            summary: `Running ${clip(command, 100)}`,
            data: smallData({ command, cwd: item.cwd ?? null }),
          }),
        );
      }
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key(completed ? "done" : "cmd"),
          kind: test ? "test" : "command",
          tool: "command_execution",
          summary: completed
            ? `${test ? "Tests" : "Command"} finished${
                exitCode !== null && exitCode !== undefined
                  ? ` (exit ${exitCode})`
                  : ""
              }: ${clip(command, 80)}`
            : `Running ${clip(command, 100)}`,
          data: smallData({
            command,
            output: output ? String(output).slice(0, 4000) : null,
            exitCode,
            status: item.status ?? null,
          }),
        }),
      );
      if (
        completed &&
        exitCode !== null &&
        exitCode !== undefined &&
        exitCode !== 0
      )
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key("exit"),
            kind: "status",
            summary: `Command exited with ${exitCode}: ${clip(command, 80)}`,
            data: { command, exitCode },
          }),
        );
      break;
    }
    case "file_change":
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      changes.forEach((change, index) => {
        const path = change?.path ?? null;
        if (!path) return;
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key(`${phase}:file:${index}`),
            kind: "file.edit",
            tool: "apply_patch",
            file: String(path),
            summary: `${clip(change.kind ?? "update", 20)} ${clip(path, 100)}`,
            data: {
              path,
              kind: change.kind ?? null,
              status: item.status ?? null,
            },
          }),
        );
      });
      if (!changes.length && completed)
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key("filechange"),
            kind: "status",
            summary: `File change ${item.status ?? "completed"}`,
            data: { status: item.status ?? null },
          }),
        );
      break;
    }
    case "agent_message":
    case "agentMessage": {
      if (!completed) break;
      const text = item.text ?? item.message ?? "";
      if (!String(text).trim()) break;
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key("message"),
          kind: "message",
          summary: clip(text, 120),
          data: { text: String(text).slice(0, 4000) },
        }),
      );
      break;
    }
    case "user_message":
    case "userMessage": {
      if (!completed) break;
      const content = Array.isArray(item.content)
        ? item.content.map((c) => c?.text ?? "").join(" ")
        : (item.text ?? item.message ?? "");
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key("prompt"),
          kind: "prompt",
          provenance: "user",
          summary: clip(content, 120),
          data: { text: String(content).slice(0, 4000) },
        }),
      );
      break;
    }
    case "reasoning":
      // Reasoning content is skipped on purpose; only the activity is noted.
      if (!completed)
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key("reasoning"),
            kind: "reasoning",
            summary: "Codex is reasoning",
            data: {},
          }),
        );
      break;
    case "error":
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key("error"),
          kind: "error",
          summary: clip(item.message ?? "Codex reported an error", 200),
          data: { message: String(item.message ?? "").slice(0, 2000) },
        }),
      );
      break;
    case "todo_list": {
      const items = Array.isArray(item.items) ? item.items : [];
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key(`${phase}:todo`),
          kind: "status",
          summary: `Plan: ${items.length} step${items.length === 1 ? "" : "s"}`,
          data: smallData({ items }),
        }),
      );
      break;
    }
    case "plan":
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key(`${phase}:plan`),
          kind: "status",
          summary: `Plan: ${clip(item.text ?? "", 100)}`,
          data: smallData({ text: item.text ?? null }),
        }),
      );
      break;
    case "mcp_tool_call":
    case "mcpToolCall":
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key(phase),
          kind: completed ? "tool.end" : "tool.start",
          tool: item.tool ?? item.name ?? "mcp_tool_call",
          summary: `MCP ${item.server ? `${item.server}/` : ""}${item.tool ?? item.name ?? "tool"} ${completed ? "finished" : "started"}`,
          data: smallData({
            server: item.server ?? null,
            status: item.status ?? null,
          }),
        }),
      );
      break;
    case "web_search":
    case "webSearch":
      events.push(
        event(PROVIDER, {
          ...base,
          providerEventId: key(phase),
          kind: "web",
          tool: "web_search",
          summary: `Web search: ${clip(item.query ?? "", 100)}`,
          data: { query: item.query ?? null },
        }),
      );
      break;
    default:
      if (completed)
        events.push(
          event(PROVIDER, {
            ...base,
            providerEventId: key(phase),
            kind: "status",
            summary: `${type || "item"} ${phase}`,
            data: smallData({ type }),
          }),
        );
  }
  return events;
}

/**
 * Codex CLI `exec --json` adapter (docs/ARCHITECTURE.md §3).
 * stdin must be closed or Codex waits on "additional input".
 */
export const codexAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Codex",
  capabilities: {
    launch: "verified",
    stream: "verified",
    interrupt: "verified",
    resume: "verified",
    approve: "unsupported", // exec mode has no approval channel; use app-server
    reportModel: "unknown",
    reportUsage: "verified",
    artifacts: "verified",
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },

  build({
    prompt,
    binary,
    cwd,
    policy,
    model,
    extraDirs = [],
    resumeSessionId = null,
  }) {
    const args = [...(binary.args ?? [])];
    args.push("exec");
    if (resumeSessionId) args.push("resume", resumeSessionId);
    args.push("--json", "--skip-git-repo-check");
    if (cwd) args.push("-C", cwd);
    args.push("-s", sandboxFor(policy));
    if (model) args.push("-m", String(model));
    for (const dir of extraDirs) args.push("--add-dir", dir);
    args.push(prompt);
    return { command: binary.command, args, cwd, stdin: "ignore" };
  },

  parse(line, state) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    if (!record || typeof record !== "object") return [];
    const timestamp = Date.now();
    const sessionId = state.sessionId ?? null;
    switch (record.type) {
      case "thread.started":
        state.sessionId = record.thread_id ?? state.sessionId;
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${state.sessionId}:thread`,
            sessionId: state.sessionId,
            timestamp,
            kind: "session.start",
            summary: "Codex thread started",
            data: { threadId: state.sessionId },
          }),
        ];
      case "turn.started":
        state.turns = (state.turns ?? 0) + 1;
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${state.turns}:start`,
            sessionId,
            timestamp,
            kind: "turn.start",
            summary: "Codex turn started",
            data: {},
          }),
        ];
      case "item.started":
        return codexItemEvents(record.item, {
          phase: "started",
          sessionId,
          timestamp,
        });
      case "item.completed":
        return codexItemEvents(record.item, {
          phase: "completed",
          sessionId,
          timestamp,
        });
      case "turn.completed": {
        const usage = usageFromTokens(record.usage);
        if (usage) state.usage = usage;
        state.turnStatus = "completed";
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${state.turns ?? 1}:end`,
            sessionId,
            timestamp,
            kind: "usage",
            usage,
            summary: usage
              ? `Turn completed · ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`
              : "Turn completed",
            data: { usage },
          }),
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${state.turns ?? 1}:turnend`,
            sessionId,
            timestamp,
            kind: "turn.end",
            summary: "Codex turn finished",
            data: {},
          }),
        ];
      }
      case "turn.failed": {
        const message = record.error?.message ?? "Codex turn failed";
        state.turnStatus = "failed";
        state.error = message;
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${state.turns ?? 1}:failed`,
            sessionId,
            timestamp,
            kind: "error",
            summary: clip(message, 200),
            data: { message: String(message).slice(0, 2000) },
          }),
        ];
      }
      case "error": {
        const message = record.message ?? "Codex reported an error";
        state.error = state.error ?? message;
        // Top-level error lines carry no item id. Number them per thread so
        // a replayed stream (observer re-read, reconnect) dedups instead of
        // recording the same error twice; without a thread id there is no
        // stable key and the line stays non-dedupable.
        state.errors = (state.errors ?? 0) + 1;
        return [
          event(PROVIDER, {
            providerEventId: sessionId
              ? `${PROVIDER}:${sessionId}:error:${state.errors}`
              : null,
            sessionId,
            timestamp,
            kind: "error",
            summary: clip(message, 200),
            data: { message: String(message).slice(0, 2000) },
          }),
        ];
      }
      default:
        return [];
    }
  },

  finalize(state, exitCode) {
    let status;
    let error = null;
    if (
      state.turnStatus === "failed" ||
      (state.error && state.turnStatus !== "completed")
    ) {
      status = "failed";
      error = String(state.error ?? "Codex turn failed").slice(0, 500);
    } else if (state.turnStatus === "completed" || exitCode === 0)
      status = "completed";
    else {
      status = "failed";
      error = `Codex exited with code ${exitCode ?? "unknown"} before completing the turn`;
    }
    return {
      status,
      error,
      usage: state.usage ?? null,
      cost: null,
      sessionId: state.sessionId ?? null,
      model: state.model ?? null,
    };
  },
});

export default codexAdapter;
