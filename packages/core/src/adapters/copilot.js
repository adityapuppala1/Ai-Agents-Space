import {
  defineAdapter,
  permissionsFor,
  TOOL_SETS,
  toolEvents,
  event,
  clip,
  nowMs,
  smallData,
} from "./base.js";

const PROVIDER = "copilot";

/**
 * GitHub Copilot CLI headless adapter (docs/ARCHITECTURE.md §3):
 *   copilot -p "<prompt>" --output-format json [--allow-all-tools |
 *     --allow-tool <name>...] [--add-dir d] [--model m] [--resume id]
 *     [--no-auto-update]
 */
export const copilotAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Copilot",
  capabilities: {
    launch: "verified",
    stream: "verified",
    interrupt: "verified",
    resume: "verified",
    approve: "unsupported", // non-interactive mode pre-approves tools
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
  }) {
    const perms = permissionsFor(policy);
    const args = [...(binary.args ?? [])];
    args.push("-p", prompt, "--output-format", "json", "--no-auto-update");
    if (perms.autonomy === "propose")
      for (const tool of TOOL_SETS.copilot.readOnly)
        args.push("--allow-tool", tool);
    else args.push("--allow-all-tools");
    if (model) args.push("--model", String(model));
    for (const dir of extraDirs) args.push("--add-dir", dir);
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    return { command: binary.command, args, cwd, stdin: "ignore" };
  },

  parse(line, state) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    if (!record || typeof record !== "object" || !record.type) return [];
    const data = record.data ?? {};
    const timestamp = nowMs(record.timestamp);
    const id = record.id ?? null;
    const key = (suffix) =>
      id ? `${PROVIDER}:${id}${suffix ? `:${suffix}` : ""}` : null;
    const sessionId = state.sessionId ?? null;
    const model = data.model ?? state.model ?? null;
    if (data.model) state.model = data.model;
    state.tools ??= {};

    switch (record.type) {
      case "session.start":
        if (data.sessionId) state.sessionId = data.sessionId;
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId: state.sessionId,
            cwd: data.context?.cwd ?? null,
            timestamp,
            kind: "session.start",
            summary: `Copilot session started${data.copilotVersion ? ` (v${data.copilotVersion})` : ""}`,
            data: smallData({ version: data.copilotVersion ?? null }),
          }),
        ];
      case "session.auto_mode_resolved":
      case "session.model_change": {
        const chosen = data.chosenModel ?? data.model ?? data.newModel ?? null;
        if (chosen) state.model = chosen;
        return chosen
          ? [
              event(PROVIDER, {
                providerEventId: key(),
                sessionId,
                timestamp,
                kind: "status",
                model: chosen,
                summary: `Model: ${chosen}`,
                data: { model: chosen },
              }),
            ]
          : [];
      }
      case "user.message":
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "prompt",
            provenance: "user",
            summary: clip(data.content ?? "", 120),
            data: { text: String(data.content ?? "").slice(0, 4000) },
          }),
        ];
      case "assistant.turn_start":
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "turn.start",
            summary: `Turn ${data.turnId ?? ""} started`.trim(),
            data: { turnId: data.turnId ?? null },
          }),
        ];
      case "assistant.turn_end":
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "turn.end",
            summary: `Turn ${data.turnId ?? ""} finished`.trim(),
            data: { turnId: data.turnId ?? null },
          }),
        ];
      case "assistant.reasoning":
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "reasoning",
            model,
            summary: "Copilot is reasoning",
            data: {},
          }),
        ];
      case "assistant.message": {
        const events = [];
        const requests = Array.isArray(data.toolRequests)
          ? data.toolRequests
          : [];
        for (const request of requests) {
          state.tools[request.toolCallId] = request;
          // The tool call is announced here; tool.execution_start carries the
          // same call, so record the intent only.
          events.push(
            event(PROVIDER, {
              providerEventId: request.toolCallId
                ? `${PROVIDER}:toolreq:${request.toolCallId}`
                : null,
              sessionId,
              timestamp,
              kind: "status",
              model,
              tool: request.name ?? null,
              summary: `Requested ${request.name ?? "tool"}${
                request.intentionSummary
                  ? `: ${clip(request.intentionSummary, 80)}`
                  : ""
              }`,
              data: smallData({
                toolCallId: request.toolCallId ?? null,
                arguments: request.arguments ?? null,
              }),
            }),
          );
        }
        if (data.content && String(data.content).trim()) {
          state.finalText = String(data.content);
          events.push(
            event(PROVIDER, {
              providerEventId: key("message"),
              sessionId,
              timestamp,
              kind: "message",
              model,
              summary: clip(data.content, 120),
              data: { text: String(data.content).slice(0, 4000) },
            }),
          );
        }
        return events;
      }
      case "tool.execution_start":
        return toolEvents(PROVIDER, {
          id: data.toolCallId ?? id,
          tool: data.toolName ?? "tool",
          input: data.arguments ?? {},
          timestamp,
          sessionId,
        }).map((e) => ({ ...e, model }));
      case "tool.execution_complete": {
        const ok = data.success !== false;
        const text = data.result?.content ?? "";
        return [
          event(PROVIDER, {
            providerEventId: data.toolCallId
              ? `${PROVIDER}:tool:${data.toolCallId}:end`
              : key(),
            sessionId,
            timestamp,
            kind: ok ? "tool.end" : "error",
            model,
            tool: state.tools[data.toolCallId]?.name ?? null,
            summary: ok
              ? `Tool finished${text ? `: ${clip(text, 80)}` : ""}`
              : `Tool failed: ${clip(text || data.error || "", 100)}`,
            data: smallData({
              toolCallId: data.toolCallId ?? null,
              output: String(text).slice(0, 4000),
              success: ok,
            }),
          }),
        ];
      }
      case "session.usage_checkpoint":
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "usage",
            // Checkpoints are cumulative; the final result sets run usage.
            usage: null,
            summary: `Usage checkpoint: ${data.totalPremiumRequests ?? 0} premium requests (cumulative)`,
            data: smallData({
              totalPremiumRequests: data.totalPremiumRequests ?? 0,
              totalNanoAiu: data.totalNanoAiu ?? null,
            }),
          }),
        ];
      case "session.error":
      case "error":
        state.error = data.message ?? data.error ?? "Copilot reported an error";
        return [
          event(PROVIDER, {
            providerEventId: key(),
            sessionId,
            timestamp,
            kind: "error",
            summary: clip(state.error, 200),
            data: smallData(data),
          }),
        ];
      case "result": {
        state.result = record;
        if (record.sessionId) state.sessionId = record.sessionId;
        state.exitCode = record.exitCode ?? null;
        const usage = record.usage ?? {};
        state.usage = {
          premiumRequests: usage.premiumRequests ?? 0,
          totalApiDurationMs: usage.totalApiDurationMs ?? null,
          sessionDurationMs: usage.sessionDurationMs ?? null,
          reportedBy: "provider",
        };
        const events = [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${state.sessionId}:result`,
            sessionId: state.sessionId,
            timestamp,
            kind: "usage",
            model: state.model ?? null,
            usage: null,
            summary: `Result: exit ${record.exitCode ?? "?"} · ${usage.premiumRequests ?? 0} premium requests (provider-reported)`,
            data: smallData({
              exitCode: record.exitCode ?? null,
              usage: state.usage,
              codeChanges: usage.codeChanges ?? null,
            }),
          }),
        ];
        const files = usage.codeChanges?.filesModified ?? [];
        files.forEach((file, index) =>
          events.push(
            event(PROVIDER, {
              providerEventId: `${PROVIDER}:${state.sessionId}:result:file:${index}`,
              sessionId: state.sessionId,
              timestamp,
              kind: "file.edit",
              file: String(file),
              summary: `Modified ${clip(file, 100)} (reported by Copilot)`,
              data: { path: file },
            }),
          ),
        );
        return events;
      }
      default:
        return [];
    }
  },

  finalize(state, exitCode) {
    const reported = state.result?.exitCode;
    const code = reported ?? exitCode;
    let status = code === 0 ? "completed" : "failed";
    let error = null;
    if (status === "failed")
      error = String(
        state.error ?? `Copilot exited with code ${code ?? "unknown"}`,
      ).slice(0, 500);
    if (!state.result && exitCode !== 0) status = "failed";
    return {
      status,
      error,
      usage: state.usage ?? null,
      cost: null,
      sessionId: state.sessionId ?? null,
      model: state.model ?? null,
      finalText: state.finalText ?? null,
    };
  },
});

export default copilotAdapter;
