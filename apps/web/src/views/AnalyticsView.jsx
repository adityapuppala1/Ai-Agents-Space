import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  Table2,
  Bookmark,
  Trash2,
  TrendingUp,
  Activity,
  Gauge,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatNumber,
  formatTime,
  providerLabel,
  readToken,
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
import EmptyState from "../components/EmptyState.jsx";
import { useGlobal } from "../hooks/useGlobal.js";
import { normalizeHeatmap } from "../hooks/viewLogic.js";

/* One-hue sequential ramp (reference palette, blue 100→700). Light: more is
   darker. Dark theme: same steps, near-zero recedes toward the dark surface. */
const RAMP_LIGHT = [
  "#cde2fb",
  "#9ec5f4",
  "#6da7ec",
  "#3987e5",
  "#256abf",
  "#184f95",
  "#0d366b",
];
const RAMP_DARK = [...RAMP_LIGHT].reverse();
const DARK_INK = new Set(["#cde2fb", "#9ec5f4", "#6da7ec"]);

const FUNNEL_STAGES = [
  "created",
  "dispatched",
  "started",
  "artifact",
  "reviewed",
  "accepted",
];
/**
 * [key, label, contained] — `contained` marks a bucket that is a SUBSET of
 * Executing, not a peer of it. waitingForProviderMs is derived from
 * tool.start -> tool.end intervals, which lie inside the running spans that
 * feed executingMs; rendering the two as rows of one list implied a partition
 * and made a 60 s run look like 120 s of accounted time.
 */
const TIME_BUCKETS = [
  ["queuedMs", "Queued", false],
  ["executingMs", "Executing", false],
  ["waitingApprovalMs", "Waiting for a human", true],
  ["waitingForHumanMs", "Waiting for a human", true],
  ["waitingForProviderMs", "Waiting for the provider", true],
  ["blockedMs", "Blocked", false],
  ["staleMs", "Stale", false],
  ["reviewingMs", "Reviewing", false],
];
const RANGES = [
  ["24h", "24 hours", 24 * 3600 * 1000],
  ["7d", "7 days", 7 * 24 * 3600 * 1000],
  ["30d", "30 days", 30 * 24 * 3600 * 1000],
  ["all", "All time", 0],
];
const FORECAST_METRICS = [
  ["durationMs", "Run duration"],
  ["costUsd", "Cost per run"],
  ["totalTokens", "Tokens per run"],
];

