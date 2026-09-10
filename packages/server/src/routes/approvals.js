import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Approval + inbox routes. Register BEFORE routes/workspaces.js.
 *   GET  /api/approvals?status=pending&workspace=&run=
 *   GET  /api/approvals/:id
 *   POST /api/approvals/:id/decide { decision:'approve'|'deny', note?, payloadHash?, actor? }
 *        A declared non-human actor ('mcp') needs settings mcp.allowDecisions.
 *   GET  /api/inbox?workspace=
 */

/** The setting that gates non-human decisions. Mirrors mcp/tools.js. */
const MCP_DECISION_SETTING = "mcp.allowDecisions";

/** Actor names that mean "not a person at this keyboard". */
const NON_HUMAN_ACTORS = new Set(["mcp", "agent", "bot", "automation"]);

/**
 * Caller-supplied actor text with control characters removed. The value ends
 * up in the audit log, whose hash chain and CSV export both treat it as plain
 * text.
 */
function plainActor(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out.trim().slice(0, 60);
}

export default async function approvalRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;
  if (!path.startsWith("/api/approvals") && path !== "/api/inbox") return false;
  const approvals = services.approvals;
  if (!approvals)
    throw new InputError("Approvals are not enabled on this server", 503);

  if (method === "GET" && path === "/api/inbox") {
    send(200, approvals.inbox({ workspaceId: query.get("workspace") || null }));
    return true;
  }
  if (method === "GET" && path === "/api/approvals") {
    send(
      200,
      approvals.list({
        status: query.get("status") || null,
        workspaceId: query.get("workspace") || null,
        runId: query.get("run") || null,
        limit: query.get("limit") ? Number(query.get("limit")) : 200,
      }),
    );
    return true;
  }
  const single = path.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === "GET" && single) {
    send(200, approvals.get(decodeURIComponent(single[1])));
    return true;
  }
  const decide = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (method === "POST" && decide) {
    const input = (await body()) ?? {};
    // A declared non-human actor (the MCP bridge sends actor "mcp") is gated
    // HERE, not only in the MCP client. The tool's own check is a friendlier
    // early refusal, but it runs inside the client process; the policy has to
    // be enforced server-side (ARCHITECTURE.md §0 rule 5).
    const declared =
      input.actor === undefined || input.actor === null
        ? null
        : plainActor(input.actor);
    if (declared !== null) {
      if (!declared) throw new InputError("actor must be a short name", 400);
      if (
        NON_HUMAN_ACTORS.has(declared.toLowerCase()) &&
        services.settings?.get?.(MCP_DECISION_SETTING, false) !== true
      )
        throw new InputError(
          `Refused: ${MCP_DECISION_SETTING} is not enabled on this Agent Space. Approving an agent's action is a human decision; turn the setting on in Settings if you want MCP clients to decide.`,
          403,
        );
    }
    const approval = approvals.decide(decodeURIComponent(decide[1]), {
      decision: input.decision,
      note: input.note ?? null,
      payloadHash: input.payloadHash ?? null,
      actor: declared ? `${actor}:${declared}` : actor,
    });
    send(200, approval);
    return true;
  }
  return false;
}
