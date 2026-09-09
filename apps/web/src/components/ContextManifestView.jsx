import React, { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { apiFetch, formatNumber, maskPath } from "../hooks/useApi.js";

/**
 * Shows exactly which files, instructions and documents would be attached to
 * a run (POST /api/workspaces/:id/context/preview). Token counts are labelled
 * "estimate"; secret and out-of-scope files are listed with the reason.
 * @param {{ workspaceId: string, taskId?: string, agentId?: string, files?: string[], presentation?: boolean }} props
 */
export default function ContextManifestView({
  workspaceId,
  taskId,
  agentId,
  files,
  presentation = false,
}) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/context/preview`,
        {
          method: "POST",
          body: { taskId, agentId, files },
        },
      );
      setManifest(result?.manifest ?? result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (workspaceId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, taskId, agentId, JSON.stringify(files ?? [])]);

  const included = (manifest?.files ?? []).filter((f) => f.included !== false);
  const excluded = [
    ...(manifest?.files ?? []).filter((f) => f.included === false),
    ...(manifest?.excluded ?? []),
  ];
  return (
    <section className="as-context" aria-label="Context manifest">
      <header className="as-section-head">
        <h3>
          <FileText size={14} aria-hidden="true" /> Context manifest
        </h3>
        <button
          type="button"
          className="icon-button"
          aria-label="Recompute context"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading && !manifest ? <p className="as-muted">Computing…</p> : null}
      {manifest ? (
        <>
          <p className="as-muted">
            <strong>{formatNumber(manifest.estimatedTokens)}</strong> tokens{" "}
            <span className="as-tag">estimate</span> · {included.length}{" "}
            included · {excluded.length} excluded
          </p>
          <h4>Included</h4>
          {included.length === 0 ? (
            <p className="as-muted">No files attached.</p>
          ) : (
            <table className="as-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Bytes</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {included.map((file) => (
                  <tr key={file.path}>
                    <td className="as-mono">
                      {maskPath(file.path, presentation)}
                    </td>
                    <td className="as-mono">
                      {String(file.revision ?? "—").slice(0, 12)}
                    </td>
                    <td>{formatNumber(file.bytes)}</td>
                    <td>{file.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4>Excluded</h4>
          {excluded.length === 0 ? (
            <p className="as-muted">Nothing excluded.</p>
          ) : (
            <ul className="as-excluded">
              {excluded.map((file) => (
                <li key={file.path}>
                  <code className="as-mono">
                    {maskPath(file.path, presentation)}
                  </code>{" "}
                  <span
                    className={`as-tag ${file.reason === "secret" ? "as-tag-warn" : ""}`}
                  >
                    {file.reason ?? "excluded"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {manifest.instructions?.length ? (
            <>
              <h4>Instructions</h4>
              <ul className="as-excluded">
                {manifest.instructions.map((item, index) => (
                  <li key={index}>
                    {typeof item === "string"
                      ? item
                      : (item.path ?? item.title ?? JSON.stringify(item))}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {manifest.documents?.length ? (
            <>
              <h4>Documents</h4>
              <ul className="as-excluded">
                {manifest.documents.map((item, index) => (
                  <li key={index}>
                    {typeof item === "string"
                      ? item
                      : (item.title ?? item.path ?? JSON.stringify(item))}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
