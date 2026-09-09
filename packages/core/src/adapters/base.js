import { isAbsolute, resolve, relative } from "node:path";
import { makeEvent, classifyTool } from "../contracts.js";
import { isTestCommand } from "../runs/artifacts.js";

/**
 * Shared helpers for provider adapters.
 *
 * Adapter contract (docs/ARCHITECTURE.md §4 row E):
 *   {
 *     id, provider, name, transport: "stream" | "jsonrpc", capabilities,
 *     build({ run, task, agent, workspace, policy, prompt, binary, cwd,
 *             extraDirs, model, resumeSessionId, settings, hooksInstalled })
 *        → { command, args, cwd, env, stdin?, stdinText? },
 *     parse(line, state) → NormalizedEvent[],
 *     finalize(state, exitCode) → { status, error, usage, sessionId, cost },
 *     interrupt(child, state) → void   (optional; defaults to kill tree)
 *     attach(child, state, ctx)        (optional; jsonrpc transports)
 *   }
 * `state` is a plain object owned by the worker; adapters may store
 * sessionId, model, usage, cost, and anything else they need on it.
 */

export const TOOL_SETS = {
  "claude-code": {
    readOnly: ["Read", "Glob", "Grep"],
    // Only granted when the effective policy allows network access; the
    // "propose" preset does not.
    network: ["WebFetch", "WebSearch"],
    write: ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "Bash"],
  },
  copilot: {
    readOnly: ["view", "grep", "glob"],
  },
};

/** Whether the effective launch policy allows network tools. */
export function networkAllowed(policy = {}) {
  return policy.network === true || policy.allowedNetwork === true;
}

/**
 * Maps a workspace policy to what the launch may do. `observe-only` never
 * reaches an adapter: the worker refuses before building a command.
 */
export function permissionsFor(policy = {}) {
  const autonomy = policy.autonomy ?? "scoped";
  if (autonomy === "observe-only")
    return { autonomy, launch: false, write: false, shell: false };
  if (autonomy === "propose")
    return { autonomy, launch: true, write: false, shell: false };
  return { autonomy, launch: true, write: true, shell: true };
}

