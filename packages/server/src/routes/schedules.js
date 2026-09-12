import { InputError } from "../../../core/src/TaskStore.js";

/**
 * Schedules (roadmap §10). Register BEFORE routes/workspaces.js: this module
 * claims /api/workspaces/:id/schedules and returns false for every other
 * workspace path.
 *
 * Routes:
 *   GET    /api/workspaces/:id/schedules
 *   POST   /api/workspaces/:id/schedules        (created DISABLED)
 *   GET    /api/schedules/:id
 *   PATCH  /api/schedules/:id
 *   DELETE /api/schedules/:id
 *   POST   /api/schedules/:id/enable|disable|cancel|run-now
 *   GET    /api/schedules/:id/runs              ?limit=
 *   POST   /api/schedules/preview               {expression, timeZone, count?}
 *                                               next run times; nothing written
 *   GET    /api/scheduler/status
 *   POST   /api/scheduler/enabled               {enabled} turns timed dispatch
 *                                               on or off without a restart
 *
 * Scheduling is opt-in twice: the schedule must be enabled AND the
 * `scheduler.enabled` setting must be true before anything dispatches on a
 * timer. run-now is an explicit user action and is audited as the actor.
 */
export default async function scheduleRoutes(ctx) {
  const { method, path, send, body, query, services, actor } = ctx;
  const scheduler = services.scheduler;
  const isOurs =
    path === "/api/scheduler/status" ||
    path === "/api/scheduler/enabled" ||
    path.startsWith("/api/schedules/") ||
    /^\/api\/workspaces\/[^/]+\/schedules$/.test(path);
  if (!isOurs) return false;
  if (!scheduler)
    throw new InputError("Scheduler is not available in this build", 503);

  if (path === "/api/scheduler/status") {
    if (method !== "GET") return false;
    send(200, scheduler.status());
    return true;
  }
  if (path === "/api/scheduler/enabled") {
    if (method !== "POST") return false;
    const input = (await body()) ?? {};
    send(200, await scheduler.setEnabled(input.enabled, { actor }));
    return true;
  }
  if (path === "/api/schedules/preview") {
    if (method !== "POST") return false;
    const input = (await body()) ?? {};
    send(
      200,
      scheduler.preview(input.expression, input.timeZone, {
        count: input.count,
      }),
    );
    return true;
  }

  const inWorkspace = path.match(/^\/api\/workspaces\/([^/]+)\/schedules$/);
  if (inWorkspace) {
    const workspaceId = inWorkspace[1];
    if (method === "GET") {
      services.hub.get(workspaceId);
      send(
        200,
        scheduler.list(workspaceId, {
          includeCancelled: query?.get?.("includeCancelled") === "true",
        }),
      );
      return true;
    }
    if (method === "POST") {
      const input = (await body()) ?? {};
      send(201, scheduler.create(workspaceId, input, { actor }));
      return true;
    }
    return false;
  }

  const one = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (one) {
    const id = one[1];
    if (method === "GET") {
      send(200, scheduler.get(id));
      return true;
    }
    if (method === "PATCH") {
      const input = (await body()) ?? {};
      send(200, scheduler.update(id, input, { actor }));
      return true;
    }
    if (method === "DELETE") {
      send(200, await scheduler.remove(id, { actor }));
      return true;
    }
    return false;
  }

  const sub = path.match(
    /^\/api\/schedules\/([^/]+)\/(enable|disable|cancel|run-now|runs)$/,
  );
  if (!sub) return false;
  const [, id, action] = sub;
  if (action === "runs") {
    if (method !== "GET") return false;
    send(200, scheduler.runs(id, { limit: query?.get?.("limit") ?? 100 }));
    return true;
  }
  if (method !== "POST") return false;
  if (action === "enable") {
    send(200, scheduler.enable(id, { actor }));
    return true;
  }
  if (action === "disable") {
    send(200, scheduler.disable(id, { actor }));
    return true;
  }
  if (action === "cancel") {
    send(200, await scheduler.cancel(id, { actor }));
    return true;
  }
  // run-now: server-side gate on the schedules.runNow flag (workspace scope).
  const schedule = scheduler.get(id);
  if (
    services.flags?.isEnabled?.("schedules.runNow", {
      workspaceId: schedule.workspaceId,
    }) === false
  )
    throw new InputError(
      "schedules.runNow is disabled for this workspace by a feature flag",
      403,
    );
  send(200, await scheduler.runNow(id, { actor }));
  return true;
}
