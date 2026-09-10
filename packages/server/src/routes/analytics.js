import { InputError } from "../../../core/src/TaskStore.js";
import { parseRange } from "../../../core/src/analytics/Analytics.js";
import { Lineage } from "../../../core/src/analytics/lineage.js";
import { Pricing } from "../../../core/src/analytics/pricing.js";

/**
 * Analytics, forecasts, saved views, scheduled reports, lineage, and the
 * OpenTelemetry-shaped export. Register BEFORE routes/workspaces.js (order
 * relative to the other module routes does not matter).
 *
 *   GET    /api/analytics?workspace=&since=
 *   GET    /api/analytics/export?format=csv|json&workspace=&since=
 *   GET    /api/analytics/forecast?workspace=&since=&provider=&model=&metric=
 *   GET    /api/analytics/availability?workspace=&since=
 *   GET    /api/analytics/saturation?workspace=&since=
 *   GET    /api/analytics/heatmaps?workspace=&since=
 *   POST   /api/analytics/drill-down        { runIds[], taskIds[] }
 *   GET    /api/analytics/lineage?run=|task=|workspace=&since=
 *   GET    /api/analytics/otlp?workspace=&since=&prompts=1&files=1
 *   GET    /api/analytics/pricing
 *   PUT    /api/analytics/pricing           { <model>: { inputPer1k, ... } }
 *   GET    /api/analytics/views?workspace=
 *   POST   /api/analytics/views             { name, workspaceId, filters }
 *   GET    /api/analytics/views/:id
 *   PATCH  /api/analytics/views/:id         { name?, filters? }
 *   DELETE /api/analytics/views/:id
 *   GET    /api/analytics/reports
 *   POST   /api/analytics/reports           { name, format, cadence, outputDir, ... }
 *   GET    /api/analytics/reports/:id
 *   PATCH  /api/analytics/reports/:id
 *   DELETE /api/analytics/reports/:id
 *   POST   /api/analytics/reports/:id/run
 *
 * `since` accepts epoch milliseconds and ISO date strings alike.
 * Scheduled reports only write files into their own output directory; they
 * never send anything anywhere, and they are disabled by default.
 */
