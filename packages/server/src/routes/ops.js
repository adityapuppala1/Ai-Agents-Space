import { InputError } from "../../../core/src/TaskStore.js";
import {
  IncidentService,
  assertDispatchAllowed,
} from "../../../core/src/ops/Incident.js";
import { BackupService } from "../../../core/src/ops/Backup.js";
import { HealthService } from "../../../core/src/ops/Health.js";
import { DiagnosticsService } from "../../../core/src/ops/Diagnostics.js";
import { RetentionService } from "../../../core/src/ops/Retention.js";

/**
 * Administrator control center. Register BEFORE routes/workspaces.js.
 *
 *   GET  /api/ops/health
 *   GET  /api/ops/status
 *   POST /api/ops/stop-all              { confirm: true, reason? }
 *   POST /api/ops/resume                { confirm: true, reason? }
 *   POST /api/ops/connections/:id/revoke{ confirm: true, reason? }
 *   POST /api/ops/quarantine            { confirm: true, host, reason?, release? }
 *   POST /api/ops/backup                { confirm: true, outPath }
 *   POST /api/ops/restore-drill         { confirm: true, tmpDir? }
 *   POST /api/ops/diagnostics          { confirm: true, outPath?, events? }
 *   GET  /api/ops/retention
 *   PUT  /api/ops/retention             { enabled, eventsDays, ... }
 *   POST /api/ops/retention/sweep       { confirm: true, dryRun? }
 *
 * `GET /api/audit/verify` and `GET /api/audit/export` live in routes/audit.js,
 * which already sits ahead of workspaces.js in the route list.
 *
 * Every POST here changes operational state, so each one requires an explicit
 * `{ "confirm": true }` body field and is recorded in the audit log with the
 * request's actor (the services themselves record the details). No route here
 * dispatches work; `GET /api/ops/dispatch-allowed` reports the server-side
 * stop verdict that assertDispatchAllowed() enforces on the dispatch paths.
 */
export default async function opsRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;
  if (!path.startsWith("/api/ops")) return false;

  const incidents = (services.incidents ??= new IncidentService(services));
  const health = (services.health ??= new HealthService(services));
  const backups = (services.backup ??= new BackupService(services));
  const diagnostics = (services.diagnostics ??= new DiagnosticsService(
    services,
  ));
  const retention = (services.retention ??= new RetentionService(services));

  const confirmed = async () => {
    const input = (await body()) ?? {};
    if (input.confirm !== true)
      throw new InputError(
        'This action changes operational state. Send { "confirm": true } to proceed.',
        400,
      );
    return input;
  };
  if (method === "GET" && path === "/api/ops/health") {
    send(200, health.snapshot());
    return true;
  }

  if (method === "GET" && path === "/api/ops/status") {
    send(200, {
      ...incidents.status(),
      retention: retention.policy(),
      schemaVersion: health.snapshot().schemaVersion,
    });
    return true;
  }

  if (method === "POST" && path === "/api/ops/stop-all") {
    const input = await confirmed();
    send(200, await incidents.stopAll({ actor, reason: input.reason ?? "" }));
    return true;
  }

  if (method === "POST" && path === "/api/ops/resume") {
    const input = await confirmed();
    send(200, incidents.resume({ actor, reason: input.reason ?? "" }));
    return true;
  }

  const revoke = path.match(/^\/api\/ops\/connections\/([^/]+)\/revoke$/);
  if (method === "POST" && revoke) {
    const input = await confirmed();
    send(
      200,
      await incidents.revokeConnection(decodeURIComponent(revoke[1]), {
        actor,
        reason: input.reason ?? "",
      }),
    );
    return true;
  }

  if (method === "POST" && path === "/api/ops/quarantine") {
    const input = await confirmed();
    send(
      200,
      incidents.quarantineRunner(input.host, {
        actor,
        reason: input.reason ?? "",
        release: input.release === true,
      }),
    );
    return true;
  }

  if (method === "POST" && path === "/api/ops/backup") {
    const input = await confirmed();
    if (!input.outPath)
      throw new InputError("outPath is required for a backup");
    const result = backups.backup({
      outPath: input.outPath,
      label: input.label ?? null,
      actor,
    });
    send(200, {
      path: result.path,
      manifestPath: result.manifestPath,
      bytes: result.bytes,
      sha256: result.sha256,
      manifest: result.manifest,
    });
    return true;
  }

  if (method === "POST" && path === "/api/ops/restore-drill") {
    const input = await confirmed();
    send(200, backups.drill({ tmpDir: input.tmpDir ?? null, actor }));
    return true;
  }

  // POST, not GET: this route creates directories and writes files. A GET
  // with the destination in the query string is reachable from any web page
  // the user visits (a cross-site <img> sends no Origin header and needs no
  // content type), so it goes through confirmed() like every other ops
  // mutation — readBody requires application/json, which a cross-origin form
  // cannot set.
  if (method === "POST" && path === "/api/ops/diagnostics") {
    const input = await confirmed();
    const result = diagnostics.bundle({
      outPath: input.outPath || undefined,
      includeEvents: input.events !== false && input.includeEvents !== false,
      actor,
    });
    send(200, {
      path: result.path,
      files: result.files,
      bytes: result.bytes,
      redaction: result.redaction,
      summary: result.summary,
    });
    return true;
  }

  if (path === "/api/ops/retention") {
    if (method === "GET") {
      send(200, { policy: retention.policy(), preview: retention.preview() });
      return true;
    }
    if (method === "PUT" || method === "PATCH") {
      const input = (await body()) ?? {};
      const policy = retention.setPolicy(input, { actor });
      send(200, { policy, preview: retention.preview() });
      return true;
    }
    return false;
  }

  if (method === "POST" && path === "/api/ops/retention/sweep") {
    const input = await confirmed();
    const result = retention.sweep({ actor, dryRun: input.dryRun === true });
    send(200, result);
    return true;
  }

  // Dispatch-guard probe: lets a client check the stop flag before offering a
  // Run button. It never starts work; it only reports the server-side verdict.
  if (method === "GET" && path === "/api/ops/dispatch-allowed") {
    try {
      assertDispatchAllowed(services);
      send(200, { allowed: true, reason: null });
    } catch (error) {
      send(200, { allowed: false, reason: error.message });
    }
    return true;
  }

  return false;
}
