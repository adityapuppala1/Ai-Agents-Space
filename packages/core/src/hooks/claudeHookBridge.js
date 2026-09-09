import { createHash } from "node:crypto";
import { basename } from "node:path";
import { classifyTool, makeEvent, isSecretPath } from "../contracts.js";
import { InputError } from "../TaskStore.js";
import { redactSecrets } from "../audit/Audit.js";
import {
  findRisky,
  isWithin,
  normalizePath,
  samePath,
} from "../policy/Policy.js";

const PROVIDER = "claude-code";
const AGENT_NAME = "Claude Code";
const AGENT_COLOR = "#d97757";
const OBSERVED_WORKSPACE_ID = "observed";
/** Per-field cap for approval payloads (the hook body itself is 256 KB). */
const APPROVAL_FIELD_LIMIT = 262144;

const FILE_TOOLS = /^(edit|write|multiedit|notebookedit|read)$/i;
const SHELL_TOOLS = /^(bash|powershell)$/i;
const NETWORK_TOOLS = /^(webfetch|websearch)$/i;
const SEARCH_TOOLS = /^(glob|grep|ls)$/i;
const DELEGATE_TOOLS = /^(task|agent)$/i;
const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit)$/i;

function short(text, max = 120) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function hashOf(value) {
  return createHash("sha1")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Keeps tool_input small enough for the events/approvals tables. Pass
 * `truncated` (an array) to learn which fields were cut.
 */
export function truncateToolInput(input, limit = 2000, truncated = null) {
  if (!input || typeof input !== "object") return input ?? {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      if (value.length > limit) {
        out[key] = value.slice(0, limit) + "…[truncated]";
        truncated?.push(key);
      } else out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20);
      if (value.length > 20) truncated?.push(key);
    } else if (value && typeof value === "object") {
      if (JSON.stringify(value).length > limit) {
        out[key] = { truncated: true };
        truncated?.push(key);
      } else out[key] = value;
    } else out[key] = value;
  }
  return out;
}

const CONTENT_FIELDS = ["content", "new_string", "old_string", "edits"];

/**
 * Tool input as stored on events: secret-looking keys redacted and, when the
 * call touches a credential file or dumps the environment, the content
 * fields dropped entirely (rule 4: secrets never reach the database).
 */
function safeToolInput(toolInput, { secretTarget = false } = {}) {
  const out = redactSecrets(toolInput ?? {});
  if (secretTarget && out && typeof out === "object")
    for (const field of CONTENT_FIELDS)
      if (field in out) out[field] = "[omitted: secret path]";
  return out;
}

function touchesSecret(toolName, toolInput = {}) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const file = fileOf(input);
  if (file && isSecretPath(file)) return true;
  if (SHELL_TOOLS.test(String(toolName ?? "")))
    return findRisky(String(input.command ?? ""))?.id === "env-dump";
  return false;
}

function sha256(text) {
  return createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex");
}

/** Builds the policy request for a Claude Code tool call. */
export function requestFromTool(toolName, toolInput = {}, cwd = null) {
  const tool = String(toolName ?? "");
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (SHELL_TOOLS.test(tool))
    return { kind: "command", tool, command: String(input.command ?? ""), cwd };
  if (FILE_TOOLS.test(tool))
    return {
      kind: "file",
      tool,
      path: String(input.file_path ?? input.notebook_path ?? input.path ?? ""),
      access: WRITE_TOOLS.test(tool) ? "write" : "read",
      cwd,
    };
  if (NETWORK_TOOLS.test(tool))
    return {
      kind: "network",
      tool,
      url: input.url ?? null,
      query: input.query ?? null,
      cwd,
    };
  return { kind: "tool", tool, cwd };
}

/** Normalized event kind for a tool start. */
export function kindForTool(toolName, toolInput = {}) {
  const tool = String(toolName ?? "");
  if (WRITE_TOOLS.test(tool)) return "file.edit";
  if (/^read$/i.test(tool)) return "file.read";
  if (SEARCH_TOOLS.test(tool)) return "search";
  if (NETWORK_TOOLS.test(tool)) return "web";
  if (SHELL_TOOLS.test(tool))
    return classifyTool(tool, toolInput) === "TESTING" ? "test" : "command";
  if (DELEGATE_TOOLS.test(tool)) return "delegation";
  return "tool.start";
}

