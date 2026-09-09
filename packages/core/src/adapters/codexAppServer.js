import { defineAdapter, event, clip, smallData } from "./base.js";
import { codexItemEvents, sandboxFor } from "./codex.js";

const PROVIDER = "codex";
const ID = "codex-app-server";
const CLIENT_VERSION = "0.2.0";

/**
 * Approval-like server requests from the Codex app-server protocol, both the
 * v2 names and the legacy names, with the decision enums taken from the
 * generated schema bundle (CommandExecutionApprovalDecision,
 * FileChangeApprovalDecision, ReviewDecision, GrantedPermissionProfile,
 * McpServerElicitationAction, ToolRequestUserInputResponse).
 */
export const APPROVAL_METHODS = {
  "item/commandExecution/requestApproval": {
    kind: "command",
    approve: { decision: "accept" },
    deny: { decision: "decline" },
  },
  "item/fileChange/requestApproval": {
    kind: "file",
    approve: { decision: "accept" },
    deny: { decision: "decline" },
  },
  "item/permissions/requestApproval": {
    kind: "permission",
    approve: (params) => ({
      permissions: params.permissions ?? {},
      scope: "turn",
    }),
    deny: () => ({ permissions: {} }),
  },
  execCommandApproval: {
    kind: "command",
    approve: { decision: "approved" },
    deny: { decision: "denied" },
  },
  applyPatchApproval: {
    kind: "file",
    approve: { decision: "approved" },
    deny: { decision: "denied" },
  },
  "mcpServer/elicitation/request": {
    kind: "permission",
    approve: { action: "accept", content: null },
    deny: { action: "decline", content: null },
  },
  "item/tool/requestUserInput": {
    kind: "question",
    approve: { answers: {} },
    deny: { answers: {} },
  },
};

function responseFor(spec, approved, params) {
  const value = approved ? spec.approve : spec.deny;
  return typeof value === "function" ? value(params ?? {}) : value;
}

function describeRequest(method, params = {}, state) {
  const spec = APPROVAL_METHODS[method];
  const kind = spec?.kind ?? "permission";
  const command = Array.isArray(params.command)
    ? params.command.join(" ")
    : (params.command ?? null);
  let changes = null;
  if (params.fileChanges && typeof params.fileChanges === "object")
    changes = Object.entries(params.fileChanges).map(([path, change]) => ({
      path,
      kind: change?.kind ?? change?.type ?? null,
    }));
  else if (params.itemId && state.items?.[params.itemId]?.changes)
    changes = state.items[params.itemId].changes.map((c) => ({
      path: c.path,
      kind: c.kind ?? null,
    }));
  const payload = {
    method,
    command,
    cwd: params.cwd ?? state.cwd ?? null,
    reason: params.reason ?? null,
    changes,
    itemId: params.itemId ?? params.callId ?? null,
    approvalId: params.approvalId ?? null,
    permissions: params.permissions ?? null,
    grantRoot: params.grantRoot ?? null,
    questions: params.questions ?? null,
    network: params.networkApprovalContext ?? null,
  };
  const summary =
    kind === "command"
      ? `Codex asks to run: ${clip(command ?? "(command)", 100)}`
      : kind === "file"
        ? `Codex asks to change ${changes?.length ? `${changes.length} file${changes.length === 1 ? "" : "s"}` : "files"}${
            changes?.[0]?.path ? ` (${clip(changes[0].path, 60)})` : ""
          }`
        : kind === "question"
          ? "Codex asks a question"
          : `Codex asks for permissions${params.reason ? `: ${clip(params.reason, 80)}` : ""}`;
  return { kind, payload, summary };
}

function usageFromBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return null;
  const out = { reportedBy: "provider" };
  if (typeof breakdown.inputTokens === "number")
    out.input_tokens = breakdown.inputTokens;
  if (typeof breakdown.outputTokens === "number")
    out.output_tokens = breakdown.outputTokens;
  if (typeof breakdown.cachedInputTokens === "number")
    out.cached_input_tokens = breakdown.cachedInputTokens;
  if (typeof breakdown.reasoningOutputTokens === "number")
    out.reasoning_output_tokens = breakdown.reasoningOutputTokens;
  if (typeof breakdown.totalTokens === "number")
    out.total_tokens = breakdown.totalTokens;
  return Object.keys(out).length > 1 ? out : null;
}

/**
 * Codex app-server adapter: JSON-RPC 2.0 over stdio (newline-delimited).
 * initialize → thread/start (or thread/resume) → turn/start; notifications
 * become events; server requests are answered through services.approvals.
 */
export const codexAppServerAdapter = defineAdapter({
  id: ID,
  provider: PROVIDER,
  name: "Codex (app server)",
  transport: "jsonrpc",
  capabilities: {
    launch: "experimental",
    stream: "experimental",
    interrupt: "experimental",
    resume: "experimental",
    approve: "experimental",
    reportModel: "experimental",
    reportUsage: "experimental",
    artifacts: "verified",
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },
  supportsResume: true,

  build({ prompt, binary, cwd, policy, model, resumeSessionId = null }) {
    const args = [...(binary.args ?? []), "app-server"];
    return {
      command: binary.command,
      args,
      cwd,
      stdin: "pipe",
      rpc: {
        cwd,
        prompt,
        model: model ?? null,
        sandbox: sandboxFor(policy),
        approvalPolicy: "on-request",
        resumeSessionId,
      },
    };
  },

  /** Starts the JSON-RPC conversation once the child is running. */
  attach(child, state, ctx) {
    const rpc = {
      nextId: 1,
      pending: new Map(),
      write(message) {
        if (!child.stdin || child.stdin.destroyed) return false;
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
          return true;
        } catch {
          return false;
        }
      },
      call(method, params, timeoutMs = 60000) {
        const id = rpc.nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            rpc.pending.delete(id);
            reject(
              new Error(
                `Codex app-server did not answer ${method} within ${timeoutMs} ms`,
              ),
            );
          }, timeoutMs);
          timer.unref?.();
          rpc.pending.set(id, { resolve, reject, timer, method });
          if (!rpc.write({ jsonrpc: "2.0", id, method, params }))
            reject(new Error(`Could not write ${method} to Codex app-server`));
        });
      },
      respond(id, result) {
        return rpc.write({ jsonrpc: "2.0", id, result });
      },
      respondError(id, code, message) {
        return rpc.write({ jsonrpc: "2.0", id, error: { code, message } });
      },
    };
    state.rpc = rpc;
    state.ctx = ctx;
    state.items = {};
    state.cwd = ctx.launch?.rpc?.cwd ?? null;
    const spec = ctx.launch?.rpc ?? {};
    (async () => {
      try {
        await rpc.call("initialize", {
          clientInfo: { name: "agent-space", version: CLIENT_VERSION },
        });
        let threadId = spec.resumeSessionId ?? null;
        if (threadId) {
          const resumed = await rpc.call("thread/resume", {
            threadId,
            cwd: spec.cwd ?? undefined,
            approvalPolicy: spec.approvalPolicy,
            sandbox: spec.sandbox,
            model: spec.model ?? undefined,
          });
          threadId = resumed?.thread?.id ?? threadId;
        } else {
          const started = await rpc.call("thread/start", {
            cwd: spec.cwd ?? undefined,
            approvalPolicy: spec.approvalPolicy,
            sandbox: spec.sandbox,
            model: spec.model ?? undefined,
          });
          threadId = started?.thread?.id ?? started?.threadId ?? threadId;
          if (started?.model) state.model = started.model;
        }
        if (threadId) {
          state.sessionId = threadId;
          state.threadId = threadId;
          ctx.emit(
            event(PROVIDER, {
              providerEventId: `${PROVIDER}:${threadId}:thread`,
              sessionId: threadId,
              timestamp: Date.now(),
              kind: "session.start",
              summary: `Codex thread ${spec.resumeSessionId ? "resumed" : "started"} (app server)`,
              data: {
                threadId,
                sandbox: spec.sandbox,
                approvalPolicy: spec.approvalPolicy,
              },
            }),
          );
        }
        const turn = await rpc.call("turn/start", {
          threadId,
          input: [{ type: "text", text: spec.prompt ?? "" }],
        });
        if (turn?.turn?.id) state.turnId = turn.turn.id;
      } catch (error) {
        state.error = error.message;
        state.turnStatus = "failed";
        ctx.fail?.(error.message);
      }
    })();
  },

  parse(line, state) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }
    if (!message || typeof message !== "object") return [];
    const timestamp = Date.now();
    const sessionId = state.sessionId ?? null;

    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const pending = state.rpc?.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        state.rpc.pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(
              `${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`,
            ),
          );
        else pending.resolve(message.result);
      }
      return [];
    }

    // Server → client request: must be answered by id.
    if (message.id !== undefined && message.method) {
      handleServerRequest(message, state);
      return [];
    }

    const params = message.params ?? {};
    switch (message.method) {
      case "thread/started": {
        const threadId = params.thread?.id ?? params.threadId ?? null;
        if (threadId && !state.sessionId) {
          state.sessionId = threadId;
          state.threadId = threadId;
        }
        return [];
      }
      case "turn/started":
        state.turnId = params.turn?.id ?? state.turnId ?? null;
        state.turns = (state.turns ?? 0) + 1;
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${state.turnId ?? state.turns}:start`,
            sessionId,
            timestamp,
            kind: "turn.start",
            summary: "Codex turn started",
            data: { turnId: state.turnId },
          }),
        ];
      case "item/started":
        if (params.item?.id) state.items[params.item.id] = params.item;
        return codexItemEvents(params.item, {
          phase: "started",
          sessionId,
          timestamp,
        });
      case "item/completed":
        if (params.item?.id) state.items[params.item.id] = params.item;
        return codexItemEvents(params.item, {
          phase: "completed",
          sessionId,
          timestamp,
        });
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
      case "item/reasoning/delta":
      case "item/reasoning/summaryDelta":
        return [];
      case "turn/completed": {
        const turn = params.turn ?? {};
        state.turnStatus = turn.status ?? "completed";
        if (turn.error?.message) state.error = turn.error.message;
        if (turn.usage)
          state.usage = usageFromBreakdown(turn.usage) ?? state.usage;
        state.finished = true;
        return [
          event(PROVIDER, {
            providerEventId: `${PROVIDER}:${sessionId}:turn:${turn.id ?? state.turnId ?? state.turns}:end`,
            sessionId,
            timestamp,
            kind: state.turnStatus === "failed" ? "error" : "turn.end",
            summary:
              state.turnStatus === "failed"
                ? `Codex turn failed: ${clip(turn.error?.message ?? "unknown error", 150)}`
                : `Codex turn ${state.turnStatus}`,
            data: smallData({
              status: state.turnStatus,
              error: turn.error ?? null,
            }),
          }),
        ];
      }
      case "thread/tokenUsage/updated": {
        const total = usageFromBreakdown(params.tokenUsage?.total);
        if (total) state.usage = total;
        return [
          event(PROVIDER, {
            sessionId,
            timestamp,
            kind: "status",
            summary: total
              ? `Token usage: ${total.input_tokens ?? 0} in / ${total.output_tokens ?? 0} out (cumulative)`
              : "Token usage updated",
            data: smallData({
              total,
              last: usageFromBreakdown(params.tokenUsage?.last),
            }),
          }),
        ];
      }
      case "error": {
        const text =
          params.error?.message ?? params.message ?? "Codex reported an error";
        if (!params.willRetry) state.error = text;
        return [
          event(PROVIDER, {
            sessionId,
            timestamp,
            kind: "error",
            summary: `${clip(text, 180)}${params.willRetry ? " (retrying)" : ""}`,
            data: smallData({
              error: params.error ?? null,
              willRetry: !!params.willRetry,
            }),
          }),
        ];
      }
      default:
        return [];
    }
  },

  /** Asks the server to interrupt the current turn. The worker kills afterwards. */
  interrupt(child, state) {
    if (state.rpc && state.threadId && state.turnId) {
      state.rpc.write({
        jsonrpc: "2.0",
        id: state.rpc.nextId++,
        method: "turn/interrupt",
        params: { threadId: state.threadId, turnId: state.turnId },
      });
      return true;
    }
    return false;
  },

  finalize(state, exitCode) {
    let status;
    let error = null;
    if (state.turnStatus === "completed") status = "completed";
    else if (state.turnStatus === "interrupted") {
      status = "cancelled";
      error = "Codex turn interrupted";
    } else {
      status = "failed";
      error = String(
        state.error ??
          `Codex app-server exited with code ${exitCode ?? "unknown"} before the turn completed`,
      ).slice(0, 500);
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

async function handleServerRequest(message, state) {
  const { rpc, ctx } = state;
  const method = message.method;
  const params = message.params ?? {};
  const spec = APPROVAL_METHODS[method];
  if (!spec) {
    rpc?.respondError(
      message.id,
      -32601,
      `Agent Space does not support ${method}`,
    );
    ctx?.emit?.(
      event(PROVIDER, {
        sessionId: state.sessionId ?? null,
        timestamp: Date.now(),
        kind: "status",
        provenance: "system",
        summary: `Declined unsupported Codex request ${method}`,
        data: { method },
      }),
    );
    return;
  }
  const { kind, payload, summary } = describeRequest(method, params, state);
  const services = ctx?.services ?? {};
  const providerRef = String(
    params.approvalId ?? params.itemId ?? params.callId ?? message.id,
  );
  let approved = false;
  let reason = null;
  let approvalId = null;
  if (!services.approvals?.request) {
    reason =
      "Approval service unavailable; Agent Space denies provider requests it cannot route to a person";
  } else {
    try {
      const approval = await services.approvals.request({
        workspaceId: ctx.run?.workspaceId,
        runId: ctx.run?.id,
        taskId: ctx.run?.taskId,
        kind,
        payload,
        reason: summary,
        provider: PROVIDER,
        providerRef,
        expiresInMs: ctx.approvalTimeoutMs ?? null,
      });
      approvalId = approval?.id ?? null;
      const decided = services.approvals.wait
        ? await services.approvals.wait(
            approvalId,
            ctx.approvalTimeoutMs ?? 10 * 60 * 1000,
          )
        : approval;
      approved =
        decided?.decision === "approve" ||
        decided?.status === "approved" ||
        decided?.approved === true;
      reason =
        decided?.note ??
        decided?.reason ??
        (approved
          ? null
          : `Decision: ${decided?.decision ?? decided?.status ?? "none"}`);
    } catch (error) {
      approved = false;
      reason = `Approval failed: ${error.message}`;
    }
  }
  if (spec.kind === "question") approved = false; // no answer text available; empty answers either way
  rpc?.respond(message.id, responseFor(spec, approved, params));
  ctx?.emit?.(
    event(PROVIDER, {
      providerEventId: `${PROVIDER}:approval:${state.sessionId ?? "?"}:${providerRef}:decision`,
      sessionId: state.sessionId ?? null,
      timestamp: Date.now(),
      kind: "approval.decision",
      provenance: approvalId ? "user" : "system",
      summary: `${approved ? "Approved" : "Denied"}: ${summary}${reason ? ` — ${clip(reason, 100)}` : ""}`,
      data: smallData({ method, kind, approved, approvalId, reason, payload }),
    }),
  );
}

export default codexAppServerAdapter;