export default async function analyticsRoutes(ctx) {
  const { method, path, query, send, body, res, services } = ctx;
  if (!path.startsWith("/api/analytics")) return false;
  const analytics = services.analytics;
  if (!analytics) throw new InputError("Analytics are not available", 503);
  const opts = {
    workspaceId: query.get("workspace") || null,
    since: parseRange(query.get("since")),
  };

  if (method === "GET" && path === "/api/analytics") {
    send(200, analytics.summary(opts));
    return true;
  }

  if (method === "GET" && path === "/api/analytics/export") {
    const format = query.get("format") || "json";
    const result = analytics.export(format, opts);
    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="agent-space-analytics.${format}"`,
    });
    res.end(result.body);
    return true;
  }

  if (method === "GET" && path === "/api/analytics/forecast") {
    send(
      200,
      analytics.forecast({
        ...opts,
        provider: query.get("provider") || null,
        model: query.get("model") || null,
        metric: query.get("metric") || "durationMs",
      }),
    );
    return true;
  }

  if (method === "GET" && path === "/api/analytics/availability") {
    const summary = analytics.summary(opts);
    send(200, {
      generatedAt: summary.generatedAt,
      scope: summary.scope,
      availability: summary.reliability.availability,
      disconnectFrequency: summary.reliability.disconnectFrequency,
      cancellationAcknowledgement:
        summary.reliability.cancellationAcknowledgement,
      retryClassifications: summary.reliability.retryClassifications,
      retryReasons: summary.reliability.retryReasons,
    });
    return true;
  }

  if (method === "GET" && path === "/api/analytics/saturation") {
    const summary = analytics.summary(opts);
    send(200, {
      generatedAt: summary.generatedAt,
      scope: summary.scope,
      saturation: summary.reliability.saturation,
    });
    return true;
  }

  if (method === "GET" && path === "/api/analytics/heatmaps") {
    const summary = analytics.summary(opts);
    send(200, {
      generatedAt: summary.generatedAt,
      scope: summary.scope,
      blockedHeatmap: summary.blockedHeatmap,
      workloadHeatmap: summary.workloadHeatmap,
      criticalPaths: summary.criticalPaths,
    });
    return true;
  }

  if (method === "POST" && path === "/api/analytics/drill-down") {
    const input = (await body()) ?? {};
    send(
      200,
      analytics.drillDown({
        runIds: Array.isArray(input.runIds) ? input.runIds : [],
        taskIds: Array.isArray(input.taskIds) ? input.taskIds : [],
      }),
    );
    return true;
  }

  if (method === "GET" && path === "/api/analytics/lineage") {
    const lineage = (services.lineage ??= new Lineage(services));
    const runId = query.get("run");
    const taskId = query.get("task");
    if (runId) send(200, lineage.forRun(runId));
    else if (taskId) send(200, lineage.forTask(taskId));
    else send(200, lineage.lineage(opts));
    return true;
  }

  if (method === "GET" && path === "/api/analytics/otlp") {
    send(
      200,
      analytics.otlpExport({
        ...opts,
        includeAttributes: {
          prompts: query.get("prompts") === "1",
          files: query.get("files") === "1",
        },
      }),
    );
    return true;
  }

  if (path === "/api/analytics/pricing") {
    const pricing = analytics.pricingService ?? new Pricing(services);
    if (method === "GET") {
      send(200, {
        ...pricing.table(),
        note: "Provider-reported cost always wins. Without a table, cost is reported as not available rather than guessed.",
      });
      return true;
    }
    if (method === "PUT") {
      const input = (await body()) ?? {};
      send(200, pricing.configure(input.pricing ?? input));
      return true;
    }
  }

  // ------------------------------------------------------------ saved views
  if (path === "/api/analytics/views") {
    if (method === "GET") {
      send(200, { views: analytics.views.list(opts) });
      return true;
    }
    if (method === "POST") {
      const input = (await body()) ?? {};
      send(
        201,
        analytics.views.create({
          name: input.name,
          workspaceId: input.workspaceId ?? opts.workspaceId,
          filters: input.filters,
        }),
      );
      return true;
    }
  }
  const viewMatch = /^\/api\/analytics\/views\/([^/]+)$/.exec(path);
  if (viewMatch) {
    const id = decodeURIComponent(viewMatch[1]);
    if (method === "GET") {
      send(200, analytics.views.get(id));
      return true;
    }
    if (method === "PATCH" || method === "PUT") {
      send(200, analytics.views.update(id, (await body()) ?? {}));
      return true;
    }
    if (method === "DELETE") {
      send(200, analytics.views.remove(id));
      return true;
    }
  }

  // ------------------------------------------------------ scheduled reports
  if (path === "/api/analytics/reports") {
    if (method === "GET") {
      send(200, { reports: analytics.reports.list() });
      return true;
    }
    if (method === "POST") {
      send(201, analytics.reports.create((await body()) ?? {}));
      return true;
    }
  }
  const reportRun = /^\/api\/analytics\/reports\/([^/]+)\/run$/.exec(path);
  if (reportRun && method === "POST") {
    send(200, analytics.reports.run(decodeURIComponent(reportRun[1])));
    return true;
  }
  const reportMatch = /^\/api\/analytics\/reports\/([^/]+)$/.exec(path);
  if (reportMatch) {
    const id = decodeURIComponent(reportMatch[1]);
    if (method === "GET") {
      send(200, analytics.reports.get(id));
      return true;
    }
    if (method === "PATCH" || method === "PUT") {
      send(200, analytics.reports.update(id, (await body()) ?? {}));
      return true;
    }
    if (method === "DELETE") {
      send(200, analytics.reports.remove(id));
      return true;
    }
  }

  return false;
}
