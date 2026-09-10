/**
 * Connector registry — the foundation wave of the roadmap's connector order:
 * local files, Git, then GitHub. Each connector is one object with the same
 * shape, so a caller (HTTP route, MCP tool, future UI) never special-cases a
 * source:
 *
 *   { id, name, kind,
 *     detect()                      → { available, reason, ... }
 *     capabilities()                → { reads[], writes[], notes[], ... }
 *     read(op, params)              → JSON result
 *     write(op, params, { approval })→ JSON result, or a refusal }
 *
 * Honesty rules that shape this module:
 *  - Availability is measured by asking the tool itself, never assumed. A
 *    connector that cannot be used answers { available: false, reason } and
 *    every call to it refuses with that same reason.
 *  - Reads never leave the workspace folder root and never return secrets.
 *  - Writes are refused unless (a) the connector declares the op, (b) the
 *    workspace policy allows the equivalent command, and (c) an APPROVED
 *    approval is bound to the exact request. Every write is audited.
 *  - Nothing here executes a shell string; every child process gets an
 *    argument array and a timeout (see git.js / github.js).
 *
 * Deferred on purpose, and recorded as such in docs/ROADMAP_STATUS.md:
 * GitLab, hosted CI providers other than GitHub checks, document tools,
 * databases, and notification targets. They need accounts this machine does
 * not have, so they are absent rather than stubbed.
 */
import { createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { createFilesystemConnector } from "./filesystem.js";
import { createGitConnector } from "./git.js";
import { createGithubConnector } from "./github.js";

/** Connector ids in the roadmap's order. */
export const CONNECTOR_ORDER = Object.freeze(["filesystem", "git", "github"]);

/**
 * The command each write op is equivalent to, for the policy engine. A draft
 * pull request pushes a branch, so it is judged as `git push`.
 */
export const WRITE_COMMAND = Object.freeze({
  createDraftPr: "git push",
});

/** Stable hash of a write request, so an approval binds to what was asked. */
export function requestHash(connectorId, op, params) {
  const canonical = JSON.stringify(
    { connectorId, op, params: params ?? {} },
    (key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((name) => [name, value[name]]),
          )
        : value,
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export class ConnectorRegistry {
  constructor(services, options = {}) {
    this.services = services;
    this.connectors = new Map([
      ["filesystem", createFilesystemConnector(services, options)],
      ["git", createGitConnector(services, options)],
      ["github", createGithubConnector(services, options)],
    ]);
  }

  ids() {
    return [...this.connectors.keys()];
  }

  connector(id) {
    const connector = this.connectors.get(String(id ?? ""));
    if (!connector)
      throw new InputError(
        `Unknown connector “${id}”. This build has: ${this.ids().join(", ")}.`,
        404,
      );
    return connector;
  }

  /** Every connector with its measured availability (one probe each). */
  async list() {
    const rows = [];
    for (const connector of this.connectors.values()) {
      let detect;
      try {
        detect = await connector.detect();
      } catch (error) {
        detect = { available: false, reason: error?.message ?? String(error) };
      }
      rows.push({
        id: connector.id,
        name: connector.name,
        kind: connector.kind,
        available: Boolean(detect.available),
        reason: detect.reason ?? null,
        version: detect.version ?? null,
      });
    }
    return rows;
  }

  async capabilities(id) {
    return this.connector(id).capabilities();
  }

  async read(id, op, params = {}) {
    const connector = this.connector(id);
    if (!op) throw new InputError("op is required");
    return connector.read(op, params ?? {});
  }

  /**
   * Policy- and approval-gated write.
   *
   * Without `approvalId` this creates a PENDING approval and returns
   * { status: "pending", approval } — nothing is sent to the connector. With
   * an `approvalId` the approval must be approved and bound (by hash) to this
   * exact connector/op/params, or the write is refused.
   */
  async write(
    id,
    op,
    params = {},
    { approvalId = null, actor = "local-user", reason = null } = {},
  ) {
    const connector = this.connector(id);
    const capabilities = await connector.capabilities();
    if (!(capabilities.writes ?? []).includes(op))
      throw new InputError(
        `Connector “${id}” does not support the write “${op}”. Supported writes: ${(capabilities.writes ?? []).join(", ") || "none (this connector is read-only)"}.`,
        405,
      );
    if (!capabilities.available)
      throw new InputError(
        `Connector “${id}” is not available: ${capabilities.reason}.`,
        503,
      );
    const workspaceId = params?.workspaceId ?? null;
    if (!workspaceId) throw new InputError("workspaceId is required");

    // 1. Server-side policy. A refusal here is final, whatever the UI shows.
    const command = WRITE_COMMAND[op] ?? op;
    const verdict = this.services.policy?.evaluate?.({
      workspaceId,
      request: { kind: "command", command },
    });
    if (verdict && verdict.decision === "deny") {
      this.services.audit?.record?.({
        actor,
        action: "connector.write.denied",
        target: `${id}.${op}`,
        workspaceId,
        policyDecision: "deny",
        details: { rule: verdict.rule, reason: verdict.reason },
      });
      throw new InputError(
        `Workspace policy denies “${command}”, so ${id}.${op} is refused: ${verdict.reason}`,
        403,
      );
    }

    const hash = requestHash(id, op, params);
    const approvals = this.services.approvals;

    // 2. No approval yet: create one and stop. Approvals belong to a run, so
    // the caller must name the run this write belongs to.
    if (!approvalId) {
      if (!approvals)
        throw new InputError(
          "Approvals are not available in this container, so a connector write cannot be authorized.",
          503,
        );
      if (!params.runId)
        throw new InputError(
          "A connector write must belong to a run: pass runId so the approval can be recorded against it.",
          400,
        );
      const approval = approvals.request({
        workspaceId,
        runId: params.runId,
        kind: "command",
        payload: {
          connector: id,
          op,
          command,
          params,
          requestHash: hash,
        },
        reason:
          reason ??
          `Connector write ${id}.${op} (equivalent to “${command}”) requested by ${actor}`,
        actor,
      });
      return {
        status: "pending",
        approval,
        requestHash: hash,
        note: "Nothing was sent yet. Decide this approval, then repeat the call with its approvalId.",
      };
    }

    // 3. An approval was named: it must be approved and bound to this request.
    if (!approvals)
      throw new InputError(
        "Approvals are not available in this container",
        503,
      );
    const approval = approvals.get(approvalId);
    if (!approval) throw new InputError("Approval not found", 404);
    if (approval.status !== "approved")
      throw new InputError(
        `Approval ${approvalId} is ${approval.status}, not approved; the write was refused.`,
        403,
      );
    if (approval.payload?.requestHash !== hash)
      throw new InputError(
        "The approved request is not the one being executed (payload hash mismatch); refused.",
        409,
      );

    const result = await connector.write(op, params, { approval });
    this.services.audit?.record?.({
      actor,
      action: `connector.write.${id}.${op}`,
      target: `${id}.${op}`,
      workspaceId,
      runId: params.runId ?? null,
      policyDecision: verdict?.decision ?? null,
      details: { requestHash: hash, approvalId, result },
    });
    return { status: "done", result, approvalId, requestHash: hash };
  }

  /**
   * CI/CD status read-through: GitHub checks for the workspace's current
   * branch. Degrades to { available: false, reason } whenever gh or git is
   * missing, unauthenticated, or the branch has no pull request — it never
   * invents a green build.
   */
  async checks(workspaceId) {
    const github = this.connector("github");
    const detected = await github.detect();
    if (!detected.available)
      return {
        available: false,
        reason: detected.reason,
        provider: "github",
        branch: null,
        checks: [],
      };
    let branch = null;
    try {
      const status = await this.connector("git").read("branch", {
        workspaceId,
      });
      branch = status.current ?? null;
    } catch (error) {
      return {
        available: false,
        reason: `the current branch could not be read: ${error.message}`,
        provider: "github",
        branch: null,
        checks: [],
      };
    }
    try {
      const result = await github.read("checks", { workspaceId, ref: branch });
      return {
        available: true,
        provider: "github",
        source: "gh pr checks",
        branch,
        checks: result.checks,
        count: result.count,
      };
    } catch (prError) {
      try {
        const runs = await github.read("checkRuns", {
          workspaceId,
          ref: branch,
        });
        return {
          available: true,
          provider: "github",
          source: "gh api check-runs",
          branch,
          checks: runs.checkRuns,
          count: runs.checkRuns.length,
        };
      } catch (apiError) {
        return {
          available: false,
          provider: "github",
          branch,
          reason: `GitHub reported no checks for ${branch}: ${prError.message}; check-runs also failed: ${apiError.message}`,
          checks: [],
        };
      }
    }
  }
}

/**
 * Factory. Attaches `services.connectorRegistry` when it is not already set.
 * Composition in packages/core/src/services.js is optional: routes and the
 * MCP bridge create the registry lazily when the container has none.
 */
export function createConnectorRegistry(services, options = {}) {
  const registry = new ConnectorRegistry(services, options);
  services.connectorRegistry ??= registry;
  return services.connectorRegistry;
}

export default createConnectorRegistry;
