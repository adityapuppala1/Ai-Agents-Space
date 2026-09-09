import React, { useMemo, useState } from "react";
import { ChartBar, Download, Table2 } from "lucide-react";
import {
  useApi,
  formatElapsed,
  formatNumber,
  providerLabel,
  readToken,
} from "../hooks/useApi.js";

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
const TIME_BUCKETS = [
  ["queued", "Queued"],
  ["executing", "Executing"],
  ["waiting_approval", "Waiting for approval"],
  ["waiting_provider", "Waiting for provider"],
  ["blocked", "Blocked"],
  ["reviewing", "Reviewing"],
];
const RANGES = [
  ["24h", "Last 24 hours", 24 * 3600 * 1000],
  ["7d", "Last 7 days", 7 * 24 * 3600 * 1000],
  ["30d", "Last 30 days", 30 * 24 * 3600 * 1000],
  ["all", "All time", 0],
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

function Tile({ label, value, basis, hint }) {
  return (
    <div
      className="as-tile"
      role="group"
      aria-label={`${label}: ${value} (${basis})`}
    >
      <span className="as-tile-label">{label}</span>
      <strong className="as-tile-value">{value}</strong>
      <span className={`as-tag ${basis === "estimated" ? "as-tag-warn" : ""}`}>
        {basis}
      </span>
      {hint ? <span className="as-muted as-small">{hint}</span> : null}
    </div>
  );
}

function BarCell({ value, max }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="as-bar-track" aria-hidden="true">
      <span className="as-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/**
 * Analytics for one workspace (or all when `workspaceId` is null) from
 * GET /api/analytics?workspace=&since=. Every number carries a basis label:
 * counted (from stored records), reported (provider-supplied), measured (from
 * recorded timestamps) or estimated. Export links point at
 * GET /api/analytics/export?format=csv|json.
 * @param {{ workspaceId?: string|null }} props
 */
export default function AnalyticsView({ workspaceId = null }) {
  const [range, setRange] = useState("7d");
  const [heatTable, setHeatTable] = useState(false);
  const since = useMemo(() => {
    const sinceMs = RANGES.find((r) => r[0] === range)?.[2] ?? 0;
    return sinceMs ? new Date(Date.now() - sinceMs).toISOString() : "";
  }, [range]);
  const query = new URLSearchParams();
  if (workspaceId) query.set("workspace", workspaceId);
  if (since) query.set("since", since);
  const analytics = useApi(`/analytics?${query.toString()}`, {
    interval: 30000,
  });
  const data = analytics.data?.summary ?? analytics.data ?? null;
  const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
  const exportHref = (format) => {
    const params = new URLSearchParams(query);
    params.set("format", format);
    if (readToken()) params.set("token", readToken());
    return `/api/analytics/export?${params.toString()}`;
  };

  const funnel = useMemo(() => {
    const pairs = toPairs(data?.funnel);
    const byKey = new Map(
      pairs.map(([k, v]) => [String(k).toLowerCase(), Number(v) || 0]),
    );
    const ordered = FUNNEL_STAGES.filter((s) => byKey.has(s)).map((s) => [
      s,
      byKey.get(s),
    ]);
    for (const [k, v] of byKey)
      if (!FUNNEL_STAGES.includes(k)) ordered.push([k, v]);
    return ordered;
  }, [data]);
  const time = useMemo(() => {
    const pairs = toPairs(
      data?.time ?? data?.timeBreakdown ?? data?.durations,
      "bucket",
      "ms",
    );
    const byKey = new Map(pairs.map(([k, v]) => [String(k), Number(v) || 0]));
    const ordered = TIME_BUCKETS.filter(([k]) => byKey.has(k)).map(
      ([k, label]) => [label, byKey.get(k)],
    );
    for (const [k, v] of byKey)
      if (!TIME_BUCKETS.some(([key]) => key === k)) ordered.push([k, v]);
    return ordered;
  }, [data]);
  const providers = useMemo(() => {
    const raw = data?.providers ?? data?.byProvider ?? data?.usage ?? [];
    const rows = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([provider, entry]) => ({
          provider,
          ...(entry ?? {}),
        }));
    return rows.map((row) => ({
      provider: row.provider ?? "unknown",
      model: row.model ?? "model not reported",
      runs: row.runs ?? row.count ?? 0,
      input:
        row.inputTokens ?? row.input_tokens ?? row.usage?.input_tokens ?? null,
      output:
        row.outputTokens ??
        row.output_tokens ??
        row.usage?.output_tokens ??
        null,
      cost: row.cost ?? row.costUsd ?? row.total_cost_usd ?? null,
      estimated: Boolean(row.estimated),
    }));
  }, [data]);
  const heat = useMemo(() => {
    const raw = data?.heatmap ?? data?.blockedHeatmap ?? null;
    if (!raw) return null;
    let rows = [];
    if (Array.isArray(raw))
      rows = raw.map((row) => ({
        id: row.taskId ?? row.id,
        title: row.title ?? row.taskId ?? row.id,
        hours: row.hours ?? row.values ?? [],
      }));
    else if (Array.isArray(raw.rows))
      rows = raw.rows.map((row) => ({
        id: row.taskId ?? row.id,
        title: row.title ?? row.id,
        hours: row.hours ?? row.values ?? [],
      }));
    else if (Array.isArray(raw.cells)) {
      const map = new Map();
      for (const cell of raw.cells) {
        const key = cell.taskId ?? cell.task;
        if (!map.has(key))
          map.set(key, {
            id: key,
            title: cell.title ?? key,
            hours: Array(24).fill(0),
          });
        map.get(key).hours[cell.hour] =
          (map.get(key).hours[cell.hour] ?? 0) +
          (cell.value ?? cell.ms ?? cell.count ?? 0);
      }
      rows = [...map.values()];
    }
    const max = Math.max(
      0,
      ...rows.flatMap((row) => row.hours.map((v) => Number(v) || 0)),
    );
    return {
      rows,
      max,
      unit:
        raw.unit ??
        (rows.some((r) => r.hours.some((v) => v > 1000)) ? "ms" : "count"),
    };
  }, [data]);

  const counts = {
    completed:
      data?.runs?.completed ?? data?.completed ?? data?.counts?.completed,
    failed: data?.runs?.failed ?? data?.failed ?? data?.counts?.failed,
    cancelled:
      data?.runs?.cancelled ?? data?.cancellations ?? data?.counts?.cancelled,
    retries: data?.retries ?? data?.counts?.retries,
    disconnects:
      data?.disconnects ?? data?.disconnections ?? data?.counts?.disconnects,
    approvals:
      data?.approvals?.waiting ??
      data?.approvalsWaiting ??
      data?.counts?.approvals,
  };
  const maxFunnel = Math.max(0, ...funnel.map(([, v]) => v));
  const maxTime = Math.max(0, ...time.map(([, v]) => v));
  const known = new Set([
    "funnel",
    "time",
    "timeBreakdown",
    "durations",
    "providers",
    "byProvider",
    "usage",
    "heatmap",
    "blockedHeatmap",
    "runs",
    "completed",
    "failed",
    "cancellations",
    "cancelled",
    "retries",
    "disconnects",
    "disconnections",
    "approvals",
    "approvalsWaiting",
    "counts",
    "since",
    "workspaceId",
    "workspace",
    "generatedAt",
  ]);
  const extras = data
    ? Object.entries(data).filter(
        ([key, value]) =>
          !known.has(key) &&
          (typeof value === "number" || typeof value === "string"),
      )
    : [];

  return (
    <section className="as-analytics" aria-label="Analytics">
      <header className="as-section-head">
        <h3>
          <ChartBar size={14} aria-hidden="true" /> Analytics
        </h3>
        <div className="as-row as-filters" role="group" aria-label="Time range">
          {RANGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`as-chip ${range === id ? "active" : ""}`}
              aria-pressed={range === id}
              onClick={() => setRange(id)}
            >
              {label}
            </button>
          ))}
          <a
            className="button"
            href={exportHref("csv")}
            download
            aria-label="Export analytics as CSV"
          >
            <Download size={12} /> Export CSV
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
      </header>
      <p className="as-muted as-small">
        Basis labels: <span className="as-tag">counted</span> from stored
        records · <span className="as-tag">reported</span> by the provider ·{" "}
        <span className="as-tag">measured</span> from recorded timestamps ·{" "}
        <span className="as-tag as-tag-warn">estimated</span> computed with
        stated assumptions. Missing data is shown as missing, never guessed.
      </p>
      {analytics.error ? (
        <div className="form-error" role="alert">
          {analytics.error.message}
        </div>
      ) : null}
      {!data && !analytics.error ? <p className="as-muted">Loading…</p> : null}
      {data ? (
        <div className={analytics.loading ? "as-stale" : ""}>
          <div className="as-tiles">
            <Tile
              label="Completed runs"
              value={formatNumber(counts.completed)}
              basis="counted"
            />
            <Tile
              label="Failed runs"
              value={formatNumber(counts.failed)}
              basis="counted"
            />
            <Tile
              label="Cancelled"
              value={formatNumber(counts.cancelled)}
              basis="counted"
            />
            <Tile
              label="Retries"
              value={formatNumber(counts.retries)}
              basis="counted"
            />
            <Tile
              label="Disconnects"
              value={formatNumber(counts.disconnects)}
              basis="counted"
            />
            <Tile
              label="Awaiting approval"
              value={formatNumber(counts.approvals)}
              basis="counted"
            />
          </div>

          <div className="as-analytics-grid">
            <article className="as-card">
              <h4>
                Funnel <span className="as-tag">counted</span>
              </h4>
              {funnel.length === 0 ? (
                <p className="as-muted">No funnel data.</p>
              ) : (
                <table className="as-table as-numeric">
                  <thead>
                    <tr>
                      <th scope="col">Stage</th>
                      <th scope="col">Tasks</th>
                      <th scope="col">
                        <span className="sr-only">Share of created</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.map(([stage, value]) => (
                      <tr key={stage}>
                        <th scope="row">{stage}</th>
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
              <h4>
                Time breakdown <span className="as-tag">measured</span>
              </h4>
              {time.length === 0 ? (
                <p className="as-muted">No timing data.</p>
              ) : (
                <table className="as-table as-numeric">
                  <thead>
                    <tr>
                      <th scope="col">State</th>
                      <th scope="col">Total</th>
                      <th scope="col">
                        <span className="sr-only">Share</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {time.map(([label, ms]) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
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
                Parallel runs overlap; totals are per-run time, not wall-clock
                project time.
              </p>
            </article>

            <article className="as-card as-span2">
              <h4>Usage by provider and model</h4>
              {providers.length === 0 ? (
                <p className="as-muted">
                  No usage reported by any provider in this range.
                </p>
              ) : (
                <div className="as-table-wrap">
                  <table className="as-table as-numeric">
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">Model</th>
                        <th scope="col">Runs</th>
                        <th scope="col">Input tokens</th>
                        <th scope="col">Output tokens</th>
                        <th scope="col">Cost</th>
                        <th scope="col">Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providers.map((row, i) => (
                        <tr key={`${row.provider}-${row.model}-${i}`}>
                          <th scope="row">{providerLabel(row.provider)}</th>
                          <td>{row.model}</td>
                          <td>{formatNumber(row.runs)}</td>
                          <td>
                            {row.input === null
                              ? "not reported"
                              : formatNumber(row.input)}
                          </td>
                          <td>
                            {row.output === null
                              ? "not reported"
                              : formatNumber(row.output)}
                          </td>
                          <td>
                            {row.cost === null
                              ? "not reported"
                              : typeof row.cost === "number"
                                ? `$${row.cost.toFixed(4)}`
                                : String(row.cost)}
                          </td>
                          <td>
                            <span
                              className={`as-tag ${row.estimated ? "as-tag-warn" : ""}`}
                            >
                              {row.estimated ? "estimated" : "reported"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>

            {heat ? (
              <article className="as-card as-span2">
                <div className="as-row as-wrap">
                  <h4>
                    Blocked time by task and hour{" "}
                    <span className="as-tag">measured</span>
                  </h4>
                  <button
                    type="button"
                    className="text-button"
                    aria-pressed={heatTable}
                    onClick={() => setHeatTable((v) => !v)}
                  >
                    <Table2 size={12} />{" "}
                    {heatTable ? "Show heatmap" : "Show as table"}
                  </button>
                </div>
                {heat.rows.length === 0 ? (
                  <p className="as-muted">No blocked time recorded.</p>
                ) : (
                  <div className="as-table-wrap">
                    <table
                      className={`as-table as-numeric ${heatTable ? "" : "as-heat"}`}
                    >
                      <thead>
                        <tr>
                          <th scope="col">Task</th>
                          {Array.from({ length: 24 }, (_, h) => (
                            <th key={h} scope="col" abbr={`${h}:00`}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {heat.rows.map((row) => (
                          <tr key={row.id}>
                            <th scope="row">
                              {String(row.title).slice(0, 32)}
                            </th>
                            {Array.from({ length: 24 }, (_, h) => {
                              const value = Number(row.hours[h]) || 0;
                              const step =
                                heat.max > 0 && value > 0
                                  ? Math.min(
                                      ramp.length - 1,
                                      Math.floor(
                                        (value / heat.max) * (ramp.length - 1),
                                      ),
                                    )
                                  : -1;
                              const fill =
                                step >= 0 ? ramp[step] : "transparent";
                              const ink =
                                step < 0
                                  ? undefined
                                  : DARK_INK.has(fill)
                                    ? "#27394a"
                                    : "#ffffff";
                              const text =
                                heat.unit === "ms"
                                  ? formatElapsed(value)
                                  : formatNumber(value);
                              return (
                                <td
                                  key={h}
                                  style={
                                    heatTable
                                      ? undefined
                                      : { background: fill, color: ink }
                                  }
                                  title={`${row.title}, ${h}:00 — ${text}`}
                                  aria-label={`${h}:00, ${text}`}
                                >
                                  {heatTable
                                    ? value
                                      ? text
                                      : ""
                                    : value
                                      ? heat.unit === "ms"
                                        ? Math.round(value / 60000)
                                        : value
                                      : ""}
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
                  {heatTable ? "Values" : "Cell values"} are{" "}
                  {heat.unit === "ms" ? "minutes blocked" : "blocked events"};
                  darker means more (single-hue scale). Hover a cell for the
                  exact value.
                </p>
              </article>
            ) : null}

            {extras.length ? (
              <article className="as-card as-span2">
                <h4>
                  Other measures <span className="as-tag">counted</span>
                </h4>
                <table className="as-table as-numeric">
                  <tbody>
                    {extras.map(([key, value]) => (
                      <tr key={key}>
                        <th scope="row">{key}</th>
                        <td>
                          {typeof value === "number"
                            ? formatNumber(value)
                            : value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
