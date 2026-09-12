/**
 * Plain-language summaries for the Operations page, from GET /api/ops/health.
 * Nothing is shown before the health check answers, and each word matches
 * the product's vocabulary (Available / Installed, never "ready"/"detected").
 */

/** "Healthy" / "Needs attention" / "Down", with when it was checked. */
export function healthSummary(data) {
  if (!data) return { tone: "neutral", label: "Checking health…", detail: "" };
  const checked = data.checkedAt
    ? `checked ${new Date(data.checkedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "";
  const alerts = Array.isArray(data.alerts) ? data.alerts.length : 0;
  if (data.status === "down")
    return {
      tone: "bad",
      label: "Down",
      detail: [
        data.db?.writable === false ? "the database is not writable" : null,
        checked,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  if (data.status === "ok")
    return { tone: "ok", label: "Healthy", detail: checked };
  return {
    tone: "warn",
    label: "Needs attention",
    detail: [`${alerts} alert${alerts === 1 ? "" : "s"}`, checked]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Installed and available assistants on this machine (default accounts only,
 * as in the top bar). "Available" means enabled with a sign-in file found; a
 * CLI that is not installed is not counted at all.
 */
export function providerCounts(data) {
  const rows = (data?.providers?.connections ?? []).filter(
    (row) => !row.alias || row.alias === "default",
  );
  const installed = rows.filter((row) => row.status !== "missing");
  const available = installed.filter(
    (row) => row.status === "ready" && row.enabled !== false,
  );
  return { installed: installed.length, available: available.length };
}

/** 1536 → "1.5 KB"; null stays null. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return null;
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} bytes`
    : `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