function fileOf(toolInput = {}) {
  const f =
    toolInput?.file_path ?? toolInput?.notebook_path ?? toolInput?.path ?? null;
  return f ? String(f).slice(0, 500) : null;
}

function describeTool(toolName, toolInput = {}) {
  const tool = String(toolName ?? "tool");
  const input = toolInput ?? {};
  if (SHELL_TOOLS.test(tool)) return `${tool}: ${short(input.command, 100)}`;
  const file = fileOf(input);
  if (file) return `${tool} ${basename(file)}`;
  if (input.pattern) return `${tool} ${short(input.pattern, 80)}`;
  if (input.url) return `${tool} ${short(input.url, 90)}`;
  if (input.query) return `${tool} “${short(input.query, 80)}”`;
  if (input.prompt) return `${tool}: ${short(input.prompt, 90)}`;
  if (input.description) return `${tool}: ${short(input.description, 90)}`;
  return tool;
}

function decision(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

/**
 * Turns Claude Code hook payloads into run events, policy decisions, and
 * approvals. `handleHook(payload)` never throws; on an internal error it
 * audits and returns `{ status: 200, body: {} }` so Claude Code keeps working.
 */
export function createHookBridge(services, { now = Date.now } = {}) {
  const { db, hub } = services;

  function audit(entry) {
    try {
      services.audit?.record({ actor: "hook:claude-code", ...entry });
    } catch {
      /* auditing must never block the hook */
    }
  }

  function settingsGet(key, fallback) {
    try {
      const value = services.settings?.get(key);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function findWorkspaceByCwd(cwd) {
    if (!cwd) return null;
    const mapped =
      services.observation?.mapping?.workspaceFor?.(cwd) ??
      services.observation?.mapping?.resolve?.(cwd) ??
      services.observation?.workspaceFor?.(cwd) ??
      null;
    if (mapped) {
      const id =
        typeof mapped === "string" ? mapped : (mapped.id ?? mapped.workspaceId);
      if (id && hub.has(id)) return id;
    }
    let best = null;
    for (const ws of hub.list()) {
      if (!ws.rootPath) continue;
      if (samePath(ws.rootPath, cwd)) return ws.id;
      if (isWithin(cwd, ws.rootPath)) {
        const depth = normalizePath(ws.rootPath).length;
        if (!best || depth > best.depth) best = { id: ws.id, depth };
      }
    }
    return best?.id ?? null;
  }

  function ensureObservedWorkspace() {
    if (!hub.has(OBSERVED_WORKSPACE_ID)) {
      db.prepare(
        "INSERT OR IGNORE INTO workspaces (id, name, kind, created_at, auto_created) VALUES (?, 'Observed sessions', 'project', ?, 1)",
      ).run(OBSERVED_WORKSPACE_ID, now());
      hub.emit("workspaces");
    }
    return OBSERVED_WORKSPACE_ID;
  }

  function resolveWorkspace(cwd) {
    const found = findWorkspaceByCwd(cwd);
    if (found) return found;
    if (cwd && settingsGet("observation.autoCreateWorkspaces", true)) {
      const name = basename(cwd.replace(/[\\/]+$/, "")) || cwd;
      const record = hub.create({ name: name.slice(0, 80), rootPath: cwd });
      db.prepare("UPDATE workspaces SET auto_created = 1 WHERE id = ?").run(
        record.id,
      );
      audit({
        action: "workspace.autoCreate",
        target: `workspace:${record.id}`,
        workspaceId: record.id,
        details: { cwd },
      });
      return record.id;
    }
    return ensureObservedWorkspace();
  }

  function providerAgents(workspaceId) {
    return db
      .prepare(
        "SELECT id, name FROM agent_profiles WHERE workspace_id = ? AND provider = ? AND archived_at IS NULL ORDER BY position",
      )
      .all(workspaceId, PROVIDER);
  }

  function createAgent(workspaceId, index) {
    const workspace = hub.get(workspaceId);
    const name = index > 1 ? `${AGENT_NAME} ${index}` : AGENT_NAME;
    const agent = workspace.createAgent({
      name,
      role: "Coding assistant",
      color: AGENT_COLOR,
      specialty: "Anthropic Claude Code session",
      workingState: "CODING",
    });
    db.prepare(
      "UPDATE agent_profiles SET provider = ?, auto_created = 1 WHERE id = ?",
    ).run(PROVIDER, agent.id);
    return agent;
  }

  function busy(workspaceId, agentId) {
    return !!db
      .prepare(
        "SELECT id FROM tasks WHERE workspace_id = ? AND assigned_agent_id = ? AND status IN ('IN_PROGRESS','BLOCKED') LIMIT 1",
      )
      .get(workspaceId, agentId);
  }

  function pickAgent(workspaceId) {
    const agents = providerAgents(workspaceId);
    const free = agents.find((a) => !busy(workspaceId, a.id));
    if (free) return free;
    return createAgent(workspaceId, agents.length + 1);
  }

  function ensureRun(payload) {
    const recorder = services.recorder;
    if (!recorder) throw new Error("services.recorder is not available");
    const sessionId = String(payload.session_id);
    let run = recorder.find({
      provider: PROVIDER,
      providerSessionId: sessionId,
    });
    if (run) {
      if (
        ["completed", "failed", "cancelled", "disconnected", "stale"].includes(
          run.status,
        )
      ) {
        run = recorder.update(run.id, {
          status: "running",
          endedAt: null,
          activity: null,
        });
        // A revived session must not leave its task COMPLETED, or the
        // agent card shows IDLE and the run's activity stays invisible.
        db.prepare(
          "UPDATE tasks SET status = 'IN_PROGRESS', completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'COMPLETED'",
        ).run(now(), run.taskId);
      }
      return run;
    }
    const cwd = payload.cwd ? String(payload.cwd) : null;
    const workspaceId = resolveWorkspace(cwd);
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const agent = pickAgent(workspaceId);
      try {
        return recorder.ensureRun({
          workspaceId,
          agentId: agent.id,
          mode: "observed",
          provider: PROVIDER,
          providerSessionId: sessionId,
          cwd,
          sourcePath: payload.transcript_path
            ? String(payload.transcript_path)
            : null,
          createTask: {
            title: `Claude Code session ${sessionId.slice(0, 8)}`,
            source: "observed",
          },
          context: {
            source: "hook",
            permissionMode: payload.permission_mode ?? null,
          },
          configSnapshot: { source: "hook", entrypoint: "claude-code hook" },
          startedAt: now(),
        });
      } catch (error) {
        lastError = error;
        if (!(error instanceof InputError && error.status === 409)) throw error;
        createAgent(workspaceId, providerAgents(workspaceId).length + 1);
      }
    }
    throw lastError ?? new Error("Could not create a run for the hook session");
  }

  function eventId(payload, suffix) {
    const base = payload.tool_use_id ?? payload.tool_call_id ?? null;
    const key =
      base ??
      hashOf([
        payload.hook_event_name,
        payload.tool_name,
        payload.tool_input,
        now(),
      ]);
    return `hook:${payload.session_id}:${key}${suffix ? `:${suffix}` : ""}`;
  }

  function record(run, event) {
    return services.recorder.applyEvent(
      run.id,
      makeEvent({
        provider: PROVIDER,
        sessionId: run.providerSessionId,
        cwd: run.cwd,
        timestamp: now(),
        provenance: "provider",
        ...event,
      }),
    );
  }

  function promptCount(runId) {
    return db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND kind = 'prompt'",
      )
      .get(runId).n;
  }

  async function preToolUse(payload, run) {
    const toolName = String(payload.tool_name ?? "");
    const secretTarget = touchesSecret(toolName, payload.tool_input ?? {});
    const toolInput = safeToolInput(
      truncateToolInput(payload.tool_input ?? {}),
      { secretTarget },
    );
    const request = requestFromTool(
      toolName,
      payload.tool_input ?? {},
      run.cwd,
    );
    const kind = kindForTool(toolName, payload.tool_input ?? {});
    const summary = describeTool(toolName, payload.tool_input ?? {});
    let evaluation;
    try {
      evaluation = services.policy
        ? services.policy.evaluate({
            workspaceId: run.workspaceId,
            runId: run.id,
            request,
          })
        : {
            decision: "allow",
            rule: "policy.absent",
            reason: "No policy engine attached; not evaluated.",
          };
    } catch (error) {
      evaluation = {
        decision: "allow",
        rule: "policy.error",
        reason: `Policy evaluation failed: ${error.message}`,
      };
      audit({
        action: "hook.policyError",
        runId: run.id,
        workspaceId: run.workspaceId,
        details: { error: error.message, request },
      });
    }
    record(run, {
      providerEventId: eventId(payload, "pre"),
      kind,
      tool: toolName,
      file: fileOf(toolInput),
      summary,
      data: {
        hook: "PreToolUse",
        tool_input: toolInput,
        toolUseId: payload.tool_use_id ?? null,
        policy: {
          decision: evaluation.passthrough
            ? "passthrough"
            : evaluation.decision,
          rule: evaluation.rule,
          reason: evaluation.reason,
        },
      },
    });
    // Observe-only workspaces are watched, never decided for: no decision
    // means Claude Code keeps its own permission prompts.
    if (evaluation.passthrough) return {};
    const passThrough = settingsGet("hooks.claudeCode.passThroughAllow", false);
    if (evaluation.decision === "allow")
      return passThrough
        ? {}
        : decision(
            "allow",
            `Agent Space policy ${evaluation.rule}: ${evaluation.reason}`,
          );
    if (evaluation.decision === "deny") {
      audit({
        action: "hook.deny",
        runId: run.id,
        workspaceId: run.workspaceId,
        policyDecision: "deny",
        details: {
          tool: toolName,
          rule: evaluation.rule,
          reason: evaluation.reason,
          request,
        },
      });
      return decision(
        "deny",
        `Agent Space policy ${evaluation.rule}: ${evaluation.reason}`,
      );
    }
    // ask → approval in the inbox, long-poll until decided or the hook deadline.
    if (!services.approvals)
      return decision(
        "deny",
        `Agent Space policy ${evaluation.rule}: ${evaluation.reason} (no approval service attached)`,
      );
    const timeoutSeconds =
      Number(settingsGet("hooks.claudeCode.timeoutSeconds", 300)) || 300;
    const timeoutMs = Math.max(1000, timeoutSeconds * 1000 - 5000);
    // The person approves the exact text that will run: the command is kept
    // whole (not the 2000-char preview stored on events) and hashed so a
    // truncated payload can never be approved by mistake.
    const truncatedFields = [];
    const approvalInput = safeToolInput(
      truncateToolInput(
        payload.tool_input ?? {},
        APPROVAL_FIELD_LIMIT,
        truncatedFields,
      ),
      { secretTarget },
    );
    const approvalPayload = {
      tool_name: toolName,
      tool_input: approvalInput,
      cwd: run.cwd,
      ...requestSummary(request),
    };
    if (request.command !== undefined) {
      approvalPayload.commandSha256 = sha256(request.command);
      approvalPayload.commandLength = String(request.command).length;
    }
    if (truncatedFields.length) approvalPayload.truncated = truncatedFields;
    const approval = services.approvals.request({
      workspaceId: run.workspaceId,
      runId: run.id,
      taskId: run.taskId,
      kind: request.kind,
      payload: approvalPayload,
      reason: evaluation.reason,
      rule: evaluation.rule,
      provider: PROVIDER,
      providerRef: String(payload.session_id),
      expiresInMs: timeoutMs,
      actor: "hook:claude-code",
    });
    const outcome = await services.approvals.wait(approval.id, timeoutMs);
    if (outcome?.status === "approved") {
      const shownCommand = outcome.payload?.command;
      const commandIntact =
        request.command === undefined ||
        (typeof shownCommand === "string" &&
          shownCommand === String(request.command) &&
          !(outcome.payload?.truncated ?? []).includes("command"));
      if (!commandIntact) {
        audit({
          action: "hook.approvalMismatch",
          runId: run.id,
          workspaceId: run.workspaceId,
          policyDecision: "deny",
          details: {
            approvalId: approval.id,
            reason: "approved payload does not carry the exact command",
          },
        });
        return decision(
          "deny",
          "approved in Agent Space, but the reviewer did not see the complete command; refused for safety",
        );
      }
      return decision(
        "allow",
        `approved in Agent Space by ${outcome.decidedBy ?? "a person"}${outcome.payload?._note ? `: ${outcome.payload._note}` : ""}`,
      );
    }
    if (outcome?.status === "denied")
      return decision(
        "deny",
        `denied in Agent Space by ${outcome.decidedBy ?? "a person"}${outcome.payload?._note ? `: ${outcome.payload._note}` : ""}`,
      );
    if (outcome?.status === "cancelled")
      return decision("deny", "approval cancelled in Agent Space (run ended)");
    return decision(
      "deny",
      `no decision in Agent Space within ${Math.round(timeoutMs / 1000)} s; approval expired`,
    );
  }

  function requestSummary(request) {
    const out = {};
    // Whole command, line structure preserved; `commandPreview` is for lists.
    if (request.command) {
      out.command = String(request.command);
      out.commandPreview = short(request.command, 200);
    }
    if (request.path) out.path = request.path;
    if (request.url) out.url = request.url;
    if (request.query) out.query = request.query;
    return out;
  }

  function postToolUse(payload, run) {
    const toolName = String(payload.tool_name ?? "");
    const response = payload.tool_response;
    const isError =
      !!(
        response &&
        typeof response === "object" &&
        (response.is_error || response.isError)
      ) ||
      (typeof response === "string" && /^error:/i.test(response));
    const summary = `${describeTool(toolName, payload.tool_input ?? {})} ${isError ? "failed" : "finished"}`;
    const secretTarget = touchesSecret(toolName, payload.tool_input ?? {});
    let responsePreview = null;
    if (secretTarget) responsePreview = "[omitted: secret path]";
    else if (typeof response === "string")
      responsePreview = short(response, 500);
    else if (response && typeof response === "object")
      responsePreview = short(
        JSON.stringify(redactSecrets(truncateToolInput(response, 500))),
        800,
      );
    record(run, {
      providerEventId: eventId(payload, "post"),
      kind: isError ? "error" : "tool.end",
      tool: toolName,
      file: fileOf(payload.tool_input ?? {}),
      summary: short(summary, 200),
      data: {
        hook: "PostToolUse",
        toolUseId: payload.tool_use_id ?? null,
        isError,
        responsePreview,
      },
    });
    return {};
  }

  function userPromptSubmit(payload, run) {
    const prompt = String(payload.prompt ?? "");
    const first = promptCount(run.id) === 0;
    record(run, {
      providerEventId: `hook:${payload.session_id}:prompt:${hashOf([prompt, now()])}`,
      kind: "prompt",
      summary: `Prompt: ${short(prompt, 110)}`,
      data: { hook: "UserPromptSubmit", prompt: short(prompt, 2000) },
    });
    if (first && prompt.trim()) {
      const title = short(prompt, 80);
      db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?").run(
        title,
        now(),
        run.taskId,
      );
      services.recorder.update(run.id, { title });
      db.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run(
        short(prompt, 4000),
        run.id,
      );
    }
    return {};
  }

  function stop(payload, run) {
    record(run, {
      providerEventId: `hook:${payload.session_id}:stop:${hashOf([payload.stop_hook_active, now()])}`,
      kind: "turn.end",
      summary: "Claude finished responding",
      data: { hook: "Stop" },
    });
    return {};
  }

  function subagentStop(payload, run) {
    record(run, {
      providerEventId: `hook:${payload.session_id}:subagent-stop:${hashOf([payload.agent_id ?? payload.agent_type, now()])}`,
      kind: "delegation",
      summary: `Subagent finished${payload.agent_type ? ` (${short(payload.agent_type, 40)})` : ""}`,
      data: {
        hook: "SubagentStop",
        agentType: payload.agent_type ?? null,
        agentId: payload.agent_id ?? null,
        phase: "end",
      },
    });
    return {};
  }

  function sessionStart(payload, run) {
    record(run, {
      providerEventId: `hook:${payload.session_id}:session-start:${hashOf([payload.source, now()])}`,
      kind: "session.start",
      summary: `Session ${payload.source === "resume" ? "resumed" : "started"}${payload.source ? ` (${short(payload.source, 20)})` : ""}`,
      data: {
        hook: "SessionStart",
        source: payload.source ?? null,
        model: payload.model ?? null,
      },
      model: payload.model ?? null,
    });
    return {};
  }

  function sessionEnd(payload, run) {
    record(run, {
      providerEventId: `hook:${payload.session_id}:session-end:${hashOf([payload.reason, now()])}`,
      kind: "session.end",
      summary: `Session ended${payload.reason ? ` (${short(payload.reason, 40)})` : ""}`,
      data: { hook: "SessionEnd", reason: payload.reason ?? null },
    });
    services.approvals?.cancelForRun?.(run.id, { reason: "session ended" });
    services.recorder.setStatus(run.id, "completed", {
      summary: `Claude Code session ended${payload.reason ? ` (${short(payload.reason, 40)})` : ""}`,
    });
    return {};
  }

  function notification(payload, run) {
    const message = short(
      payload.message ?? payload.title ?? "Notification",
      200,
    );
    record(run, {
      providerEventId: `hook:${payload.session_id}:notification:${hashOf([message, now()])}`,
      kind: "status",
      summary: message,
      data: {
        hook: "Notification",
        notificationType: payload.notification_type ?? null,
      },
      activity: /permission|approval|waiting for your input/i.test(message)
        ? "WAITING_APPROVAL"
        : undefined,
    });
    return {};
  }

  function preCompact(payload, run) {
    record(run, {
      providerEventId: `hook:${payload.session_id}:compact:${hashOf([payload.trigger, now()])}`,
      kind: "status",
      summary: `Context compaction${payload.trigger ? ` (${short(payload.trigger, 20)})` : ""}`,
      data: { hook: "PreCompact", trigger: payload.trigger ?? null },
    });
    return {};
  }

  const handlers = {
    PreToolUse: preToolUse,
    PostToolUse: postToolUse,
    UserPromptSubmit: userPromptSubmit,
    Stop: stop,
    SubagentStop: subagentStop,
    SessionStart: sessionStart,
    SessionEnd: sessionEnd,
    Notification: notification,
    PreCompact: preCompact,
  };

  async function handleHook(payload) {
    try {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        audit({
          action: "hook.invalid",
          details: { reason: "payload is not an object" },
        });
        return { status: 200, body: {} };
      }
      const event = String(payload.hook_event_name ?? "");
      const handler = handlers[event];
      if (!handler) return { status: 200, body: {} };
      if (!payload.session_id || typeof payload.session_id !== "string") {
        audit({
          action: "hook.invalid",
          details: { reason: "missing session_id", event },
        });
        return { status: 200, body: {} };
      }
      const run = ensureRun(payload);
      const body = await handler(payload, run);
      return { status: 200, body: body ?? {} };
    } catch (error) {
      audit({
        action: "hook.error",
        details: {
          event: payload?.hook_event_name ?? null,
          sessionId: payload?.session_id ?? null,
          error: String(error?.message ?? error),
        },
      });
      return { status: 200, body: {} };
    }
  }

  return {
    provider: PROVIDER,
    handleHook,
    resolveWorkspace,
    ensureRun,
    requestFromTool,
    kindForTool,
  };
}
