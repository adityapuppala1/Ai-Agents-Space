/**
 * MCP tools exposed by Agent Space.
 *
 * Every tool is a thin, honest view of the HTTP API a running Agent Space
 * already serves. Nothing here reads SQLite: the MCP server talks to the
 * server over HTTP so it can never contend for the database lock, and so a
 * tool can never see state the API would not show.
 *
 * Honesty rules that shape this module:
 *  - A tool that changes state says so in its description and its
 *    `annotations.readOnlyHint` is false. Everything else is read-only.
 *  - `decide_approval` is GATED: it refuses unless the server setting
 *    `mcp.allowDecisions` is true, because approving an agent's action is a
 *    human decision. When it does run, it names `mcp` as the actor so the
 *    audit log and the approval record say where the decision came from.
 *  - Creating a task and deciding an approval go through the same routes as
 *    the UI, so the same server-side policy applies. A refusal is returned as
 *    the tool's own error text, never swallowed.
 *  - Results are JSON text; no field is invented or reformatted into a claim
 *    the API did not make.
 */

/** Setting that must be true before an MCP client may decide an approval. */
export const DECISION_SETTING = "mcp.allowDecisions";

const workspaceId = {
  type: "string",
  description: "Workspace id (see list_workspaces).",
};

function json(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function matchesStatus(row, status) {
  if (!status) return true;
  return String(row?.status ?? "").toLowerCase() === status.toLowerCase();
}

/** The tool list. Order is stable so a client can cache it. */
export const TOOLS = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description:
      "Lists every Agent Space workspace with its folder root, theme, active run count and attention count. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client) {
      return json(await client.get("/api/workspaces"));
    },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "Lists the tasks of one workspace, optionally filtered by status. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId,
        status: {
          type: "string",
          description:
            "Optional status filter, matched case-insensitively against the stored task status.",
        },
      },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const id = requireString(args, "workspaceId");
      const tasks = await client.get(
        `/api/workspaces/${encodeURIComponent(id)}/tasks`,
      );
      const filtered = (Array.isArray(tasks) ? tasks : []).filter((task) =>
        matchesStatus(task, args.status),
      );
      return json({ workspaceId: id, count: filtered.length, tasks: filtered });
    },
  },
  {
    name: "get_task",
    title: "Get one task",
    description:
      "Returns one task of a workspace, including dependencies, target, provider and review state. Read-only.",
    inputSchema: {
      type: "object",
      properties: { workspaceId, taskId: { type: "string" } },
      required: ["workspaceId", "taskId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const id = requireString(args, "workspaceId");
      const taskId = requireString(args, "taskId");
      const tasks = await client.get(
        `/api/workspaces/${encodeURIComponent(id)}/tasks`,
      );
      const task = (Array.isArray(tasks) ? tasks : []).find(
        (row) => row.id === taskId,
      );
      if (!task) throw new Error(`Task ${taskId} not found in ${id}`);
      return json(task);
    },
  },
  {
    name: "create_task",
    title: "Create a task",
    description:
      "CREATES a task in a workspace. This changes Agent Space state. It does not start a run; the same server-side validation and policy as the web UI apply.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId,
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        provider: {
          type: "string",
          description:
            "Optional provider id (claude-code, codex, copilot, cursor, gemini).",
        },
        deliverable: { type: "string" },
      },
      required: ["workspaceId", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(client, args = {}) {
      const id = requireString(args, "workspaceId");
      const body = {
        title: requireString(args, "title"),
        description: args.description ?? "",
      };
      if (args.priority) body.priority = args.priority;
      if (args.provider) body.provider = args.provider;
      if (args.deliverable) body.deliverable = args.deliverable;
      return json(
        await client.post(
          `/api/workspaces/${encodeURIComponent(id)}/tasks`,
          body,
        ),
      );
    },
  },
  {
    name: "list_runs",
    title: "List runs",
    description:
      "Lists the runs of one workspace (observed and managed), optionally filtered by status. Read-only.",
    inputSchema: {
      type: "object",
      properties: { workspaceId, status: { type: "string" } },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const id = requireString(args, "workspaceId");
      const runs = await client.get(
        `/api/workspaces/${encodeURIComponent(id)}/runs`,
      );
      const filtered = (Array.isArray(runs) ? runs : []).filter((run) =>
        matchesStatus(run, args.status),
      );
      return json({ workspaceId: id, count: filtered.length, runs: filtered });
    },
  },
  {
    name: "get_run",
    title: "Get one run",
    description:
      "Returns one run with its artifacts, approvals and context. Set includeEvents to also return the recorded events with their provenance. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        includeEvents: { type: "boolean", default: false },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const runId = requireString(args, "runId");
      const payload = await client.get(
        `/api/runs/${encodeURIComponent(runId)}`,
      );
      if (args.includeEvents) return json(payload);
      const { events, ...rest } = payload ?? {};
      return json({
        ...rest,
        eventCount: Array.isArray(events) ? events.length : 0,
        note: "Events omitted; call again with includeEvents: true.",
      });
    },
  },
  {
    name: "list_live_sessions",
    title: "List live provider sessions",
    description:
      "Lists provider sessions Agent Space is observing right now (Claude Code, Codex, Copilot, Cursor, Gemini). Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client) {
      return json(await client.get("/api/sessions?live=1"));
    },
  },
  {
    name: "get_inbox",
    title: "Get the decision inbox",
    description:
      "Returns everything waiting for a human: pending approvals, failed/stale/disconnected runs, tasks awaiting review, and provider questions. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          ...workspaceId,
          description: "Optional workspace filter.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const suffix = args.workspaceId
        ? `?workspace=${encodeURIComponent(args.workspaceId)}`
        : "";
      return json(await client.get(`/api/inbox${suffix}`));
    },
  },
  {
    name: "decide_approval",
    title: "Decide a pending approval (gated)",
    description:
      "APPROVES or DENIES a pending approval, which resumes or refuses a waiting provider action. This is a human decision: it is refused unless the Agent Space setting mcp.allowDecisions is true, and every decision is recorded with the actor 'mcp'.",
    gated: true,
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
        note: { type: "string" },
      },
      required: ["approvalId", "decision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler(client, args = {}) {
      const approvalId = requireString(args, "approvalId");
      const decision = requireString(args, "decision");
      if (!["approve", "deny"].includes(decision))
        throw new Error("decision must be 'approve' or 'deny'");
      const settings = await client.get("/api/settings");
      if (settings?.[DECISION_SETTING] !== true)
        throw new Error(
          `Refused: ${DECISION_SETTING} is not enabled on this Agent Space. Approving an agent's action is a human decision; turn the setting on in Settings if you want MCP clients to decide.`,
        );
      const result = await client.post(
        `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
        { decision, note: args.note ?? null, actor: "mcp" },
      );
      return json({
        decidedBy: "mcp",
        setting: DECISION_SETTING,
        approval: result,
      });
    },
  },
  {
    name: "search_events",
    title: "Search recorded events",
    description:
      "Full-text search over the events Agent Space has recorded (never the filesystem). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        workspaceId: {
          ...workspaceId,
          description: "Optional workspace filter.",
        },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const query = requireString(args, "query");
      const params = new URLSearchParams({ q: query, kinds: "events" });
      if (args.workspaceId) params.set("workspace", args.workspaceId);
      params.set("limit", String(args.limit ?? 25));
      return json(await client.get(`/api/search?${params.toString()}`));
    },
  },
  {
    name: "get_analytics",
    title: "Get analytics",
    description:
      "Returns the funnel, time breakdown, provider usage and reliability numbers. Every figure is labelled reported or estimated; nothing is inferred. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          ...workspaceId,
          description: "Optional workspace filter.",
        },
        since: {
          type: "string",
          description:
            "Optional epoch-milliseconds or ISO timestamp lower bound.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(client, args = {}) {
      const params = new URLSearchParams();
      if (args.workspaceId) params.set("workspace", args.workspaceId);
      if (args.since) params.set("since", String(args.since));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return json(await client.get(`/api/analytics${suffix}`));
    },
  },
];

/** The `tools/list` payload: name, description and schema only. */
export function toolDescriptors(tools = TOOLS) {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

export function findTool(name, tools = TOOLS) {
  return tools.find((tool) => tool.name === name) ?? null;
}