export function nowMs(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export function clip(text, max = 120) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function smallData(data, limit = 2000) {
  const text = JSON.stringify(data ?? {});
  if (text.length <= limit) return data ?? {};
  return { truncated: true, preview: text.slice(0, limit) };
}

/** Normalized event helper with provider defaults filled in. */
export function event(provider, partial) {
  return makeEvent({
    provider,
    timestamp: Date.now(),
    provenance: "provider",
    ...partial,
  });
}

/**
 * Describes a tool call as a normalized event list: a `tool.start` plus a
 * file/command/search/web/test event when the tool touches something.
 */
export function toolEvents(
  provider,
  { id, tool, input, timestamp, sessionId },
) {
  const args = input ?? {};
  const file =
    args.file_path ??
    args.path ??
    args.filePath ??
    args.notebook_path ??
    args.target_file ??
    null;
  const command =
    typeof args.command === "string"
      ? args.command
      : Array.isArray(args.command)
        ? args.command.join(" ")
        : typeof args.cmd === "string"
          ? args.cmd
          : null;
  const activity = classifyTool(tool, args);
  const summaryParts = [tool];
  if (file) summaryParts.push(clip(file, 80));
  else if (command) summaryParts.push(clip(command, 80));
  else if (args.pattern) summaryParts.push(clip(args.pattern, 60));
  else if (args.url) summaryParts.push(clip(args.url, 80));
  else if (args.query) summaryParts.push(clip(args.query, 60));
  const base = {
    providerEventId: id ? `${provider}:tool:${id}` : null,
    sessionId: sessionId ?? null,
    timestamp: nowMs(timestamp),
    kind: "tool.start",
    tool,
    file: file ? String(file) : null,
    activity,
    summary: summaryParts.join(" "),
    data: smallData({ toolUseId: id ?? null, input: args, command, file }),
  };
  const events = [event(provider, base)];
  let kind = null;
  if (activity === "CODING" && file) kind = "file.edit";
  else if (activity === "RESEARCHING" && file) kind = "file.read";
  else if (
    /^(glob|grep|search|codebase_search|search_files|list_dir|ls)$/i.test(tool)
  )
    kind = "search";
  else if (/^(webfetch|websearch|web_fetch|web_search|fetch)$/i.test(tool))
    kind = "web";
  else if (command) kind = isTestCommand(command) ? "test" : "command";
  if (kind)
    events.push(
      event(provider, {
        ...base,
        providerEventId: id ? `${provider}:tool:${id}:${kind}` : null,
        kind,
        summary:
          kind === "command" || kind === "test"
            ? `Running ${clip(command, 100)}`
            : kind === "file.edit"
              ? `Editing ${clip(file, 100)}`
              : kind === "file.read"
                ? `Reading ${clip(file, 100)}`
                : summaryParts.join(" "),
      }),
    );
  return events;
}

/** Builds the prompt sent to the provider from the task record. */
export function buildPrompt({ task, workspace, agent, context }) {
  const parts = [];
  parts.push(task.title);
  if (task.description) parts.push(task.description);
  if (task.deliverable) parts.push(`Deliverable: ${task.deliverable}`);
  const target = task.target ?? {};
  const files = Array.isArray(target.files) ? target.files : [];
  if (files.length)
    parts.push(`Relevant files:\n${files.map((f) => `- ${f}`).join("\n")}`);
  if (target.range?.file)
    parts.push(
      `Focus on ${target.range.file} lines ${target.range.start ?? "?"}-${target.range.end ?? "?"}${
        target.range.revision ? ` (revision ${target.range.revision})` : ""
      }.`,
    );
  const instructions = []
    .concat(context?.instructions ?? [])
    .concat(task.context?.instructions ?? [])
    .concat(agent?.instructions ? [agent.instructions] : [])
    .filter((text) => typeof text === "string" && text.trim());
  if (instructions.length)
    parts.push(
      `Instructions:\n${instructions.map((i) => `- ${i.trim()}`).join("\n")}`,
    );
  if (workspace?.name) parts.push(`Workspace: ${workspace.name}`);
  return parts.join("\n\n");
}

/** Folders the provider needs beyond cwd (task target outside the cwd). */
export function extraDirsFor({ task, cwd }) {
  const dirs = [];
  const folder = task?.target?.folder;
  if (folder && isAbsolute(folder) && cwd) {
    const rel = relative(resolve(cwd), resolve(folder));
    const outside =
      rel === "" ? false : rel.startsWith("..") || isAbsolute(rel);
    if (outside) dirs.push(resolve(folder));
  }
  return dirs;
}

export function quoteArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** Command line for storage: command + args, secrets never included. */
export function commandLine(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

export function defineAdapter(definition) {
  return {
    transport: "stream",
    interrupt: null,
    attach: null,
    supportsResume: definition.capabilities?.resume === "verified",
    ...definition,
  };
}

/**
 * Best-effort parser for providers whose stream format is documented but not
 * verified on this machine (Gemini CLI, Cursor). Any JSON line is inspected
 * for type/role/tool/usage/session fields; unknown shapes become `status`.
 */
export function tolerantParse(provider, line, state) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!record || typeof record !== "object") return [];
  const timestamp = nowMs(record.timestamp);
  const sessionId =
    record.session_id ?? record.sessionId ?? record.thread_id ?? null;
  if (sessionId) state.sessionId = sessionId;
  const model = record.model ?? record.message?.model ?? null;
  if (model) state.model = model;
  const type = String(
    record.type ?? record.event ?? record.role ?? "",
  ).toLowerCase();
  const id = record.id ?? record.uuid ?? null;
  const base = {
    providerEventId: id ? `${provider}:${id}` : null,
    sessionId: state.sessionId ?? null,
    timestamp,
    model,
  };
  const text =
    typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : typeof record.message === "string"
          ? record.message
          : typeof record.message?.content === "string"
            ? record.message.content
            : typeof record.result === "string"
              ? record.result
              : null;
  const toolName =
    record.tool_name ??
    record.toolName ??
    record.tool?.name ??
    record.name ??
    null;
  const events = [];
  if (
    /^(init|session[._-]?start|system)$/.test(type) ||
    record.subtype === "init"
  ) {
    events.push(
      event(provider, {
        ...base,
        kind: "session.start",
        summary: `${provider} session started${model ? ` (${model})` : ""}`,
        data: smallData({ type }),
      }),
    );
  } else if (
    /tool[._-]?(use|call|start)|^tool_use$/.test(type) ||
    (toolName && /start|call|use/.test(type))
  ) {
    events.push(
      ...toolEvents(provider, {
        id: record.tool_call_id ?? record.toolCallId ?? record.tool?.id ?? id,
        tool: toolName ?? "tool",
        input:
          record.input ??
          record.arguments ??
          record.args ??
          record.tool?.input ??
          {},
        timestamp,
        sessionId: state.sessionId,
      }),
    );
  } else if (/tool[._-]?(result|end|complete|output)/.test(type)) {
    const isError =
      record.is_error === true ||
      record.success === false ||
      record.status === "error";
    events.push(
      event(provider, {
        ...base,
        kind: isError ? "error" : "tool.end",
        tool: toolName,
        summary: isError
          ? `Tool failed${text ? `: ${clip(text, 100)}` : ""}`
          : `Tool finished${text ? `: ${clip(text, 80)}` : ""}`,
        data: smallData({
          output: text ? String(text).slice(0, 4000) : null,
          isError,
        }),
      }),
    );
  } else if (type === "user" || type === "prompt") {
    if (text)
      events.push(
        event(provider, {
          ...base,
          kind: "prompt",
          provenance: "user",
          summary: clip(text, 120),
          data: { text: String(text).slice(0, 4000) },
        }),
      );
  } else if (/error|fail/.test(type) || record.error) {
    const message =
      text ??
      record.error?.message ??
      (typeof record.error === "string"
        ? record.error
        : "Provider reported an error");
    state.error = state.error ?? message;
    events.push(
      event(provider, {
        ...base,
        kind: "error",
        summary: clip(message, 200),
        data: smallData({ error: record.error ?? message }),
      }),
    );
  } else if (/result|complete|done|finish/.test(type)) {
    state.result = record;
    if (record.status && /error|fail/i.test(String(record.status)))
      state.error = state.error ?? text ?? String(record.status);
    if (text) state.finalText = text;
    events.push(
      event(provider, {
        ...base,
        kind: "usage",
        usage: usageFromTokens(record.usage ?? record.stats ?? null),
        summary: `Result: ${record.status ?? record.subtype ?? "finished"}`,
        data: smallData({
          status: record.status ?? null,
          usage: record.usage ?? null,
        }),
      }),
    );
    if (text)
      events.push(
        event(provider, {
          ...base,
          providerEventId: base.providerEventId
            ? `${base.providerEventId}:final`
            : null,
          kind: "message",
          summary: clip(text, 120),
          data: { text: String(text).slice(0, 4000), final: true },
        }),
      );
  } else if (
    text &&
    (type === "assistant" ||
      type === "message" ||
      type === "text" ||
      type === "content")
  ) {
    state.finalText = text;
    events.push(
      event(provider, {
        ...base,
        kind: "message",
        summary: clip(text, 120),
        data: { text: String(text).slice(0, 4000) },
      }),
    );
  } else if (record.usage && typeof record.usage === "object") {
    events.push(
      event(provider, {
        ...base,
        kind: "usage",
        usage: usageFromTokens(record.usage),
        summary: "Usage reported",
        data: smallData({ usage: record.usage }),
      }),
    );
  } else if (type) {
    events.push(
      event(provider, {
        ...base,
        kind: "status",
        summary: `${provider}: ${clip(type, 60)}`,
        data: smallData({ type }),
      }),
    );
  }
  return events;
}

export function tolerantFinalize(provider, state, exitCode) {
  let status;
  let error = null;
  if (state.error) {
    status = "failed";
    error = String(state.error).slice(0, 500);
  } else if (exitCode === 0) status = "completed";
  else {
    status = "failed";
    error = `${provider} exited with code ${exitCode ?? "unknown"}`;
  }
  return {
    status,
    error,
    usage: state.usage ?? null,
    cost: null,
    sessionId: state.sessionId ?? null,
    model: state.model ?? null,
    finalText: state.finalText ?? null,
  };
}

export function usageFromTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(usage))
    if (typeof value === "number") out[key] = value;
  return Object.keys(out).length ? { ...out, reportedBy: "provider" } : null;
}