function isDark() {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function toPairs(value, labelKey = "stage", countKey = "count") {
  if (!value) return [];
  if (Array.isArray(value))
    return value.map((row) => [
      row[labelKey] ?? row.key ?? row.name ?? row.id,
      row[countKey] ?? row.value ?? row.total ?? row.ms ?? 0,
      row,
    ]);
  return Object.entries(value).map(([key, entry]) => [
    key,
    typeof entry === "object" && entry !== null
      ? (entry[countKey] ?? entry.value ?? entry.total ?? entry.ms ?? 0)
      : entry,
    entry,
  ]);
}

/* `normalizeHeatmap` is in ../hooks/viewLogic.js (covered by node:test). */
export { normalizeHeatmap };

/**
 * One usage row from an Analytics group (byProvider / byModel). Both carry
 * `{ runs, tokens: { input, output, reported }, costUsd: { value, reported,
 * estimated } }` — the flat `inputTokens` / `outputTokens` keys this panel
 * used to read do not exist, which is why every cell said "not reported".
 * Tokens are shown only when the group says a provider actually reported them.
 */
function usageRow(row, label) {
  const tokens = row.tokens ?? {};
  const tokensReported =
    tokens.reported !== false && tokens.reported !== undefined;
  return {
    label,
    provider: row.provider ?? row.key ?? null,
    runs: row.runs ?? row.count ?? 0,
    input: tokensReported ? (tokens.input ?? null) : null,
    output: tokensReported ? (tokens.output ?? null) : null,
    cost: row.costUsd?.value ?? row.cost ?? null,
    estimated: Boolean(row.costUsd?.estimated ?? row.estimated),
    reported: row.costUsd?.reported ?? null,
  };
}

/** Runs / tokens / cost for one usage grouping. Missing data says so. */
function UsageTable({ caption, rows, labelOf }) {
  const cell = (value) =>
    value === null || value === undefined
      ? "not reported"
      : formatNumber(value);
  return (
    <div className="as-table-wrap">
      <table className="as-table as-numeric">
        <thead>
          <tr>
            <th scope="col">{caption}</th>
            <th scope="col">Runs</th>
            <th scope="col">Input tokens</th>
            <th scope="col">Output tokens</th>
            <th scope="col">Cost</th>
            <th scope="col">Cost basis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th scope="row">{labelOf(row)}</th>
              <td>{formatNumber(row.runs)}</td>
              <td>{cell(row.input)}</td>
              <td>{cell(row.output)}</td>
              <td>
                {row.cost === null || row.cost === undefined
                  ? "not reported"
                  : typeof row.cost === "number"
                    ? `$${row.cost.toFixed(4)}`
                    : String(row.cost)}
              </td>
              <td>
                <span
                  className={`as-tag ${row.estimated ? "as-tag-warn" : ""}`}
                >
                  {row.estimated
                    ? "estimated"
                    : row.reported === false
                      ? "not reported"
                      : "reported"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One headline number. A value the server did not send is "Not recorded",
 * never a dash under a "counted" label: a count that was not made is not a
 * count.
 */
function Tile({ label, value, basis, hint }) {
  const missing = value === null || value === undefined;
  const shown = missing ? "Not recorded" : formatNumber(value);
  const shownBasis = missing ? "not recorded" : basis;
  return (
    <div
      className={`as-tile${missing ? " is-missing" : ""}`}
      role="group"
      aria-label={`${label}: ${shown} (${shownBasis})`}
    >
      <span className="as-tile-label">{label}</span>
      <strong className="as-tile-value">{shown}</strong>
      <span
        className={`as-tag ${shownBasis === "estimated" ? "as-tag-warn" : ""}`}
      >
        {shownBasis}
      </span>
      {hint ? <span className="as-muted as-small">{hint}</span> : null}
    </div>
  );
}

const STAGE_LABELS = {
  created: "Created",
  dispatched: "Dispatched",
  started: "Started",
  artifact: "Produced an artifact",
  reviewed: "Reviewed",
  accepted: "Accepted",
};

function BarCell({ value, max }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="as-bar-track" aria-hidden="true">
      <span className="as-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

function Heatmap({
  title,
  data,
  ramp,
  unitLabel,
  onDrill,
  asTable,
  onToggleTable,
  rowHeader = "Row",
  labelOf = (row) => String(row.title),
}) {
  if (!data) return null;
  return (
    <article className="as-card as-span2">
      <div className="as-row as-wrap">
        <h2>
          {title} <span className="as-tag">measured</span>
        </h2>
        <button
          type="button"
          className="text-button"
          aria-pressed={asTable}
          onClick={onToggleTable}
        >
          <Table2 size={12} /> {asTable ? "Show heatmap" : "Show as table"}
        </button>
      </div>
      {data.rows.length === 0 ? (
        <p className="as-muted">Nothing recorded in this range.</p>
      ) : (
        <div className="as-table-wrap">
          <table className={`as-table as-numeric ${asTable ? "" : "as-heat"}`}>
            <thead>
              <tr>
                <th scope="col">{rowHeader}</th>
                {Array.from({ length: 24 }, (_, hour) => (
                  <th key={hour} scope="col" abbr={`${hour}:00`}>
                    {hour}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row" title={labelOf(row)}>
                    {labelOf(row).slice(0, 32)}
                  </th>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const value = Number(row.hours[hour]) || 0;
                    const step =
                      data.max > 0 && value > 0
                        ? Math.min(
                            ramp.length - 1,
                            Math.floor((value / data.max) * (ramp.length - 1)),
                          )
                        : -1;
                    const fill = step >= 0 ? ramp[step] : "transparent";
                    let ink;
                    if (step >= 0)
                      ink = DARK_INK.has(fill) ? "#27394a" : "#ffffff";
                    const text =
                      data.unit === "ms"
                        ? formatElapsed(value)
                        : formatNumber(value);
                    const label = `${labelOf(row)}, ${hour}:00 — ${text}`;
                    const drillable =
                      value > 0 &&
                      (row.runIds[hour].length || row.taskIds[hour].length);
                    const cellText = value
                      ? data.unit === "ms"
                        ? Math.round(value / 60000)
                        : value
                      : "";
                    return (
                      <td
                        key={hour}
                        style={
                          asTable ? undefined : { background: fill, color: ink }
                        }
                        title={
                          drillable
                            ? `${label} — open the runs behind this cell`
                            : label
                        }
                      >
                        {drillable ? (
                          <button
                            type="button"
                            className="as-heat-cell"
                            aria-label={`${label}. Open the ${row.runIds[hour].length} run(s) behind this cell.`}
                            onClick={() =>
                              onDrill({
                                label,
                                runIds: row.runIds[hour],
                                taskIds: row.taskIds[hour],
                              })
                            }
                          >
                            {asTable ? text : cellText}
                          </button>
                        ) : (
                          <span aria-label={label}>
                            {asTable ? (value ? text : "") : cellText}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="as-muted as-small">
        Cell values are {unitLabel}; darker means more (single-hue scale). A
        cell with recorded runs is a button: it opens the actual runs behind it.
      </p>
    </article>
  );
}

/**
 * Analytics for one workspace (or all when `workspaceId` is null) from
 * GET /api/analytics?workspace=&since=. Every number carries a basis label:
 * counted (from stored records), reported (provider-supplied), measured (from
 * recorded timestamps) or estimated.
 *
 * Added in wave 2: saved views (GET/POST/DELETE /api/analytics/views), filter
 * chips that actually send the range as an epoch `since`, heatmap cells that
 * drill down through POST /api/analytics/drill-down, a forecast with its
 * assumptions and confidence (GET /api/analytics/forecast), availability
 * (GET /api/analytics/availability) and saturation
 * (GET /api/analytics/saturation), and CSV/JSON export.
 *
 * @param {{ workspaceId?: string|null, onOpenRun?: (runId:string)=>void, onOpenTask?: (taskId:string)=>void }} props
 */
export default function AnalyticsView({
  workspaceId = null,
  onOpenRun,
  onOpenTask,
}) {
  const [range, setRange] = useState("7d");
  const [provider, setProvider] = useState("");
  const [heatTable, setHeatTable] = useState(false);
  const [workloadTable, setWorkloadTable] = useState(false);
  const [drill, setDrill] = useState(null);
  const [drillError, setDrillError] = useState("");
  const [viewName, setViewName] = useState("");
  const [viewMessage, setViewMessage] = useState("");
  const [metric, setMetric] = useState("durationMs");
  const { global } = useGlobal();
  const workspaceNames = useMemo(
    () =>
      new Map(
        (global.workspaces ?? []).map((workspace) => [
          workspace.id,
          workspace.name,
        ]),
      ),
    [global.workspaces],
  );

  const since = useMemo(() => {
    const window = RANGES.find((entry) => entry[0] === range)?.[2] ?? 0;
    return window ? Date.now() - window : 0;
  }, [range]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspace", workspaceId);
    if (since) params.set("since", String(since));
    return params;
  }, [workspaceId, since]);

  const analytics = useApi(`/analytics?${query.toString()}`, {
    interval: 30000,
  });
  const forecast = useApi(
    `/analytics/forecast?${new URLSearchParams({
      ...Object.fromEntries(query),
      metric,
      ...(provider ? { provider } : {}),
    }).toString()}`,
  );
  const views = useApi(
    `/analytics/views${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
  );

  const data = analytics.data?.summary ?? analytics.data ?? null;
  const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
  const exportHref = (format) => {
    const params = new URLSearchParams(query);
    params.set("format", format);
    const token = readToken();
    if (token) params.set("token", token);
    return `/api/analytics/export?${params.toString()}`;
  };

  const drillDown = useCallback(async ({ label, runIds, taskIds }) => {
    setDrillError("");
    try {
      const result = await apiFetch("/analytics/drill-down", {
        method: "POST",
        body: { runIds, taskIds },
      });
      setDrill({ label, ...result });
    } catch (error) {
      setDrill(null);
      setDrillError(error.message);
    }
  }, []);

  const funnel = useMemo(() => {
    const pairs = toPairs(data?.funnel);
    const byKey = new Map(
      pairs.map(([key, value]) => [
        String(key).toLowerCase(),
        Number(value) || 0,
      ]),
    );
    const ordered = FUNNEL_STAGES.filter((stage) => byKey.has(stage)).map(
      (stage) => [stage, byKey.get(stage)],
    );
    for (const [key, value] of byKey)
      if (!FUNNEL_STAGES.includes(key)) ordered.push([key, value]);
    return ordered;
  }, [data]);

  const time = useMemo(() => {
    const source = data?.time ?? data?.timeBreakdown ?? data?.durations ?? {};
    const seen = new Set();
    const ordered = [];
    for (const [key, label, contained] of TIME_BUCKETS) {
      const value = Number(source[key]);
      if (!Number.isFinite(value) || seen.has(label)) continue;
      seen.add(label);
      ordered.push([label, value, contained === true]);
    }
    return ordered;
  }, [data]);

  const providers = useMemo(() => {
    const raw = data?.byProvider ?? data?.providers ?? data?.usage ?? [];
    const rows = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([key, entry]) => ({
          provider: key,
          ...(entry ?? {}),
        }));
    return rows.map((row) =>
      usageRow(row, row.provider ?? row.key ?? "unknown"),
    );
  }, [data]);

  // byModel is its own list of rows ({ model, reported, runs, tokens, costUsd }).
  // It is NOT a column of byProvider: a provider row aggregates every model it
  // ran, so there is no single model to put beside it.
  const models = useMemo(() => {
    const raw = data?.byModel ?? [];
    const rows = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([key, entry]) => ({
          model: key,
          ...(entry ?? {}),
        }));
    return rows.map((row) =>
      usageRow(
        row,
        row.reported === false || !row.model || row.model === "unknown"
          ? "model not reported"
          : row.model,
      ),
    );
  }, [data]);

  const blocked = useMemo(
    () => normalizeHeatmap(data?.blockedHeatmap ?? data?.heatmap ?? null),
    [data],
  );
  const workload = useMemo(
    () => normalizeHeatmap(data?.workloadHeatmap ?? null),
    [data],
  );
  const availability = data?.reliability?.availability ?? null;
  const saturation = data?.reliability?.saturation ?? null;

  const counts = {
    completed: data?.funnel?.accepted ?? data?.counts?.completed,
    failed: data?.reliability?.failures ?? data?.counts?.failed,
    cancelled: data?.reliability?.cancellations ?? data?.counts?.cancelled,
    retries: data?.reliability?.retries ?? data?.counts?.retries,
    disconnects: data?.reliability?.disconnects ?? data?.counts?.disconnects,
    stale: data?.reliability?.staleEvents ?? data?.counts?.stale,
  };
  const maxFunnel = Math.max(0, ...funnel.map(([, value]) => value));
  // Contained rows are excluded from the scale: they are a subset of
  // Executing, so letting one set the bar maximum would misread as a peer.
  const maxTime = Math.max(
    0,
    ...time.filter(([, , contained]) => !contained).map(([, value]) => value),
  );

  const savedViews = views.data?.views ?? [];
  const applyView = (view) => {
    const filters = view.filters ?? {};
    if (filters.range) setRange(filters.range);
    if (filters.provider !== undefined) setProvider(filters.provider ?? "");
    if (filters.metric) setMetric(filters.metric);
    setViewMessage(`Applied saved view "${view.name}".`);
  };
  const saveView = async () => {
    if (!viewName.trim()) return;
    try {
      await apiFetch("/analytics/views", {
        method: "POST",
        body: {
          name: viewName.trim(),
          workspaceId,
          filters: { range, provider: provider || null, metric },
        },
      });
      setViewName("");
      setViewMessage("Saved. This view stores the filters, never the numbers.");
      views.reload();
    } catch (error) {
      setViewMessage(error.message);
    }
  };

  const providerOptions = useMemo(
    () => [...new Set(providers.map((row) => row.provider))].filter(Boolean),
    [providers],
  );

  useEffect(() => {
    setDrill(null);
  }, [range, workspaceId]);

  const rangeText = since
    ? `Since ${new Date(since).toLocaleString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "All recorded time";

  return (
    <section className="as-analytics an" aria-label="Analytics">
      {/* The page header names the view; this bar holds every control. */}
      <div className="an-toolbar">
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={range === id}
              onClick={() => setRange(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="an-field">
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="">All</option>
            {providerOptions.map((id) => (
              <option key={id} value={id}>
                {providerLabel(id)}
              </option>
            ))}
          </select>
        </label>
        {savedViews.length ? (
          <label className="an-field">
            Saved view
            <select
              value=""
              onChange={(event) => {
                const view = savedViews.find(
                  (entry) => entry.id === event.target.value,
                );
                if (view) applyView(view);
              }}
            >
              <option value="">Choose…</option>
              {savedViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="an-export">
          <a
            className="button"
            href={exportHref("csv")}
            download
            aria-label="Export analytics as CSV"
          >
            <Download size={12} aria-hidden="true" /> Export CSV
          </a>
          <a
            className="text-button"
            href={exportHref("json")}
            download
            aria-label="Export analytics as JSON"
          >
            JSON
          </a>
        </div>
      </div>

      <p className="an-legend">
        <strong>{rangeText}.</strong>{" "}
        <span className="as-muted">
          Every number says how it is known:{" "}
          <span className="as-tag" title="Counted from stored records">
            counted
          </span>{" "}
          <span className="as-tag" title="Reported by the provider">
            reported
          </span>{" "}
          <span className="as-tag" title="Measured from recorded timestamps">
            measured
          </span>{" "}
          <span
            className="as-tag as-tag-warn"
            title="Computed with the stated assumptions"
          >
            estimated
          </span>
          . Missing data says so and is never guessed.
        </span>
      </p>

      {/* ------------------------------------------------------ saved views */}
      <details className="an-views">
        <summary>
          <Bookmark size={12} aria-hidden="true" />
          {savedViews.length
            ? `Save or manage views (${savedViews.length})`
            : "Save these filters as a view"}
        </summary>
        <div className="an-views-body">
          {views.error ? (
            <span className="as-muted as-small">
              Saved views need{" "}
              <code className="as-mono">GET /api/analytics/views</code>.
            </span>
          ) : null}
          <span className="as-row as-wrap">
            <label className="as-inline-label">
              <span className="sr-only">Name for this view</span>
              <input
                value={viewName}
                onChange={(event) => setViewName(event.target.value)}
                placeholder="Name the current filters"
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={saveView}
              disabled={!viewName.trim()}
            >
              Save view
            </button>
          </span>
          {savedViews.length ? (
            <ul className="an-views-list" role="list">
              {savedViews.map((view) => (
                <li key={view.id}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => applyView(view)}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete saved view ${view.name}`}
                    onClick={async () => {
                      await apiFetch(
                        `/analytics/views/${encodeURIComponent(view.id)}`,
                        { method: "DELETE" },
                      );
                      views.reload();
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
      {viewMessage ? (
        <p className="as-feedback" role="status">
          {viewMessage}
        </p>
      ) : null}

      {analytics.error ? (
        <EmptyState
          title="Analytics are unavailable"
          error={analytics.error}
          missingRoutes={["GET /api/analytics"]}
        />
      ) : null}
      {!data && !analytics.error ? <p className="as-muted">Loading…</p> : null}

      {data ? (
        <div className={analytics.loading ? "as-stale" : ""}>
          <div className="as-tiles">
            <Tile
              label="Accepted results"
              value={counts.completed}
              basis="counted"
              hint="a reviewer accepted the result"
            />
            <Tile
              label="Failed runs"
              value={counts.failed}
              basis="counted"
              hint={
                counts.failed === undefined
                  ? "restart the server to start counting"
                  : undefined
              }
            />
            <Tile label="Cancelled" value={counts.cancelled} basis="counted" />
            <Tile label="Retries" value={counts.retries} basis="counted" />
            <Tile
              label="Disconnects"
              value={counts.disconnects}
              basis="counted"
            />
            <Tile
              label="Stale events"
              value={counts.stale}
              basis="counted"
              hint="a run went quiet past the stale limit"
            />
          </div>

          <div className="as-analytics-grid">
            <article className="as-card">
              <h2>
                Funnel <span className="as-tag">counted</span>
              </h2>
              {funnel.length === 0 ? (
                <p className="as-muted">No funnel data.</p>
              ) : (
                <table className="as-table as-numeric as-table-compact">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">Count</th>
                      <th scope="col" className="as-bar-col">
                        <span className="sr-only">Share of created</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.map(([stage, value]) => (
                      <tr key={stage}>
                        <th scope="row">{STAGE_LABELS[stage] ?? stage}</th>
                        <td>{formatNumber(value)}</td>
                        <td>
                          <BarCell value={value} max={maxFunnel} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="as-muted as-small">
                Accepted means a reviewer accepted the result; a final agent
                message is not counted as success.
              </p>
            </article>

            <article className="as-card">
              <h2>
                Time breakdown <span className="as-tag">measured</span>
              </h2>
              {time.length === 0 ? (
                <p className="as-muted">No timing data.</p>
              ) : (
                <table className="as-table as-numeric as-table-compact">
                  <thead>
                    <tr>
                      <th scope="col">State</th>
                      <th scope="col">Total</th>
                      <th scope="col" className="as-bar-col">
                        <span className="sr-only">Share</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {time.map(([label, ms, contained]) => (
                      <tr key={label} className={contained ? "as-sub-row" : ""}>
                        <th scope="row">
                          {contained
                            ? `of which ${label.toLowerCase()}`
                            : label}
                        </th>
                        <td>{formatElapsed(ms)}</td>
                        <td>
                          <BarCell value={ms} max={maxTime} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="as-muted as-small">
                {data?.time?.note ??
                  "Parallel runs overlap; totals are per-run time, not wall-clock project time."}{" "}
                The &ldquo;of which&rdquo; rows are contained in Executing, not
                additional to it, so these rows do not sum to a total.
              </p>
            </article>

            <article className="as-card as-span2">
              <h2>Usage by provider</h2>
              {providers.length === 0 ? (
                <p className="as-muted">
                  No usage reported by any provider in this range.
                </p>
              ) : (
                <UsageTable
                  caption="Provider"
                  rows={providers.filter(
                    (row) => !provider || row.provider === provider,
                  )}
                  labelOf={(row) => providerLabel(row.provider)}
                />
              )}
            </article>

            <article className="as-card as-span2">
              <h2>Usage by model</h2>
              {models.length === 0 ? (
                <p className="as-muted">
                  No model was reported for any run in this range.
                </p>
              ) : (
                <UsageTable
                  caption="Model"
                  rows={models}
                  labelOf={(row) => row.label}
                />
              )}
            </article>

            {/* ------------------------------------------------ heatmaps */}
            <Heatmap
              title="Blocked time by task and hour"
              data={blocked}
              ramp={ramp}
              unitLabel={
                blocked?.unit === "ms" ? "minutes blocked" : "blocked events"
              }
              asTable={heatTable}
              onToggleTable={() => setHeatTable((value) => !value)}
              onDrill={drillDown}
              rowHeader="Task"
            />
            <Heatmap
              title="Workload by provider and hour"
              data={workload}
              ramp={ramp}
              unitLabel={workload?.unit === "ms" ? "minutes executing" : "runs"}
              asTable={workloadTable}
              onToggleTable={() => setWorkloadTable((value) => !value)}
              onDrill={drillDown}
              rowHeader="Provider"
              labelOf={(row) => providerLabel(String(row.title))}
            />

            {drillError ? (
              <article className="as-card as-span2">
                <div className="form-error" role="alert">
                  {drillError}
                </div>
              </article>
            ) : null}
            {drill ? (
              <article className="as-card as-span2" aria-live="polite">
                <div className="as-row as-wrap">
                  <h3>Runs behind “{drill.label}”</h3>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setDrill(null)}
                  >
                    Close
                  </button>
                </div>
                {(drill.runs ?? []).length === 0 &&
                (drill.tasks ?? []).length === 0 ? (
                  <p className="as-muted">
                    The records behind this cell are no longer stored.
                  </p>
                ) : null}
                {(drill.runs ?? []).length ? (
                  <div className="as-table-wrap">
                    <table className="as-table">
                      <thead>
                        <tr>
                          <th scope="col">Run</th>
                          <th scope="col">Provider</th>
                          <th scope="col">Status</th>
                          <th scope="col">Started</th>
                          <th scope="col">Model</th>
                        </tr>
                      </thead>
                      <tbody>
                        {drill.runs.map((run) => (
                          <tr key={run.runId}>
                            <th scope="row">
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => onOpenRun?.(run.runId)}
                              >
                                {run.runId.slice(0, 8)}
                              </button>
                            </th>
                            <td>{providerLabel(run.provider)}</td>
                            <td>
                              {RUN_STATUS_LABELS[run.status] ?? run.status}
                            </td>
                            <td>{formatTime(run.startedAt)}</td>
                            <td>{run.model ?? "model not reported"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {(drill.tasks ?? []).length ? (
                  <ul className="as-drill-tasks" role="list">
                    {drill.tasks.map((task) => (
                      <li key={task.taskId}>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => onOpenTask?.(task.taskId)}
                        >
                          {task.title}
                        </button>
                        <span className="as-tag">{task.status}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ) : null}

            {/* ---------------------------------------------- forecast */}
            <article className="as-card">
              <div className="as-row as-wrap">
                <h2>
                  <TrendingUp size={13} aria-hidden="true" /> Forecast{" "}
                  <span className="as-tag as-tag-warn">estimated</span>
                </h2>
                <label className="as-inline-label">
                  Metric
                  <select
                    value={metric}
                    onChange={(event) => setMetric(event.target.value)}
                  >
                    {FORECAST_METRICS.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {forecast.error ? (
                <EmptyState
                  compact
                  title="Forecast unavailable"
                  error={forecast.error}
                  missingRoutes={["GET /api/analytics/forecast"]}
                />
              ) : forecast.data?.available === false ? (
                <p className="as-muted">No forecast: {forecast.data.reason}</p>
              ) : forecast.data ? (
                <>
                  <p className="as-forecast-range">
                    <strong>
                      {metric === "durationMs"
                        ? formatElapsed(forecast.data.estimate)
                        : formatNumber(forecast.data.estimate)}
                    </strong>{" "}
                    typical ·{" "}
                    {metric === "durationMs"
                      ? `${formatElapsed(forecast.data.low)} – ${formatElapsed(forecast.data.high)}`
                      : `${formatNumber(forecast.data.low)} – ${formatNumber(forecast.data.high)}`}{" "}
                    range
                  </p>
                  <p className="as-muted as-small">
                    {forecast.data.confidence?.interval} ·{" "}
                    {forecast.data.confidence?.method} · confidence{" "}
                    {forecast.data.confidence?.level} ·{" "}
                    {forecast.data.confidence?.note}
                  </p>
                  <h5>Assumptions</h5>
                  <ul className="as-assumptions">
                    {(forecast.data.assumptions ?? []).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {forecast.data.capacity?.available ? (
                    <>
                      <h5>Capacity</h5>
                      <ul className="as-assumptions">
                        {forecast.data.capacity.suggestions.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              ) : (
                <p className="as-muted">Loading forecast…</p>
              )}
            </article>

            {/* ------------------------------------------ availability */}
            <article className="as-card">
              <h2>
                <Activity size={13} aria-hidden="true" /> Provider availability{" "}
                <span className="as-tag">measured</span>
              </h2>
              {!availability ? (
                <p className="as-muted">
                  No availability recorded in this range.
                </p>
              ) : (
                <>
                  <table className="as-table as-numeric as-table-compact">
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Success</th>
                        <th scope="col">Disconnects / run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(availability.byProvider ?? []).map((row) => (
                        <tr key={row.provider}>
                          <th scope="row">{providerLabel(row.provider)}</th>
                          <td>{formatNumber(row.attempts)}</td>
                          <td>
                            {row.availability === null
                              ? "no attempts"
                              : `${Math.round(row.availability * 100)}%`}
                          </td>
                          <td>
                            {row.disconnectFrequency === null
                              ? "—"
                              : row.disconnectFrequency.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="as-muted as-small">{availability.basis}</p>
                </>
              )}
            </article>

            {/* -------------------------------------------- saturation */}
            <article className="as-card as-span2">
              <h2>
                <Gauge size={13} aria-hidden="true" /> Runner saturation{" "}
                <span className="as-tag">measured</span>
              </h2>
              {!saturation?.byWorkspace?.length ? (
                <p className="as-muted">
                  No run overlapped a concurrency limit in this range.
                </p>
              ) : (
                <div className="as-table-wrap">
                  <table className="as-table as-numeric">
                    <thead>
                      <tr>
                        <th scope="col">Workspace</th>
                        <th scope="col">Limit</th>
                        <th scope="col">Peak concurrent</th>
                        <th scope="col">Time at the limit</th>
                        <th scope="col">Windows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saturation.byWorkspace.map((row) => (
                        <tr key={row.workspaceId}>
                          <th scope="row">
                            {workspaceNames.get(row.workspaceId) ??
                              row.workspaceId}
                          </th>
                          <td>{formatNumber(row.limit)}</td>
                          <td>{formatNumber(row.maxConcurrent)}</td>
                          <td>{formatElapsed(row.saturatedMs ?? 0)}</td>
                          <td>
                            {(row.windows ?? []).length ? (
                              <button
                                type="button"
                                className="text-button"
                                onClick={() =>
                                  drillDown({
                                    label: `saturation in ${workspaceNames.get(row.workspaceId) ?? row.workspaceId}`,
                                    runIds: row.windows.flatMap(
                                      (window) => window.runIds ?? [],
                                    ),
                                    taskIds: [],
                                  })
                                }
                              >
                                {row.windows.length} window(s)
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="as-muted as-small">
                Saturation counts the recorded overlap of runs against the
                workspace's own concurrency limit. Provider rate limits and
                machine resources are not measured.
              </p>
            </article>
          </div>
        </div>
      ) : null}
    </section>
  );
}
