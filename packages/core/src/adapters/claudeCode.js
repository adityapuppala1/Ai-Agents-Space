import {
  defineAdapter,
  permissionsFor,
  networkAllowed,
  TOOL_SETS,
  toolEvents,
  event,
  clip,
  nowMs,
  smallData,
  usageFromTokens,
} from "./base.js";

const PROVIDER = "claude-code";

/**
 * Claude Code headless adapter.
 * Command (verified, docs/ARCHITECTURE.md §3):
 *   claude -p "<prompt>" --output-format stream-json --verbose
 *          [--model m] [--permission-mode ...] [--allowedTools ...]
 *          [--add-dir d] [--resume id] [--include-hook-events]
 * `--bare` is never passed (it disables auth).
 */
export const claudeCodeAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Claude Code",
  capabilities: {
    launch: "verified",
    stream: "verified",
    interrupt: "verified",
    resume: "verified",
    approve: "verified", // through the hook bridge, not this stream
    reportModel: "verified",
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
    hooksInstalled = false,
    maxTurns = null,
  }) {
    const perms = permissionsFor(policy);
    const args = [...(binary.args ?? [])];
    args.push("-p", prompt, "--output-format", "stream-json", "--verbose");
    if (model) args.push("--model", String(model));
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (perms.autonomy === "propose") {
      args.push("--permission-mode", "plan");
      args.push(
        "--allowedTools",
        ...TOOL_SETS[PROVIDER].readOnly,
        ...(networkAllowed(policy) ? TOOL_SETS[PROVIDER].network : []),
      );
    } else {
      args.push("--permission-mode", "acceptEdits");
      args.push("--allowedTools", ...TOOL_SETS[PROVIDER].write);
    }
    for (const dir of extraDirs) args.push("--add-dir", dir);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (hooksInstalled) args.push("--include-hook-events");
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
    const sessionId = record.session_id ?? state.sessionId ?? null;
    if (record.session_id) state.sessionId = record.session_id;
    const timestamp = nowMs(record.timestamp);
    const uuid = record.uuid ?? null;
    const events = [];

    if (record.type === "system") {
      if (record.subtype === "init") {
        state.model = record.model ?? state.model;
        state.tools = record.tools ?? [];
        events.push(
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:init`,
            sessionId,
            cwd: record.cwd ?? null,
            timestamp,
            kind: "session.start",
            summary: `Claude Code session started${record.model ? ` (${record.model})` : ""}`,
            model: record.model ?? null,
            data: smallData({
              permissionMode: record.permissionMode ?? null,
              tools: record.tools ?? [],
              version: record.claude_code_version ?? null,
            }),
          }),
        );
      } else if (record.subtype === "thinking_tokens") {
        // Estimates only; never stored as reported usage.
        return [];
      }
      return events;
    }

    if (record.type === "rate_limit_event") {
      const info = record.rate_limit_info ?? {};
      events.push(
        event(PROVIDER, {
          providerEventId: uuid ? `${PROVIDER}:${uuid}` : null,
          sessionId,
          timestamp,
          kind: "status",
          summary: `Rate limit ${info.status ?? "update"}${
            info.rateLimitType ? ` (${info.rateLimitType})` : ""
          }`,
          data: smallData({ rateLimit: info }),
        }),
      );
      return events;
    }

    if (record.type === "assistant") {
      const message = record.message ?? {};
      const model = message.model ?? null;
      if (model) state.model = model;
      const blocks = Array.isArray(message.content) ? message.content : [];
      blocks.forEach((block, index) => {
        if (block.type === "tool_use") {
          events.push(
            ...toolEvents(PROVIDER, {
              id: block.id,
              tool: block.name,
              input: block.input,
              timestamp,
              sessionId,
            }).map((e) => ({ ...e, model })),
          );
        } else if (block.type === "text" && block.text?.trim()) {
          events.push(
            event(PROVIDER, {
              providerEventId: uuid
                ? `${PROVIDER}:${uuid}:text:${index}`
                : null,
              sessionId,
              timestamp,
              kind: "message",
              model,
              summary: clip(block.text, 120),
              data: { text: String(block.text).slice(0, 4000) },
            }),
          );
        }
      });
      if (message.usage && typeof message.usage === "object") {
        // Claude Code writes one line per content block, each repeating the
        // same message usage; count it once per message id.
        const messageId = message.id ? String(message.id) : uuid;
        state.usageSeen ??= new Set();
        const usage = usageFromTokens(message.usage);
        if (usage && messageId && !state.usageSeen.has(messageId)) {
          state.usageSeen.add(messageId);
          events.push(
            event(PROVIDER, {
              providerEventId: `${PROVIDER}:${messageId}:usage`,
              sessionId,
              timestamp,
              kind: "usage",
              model,
              usage,
              summary: `Usage: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`,
              data: { usage, messageId },
            }),
          );
        }
      }
      return events;
    }

    if (record.type === "user") {
      const blocks = Array.isArray(record.message?.content)
        ? record.message.content
        : [];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const isError = block.is_error === true;
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((c) => (typeof c === "string" ? c : (c.text ?? "")))
                  .join("\n")
              : "";
        events.push(
          event(PROVIDER, {
            providerEventId: block.tool_use_id
              ? `${PROVIDER}:tool:${block.tool_use_id}:end`
              : uuid
                ? `${PROVIDER}:${uuid}`
                : null,
            sessionId,
            timestamp,
            kind: isError ? "error" : "tool.end",
            summary: isError
              ? `Tool failed: ${clip(text, 100)}`
              : `Tool finished${text ? `: ${clip(text, 80)}` : ""}`,
            data: smallData({
              toolUseId: block.tool_use_id ?? null,
              output: String(text).slice(0, 4000),
              isError,
            }),
          }),
        );
      }
      return events;
    }

    if (record.type === "result") {
      state.result = record;
      state.exitSubtype = record.subtype ?? null;
      state.isError = record.is_error === true;
      state.finalText = record.result ?? null;
      const usage = usageFromTokens(record.usage);
      if (usage) state.usage = usage;
      if (typeof record.total_cost_usd === "number")
        state.cost = { usd: record.total_cost_usd, reportedBy: "provider" };
      const models = Object.keys(record.modelUsage ?? {});
      if (models.length === 1) state.model = models[0];
      events.push(
        event(PROVIDER, {
          providerEventId: uuid ? `${PROVIDER}:${uuid}:result` : null,
          sessionId,
          timestamp,
          kind: "usage",
          model: state.model ?? null,
          // Totals are written by finalize(); merging here would double count.
          usage: null,
          summary: `Result: ${record.subtype ?? "unknown"}${
            typeof record.total_cost_usd === "number"
              ? ` · $${record.total_cost_usd.toFixed(4)} (provider-reported)`
              : ""
          }`,
          data: smallData({
            subtype: record.subtype ?? null,
            isError: record.is_error === true,
            numTurns: record.num_turns ?? null,
            durationMs: record.duration_ms ?? null,
            cost: state.cost ?? null,
            terminalReason: record.terminal_reason ?? null,
            modelUsage: record.modelUsage ?? null,
          }),
        }),
      );
      if (record.result && String(record.result).trim())
        events.push(
          event(PROVIDER, {
            providerEventId: uuid ? `${PROVIDER}:${uuid}:final` : null,
            sessionId,
            timestamp,
            kind: "message",
            model: state.model ?? null,
            summary: clip(record.result, 120),
            data: { text: String(record.result).slice(0, 4000), final: true },
          }),
        );
      const denials = Array.isArray(record.permission_denials)
        ? record.permission_denials
        : [];
      if (denials.length)
        events.push(
          event(PROVIDER, {
            providerEventId: uuid ? `${PROVIDER}:${uuid}:denials` : null,
            sessionId,
            timestamp,
            kind: "status",
            summary: `${denials.length} permission denial${denials.length === 1 ? "" : "s"} reported by Claude Code`,
            data: smallData({ denied: denials }),
          }),
        );
      if (record.is_error)
        events.push(
          event(PROVIDER, {
            providerEventId: uuid ? `${PROVIDER}:${uuid}:error` : null,
            sessionId,
            timestamp,
            kind: "error",
            summary: `Claude Code reported ${record.subtype ?? "an error"}${
              record.result ? `: ${clip(record.result, 100)}` : ""
            }`,
            data: smallData({ subtype: record.subtype ?? null }),
          }),
        );
      return events;
    }

    // Hook events (--include-hook-events) and anything else: keep as status.
    if (record.type === "hook_event" || record.hook_event_name) {
      events.push(
        event(PROVIDER, {
          providerEventId: uuid ? `${PROVIDER}:${uuid}` : null,
          sessionId,
          timestamp,
          kind: "system",
          summary: `Hook ${record.hook_event_name ?? record.subtype ?? "event"}${
            record.tool_name ? ` (${record.tool_name})` : ""
          }`,
          data: smallData({ hook: record.hook_event_name ?? null }),
        }),
      );
    }
    return events;
  },

  finalize(state, exitCode) {
    const result = state.result;
    let status;
    let error = null;
    if (result) {
      status =
        result.is_error || result.subtype !== "success"
          ? "failed"
          : "completed";
      if (status === "failed")
        error = result.result
          ? String(result.result).slice(0, 500)
          : `Claude Code ended with ${result.subtype ?? "an error"}`;
    } else if (exitCode === 0) {
      status = "completed";
    } else {
      status = "failed";
      error = `Claude Code exited with code ${exitCode ?? "unknown"} before reporting a result`;
    }
    return {
      status,
      error,
      usage: state.usage ?? null,
      cost: state.cost ?? null,
      sessionId: state.sessionId ?? null,
      model: state.model ?? null,
      finalText: state.finalText ?? null,
    };
  },
});

export default claudeCodeAdapter;
