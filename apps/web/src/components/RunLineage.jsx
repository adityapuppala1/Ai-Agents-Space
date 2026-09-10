import React, { useMemo } from "react";
import { GitCommitVertical, ShieldQuestion, Share2, Flag } from "lucide-react";
import {
  useApi,
  formatTime,
  maskPath,
  RUN_STATUS_LABELS,
  providerLabel,
} from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

const NODE_TEXT = {
  run: "run",
  file: "input file",
  document: "document",
  artifact: "artifact",
  review: "review",
  result: "accepted result",
  task: "task",
};

function Section({ icon, title, children, note }) {
  return (
    <article className="as-card as-lineage-section">
      <h4>
        {icon} {title}
      </h4>
      {children}
      {note ? <p className="as-muted as-small">{note}</p> : null}
    </article>
  );
}

/**
 * The Lineage tab of the run inspector.
 *
 * It joins the records that explain how a run came to its result:
 *   input revisions → the run and its attempts → outputs → review decisions,
 * plus evaluation dimensions (with the grader's identity when one is
 * recorded), the context transfers that say which provider received which
 * inputs, workflow checkpoints, task-contract outcomes, and any
 * request-change decisions.
 *
 * Nothing here is inferred: each block is a read of a stored table, and a
 * block whose route is missing says so rather than rendering as empty.
 *
 * Routes: GET /api/analytics/lineage?run=, GET /api/evaluations?run=,
 * GET /api/runs/:id/transfers, GET /api/workspaces/:id/checkpoints,
 * GET /api/workspaces/:id/tasks/:taskId/contract, GET /api/runs/:id/decisions,
 * GET /api/audit?run=.
 *
 * @param {{ run: any, workspaceId?: string|null, presentation?: boolean, onOpenRun?: (runId:string)=>void }} props
 */
export default function RunLineage({
  run,
  workspaceId = null,
  presentation = false,
  onOpenRun,
}) {
  const runId = run?.id ?? null;
  const wsId = workspaceId ?? run?.workspaceId ?? null;
  const taskId = run?.taskId ?? null;

  const lineage = useApi(
    runId ? `/analytics/lineage?run=${encodeURIComponent(runId)}` : null,
  );
  const evaluations = useApi(
    runId ? `/evaluations?run=${encodeURIComponent(runId)}` : null,
  );
  const transfers = useApi(
    runId ? `/runs/${encodeURIComponent(runId)}/transfers` : null,
  );
  const decisions = useApi(
    runId ? `/runs/${encodeURIComponent(runId)}/decisions` : null,
  );
  const checkpoints = useApi(
    wsId ? `/workspaces/${encodeURIComponent(wsId)}/checkpoints` : null,
  );
  const contract = useApi(
    wsId && taskId
      ? `/workspaces/${encodeURIComponent(wsId)}/tasks/${encodeURIComponent(taskId)}/contract`
      : null,
  );
  const audit = useApi(
    runId ? `/audit?run=${encodeURIComponent(runId)}&limit=100` : null,
  );

  const nodes = lineage.data?.nodes ?? [];
  const edges = lineage.data?.edges ?? [];
  const runNodes = nodes.filter((node) => node.type === "run");
  const inputNodes = nodes.filter(
    (node) => node.type === "file" || node.type === "document",
  );
  const outputNodes = nodes.filter(
    (node) => node.type === "artifact" || node.type === "result",
  );
  const reviewNodes = nodes.filter((node) => node.type === "review");

  const evalRows = evaluations.data?.evaluations ?? [];
  const transferRows = transfers.data?.transfers ?? [];
  const decisionRows = useMemo(() => {
    const data = decisions.data;
    const list = Array.isArray(data) ? data : (data?.decisions ?? []);
    return list;
  }, [decisions.data]);
  const changeRequests = decisionRows.filter(
    (row) => row.decision === "request-change",
  );
  const checkpointRows = (
    Array.isArray(checkpoints.data)
      ? checkpoints.data
      : (checkpoints.data?.checkpoints ?? [])
  ).filter((row) => !runId || !row.runId || row.runId === runId);
  const contractFailures = (Array.isArray(audit.data) ? audit.data : []).filter(
    (entry) => String(entry.action ?? "").startsWith("task.contract"),
  );

  return (
    <div className="as-lineage">
      {/* ------------------------------------------------ artifact lineage */}
      <Section
        icon={<Share2 size={13} aria-hidden="true" />}
        title="Artifact lineage"
        note="Input revisions are the file hashes recorded in the run's context manifest, not a re-read of the files as they are now."
      >
        {lineage.error ? (
          <EmptyState
            compact
            title="Lineage is unavailable"
            error={lineage.error}
            missingRoutes={["GET /api/analytics/lineage"]}
          />
        ) : null}
        {!lineage.error && nodes.length === 0 && !lineage.loading ? (
          <EmptyState
            compact
            title="No lineage recorded"
            description="This run has no context manifest, artifacts, or review decision to join yet."
          />
        ) : null}
        {nodes.length ? (
          <div className="as-lineage-columns">
            <div>
              <h5>Inputs ({inputNodes.length})</h5>
              <ul className="as-lineage-nodes" role="list">
                {inputNodes.length === 0 ? (
                  <li className="as-muted as-small">
                    No input revisions recorded.
                  </li>
                ) : null}
                {inputNodes.map((node) => (
                  <li key={node.id}>
                    <span className="as-tag">
                      {NODE_TEXT[node.type] ?? node.type}
                    </span>
                    <code className="as-mono">
                      {maskPath(node.label ?? node.id, presentation)}
                    </code>
                    {node.revision ? (
                      <span className="as-muted as-small">
                        revision {String(node.revision).slice(0, 20)}
                      </span>
                    ) : (
                      <span className="as-muted as-small">
                        revision not recorded
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h5>Attempts ({runNodes.length})</h5>
              <ol className="as-lineage-nodes" role="list">
                {runNodes.map((node) => (
                  <li key={node.id}>
                    <span className="as-tag">attempt {node.attempt ?? 1}</span>
                    <span>{providerLabel(node.provider)}</span>
                    <span className="as-tag">
                      {RUN_STATUS_LABELS[node.status] ?? node.status}
                    </span>
                    <span className="as-muted as-small">
                      {node.model ?? "model not reported"}
                      {node.timestamp ? ` · ${formatTime(node.timestamp)}` : ""}
                    </span>
                    {node.runId && node.runId !== runId && onOpenRun ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpenRun(node.runId)}
                      >
                        Open
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
              <p className="as-muted as-small">
                {edges.filter((edge) => edge.kind === "retried-as").length}{" "}
                retry link(s) recorded.
              </p>
            </div>
            <div>
              <h5>
                Outputs and review ({outputNodes.length + reviewNodes.length})
              </h5>
              <ul className="as-lineage-nodes" role="list">
                {outputNodes.length + reviewNodes.length === 0 ? (
                  <li className="as-muted as-small">
                    Nothing produced or reviewed yet.
                  </li>
                ) : null}
                {[...outputNodes, ...reviewNodes].map((node) => (
                  <li key={node.id}>
                    <span className="as-tag">
                      {NODE_TEXT[node.type] ?? node.type}
                    </span>
                    <span>{node.label ?? node.id}</span>
                    {node.timestamp ? (
                      <span className="as-muted as-small">
                        {formatTime(node.timestamp)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Section>

      {/* ---------------------------------------------------- evaluations */}
      <Section
        icon={<ShieldQuestion size={13} aria-hidden="true" />}
        title="Evaluation dimensions"
        note="Agent Space computes completion, availability and recorded human acceptance from its own records. It never asserts correctness or security itself: those stay `unknown` until a human reviewer or a named model grader supplies a verdict, and a model verdict is shown as that model's claim."
      >
        {evaluations.error ? (
          <EmptyState
            compact
            title="Evaluations are unavailable"
            error={evaluations.error}
            missingRoutes={["GET /api/evaluations"]}
          />
        ) : null}
        {!evaluations.error && evalRows.length === 0 && !evaluations.loading ? (
          <EmptyState
            compact
            title="No evaluation recorded for this run"
            description="Record a human verdict, or run the objective check, to give this run a dimension."
          />
        ) : null}
        {evalRows.length ? (
          <div className="as-table-wrap">
            <table className="as-table">
              <thead>
                <tr>
                  <th scope="col">Dimension</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Score</th>
                  <th scope="col">Grader</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {evalRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.dimension}</th>
                    <td>
                      <span
                        className={`as-tag ${row.verdict === "fail" ? "as-tag-warn" : ""}`}
                      >
                        {row.verdict}
                      </span>
                    </td>
                    <td>{row.score ?? "—"}</td>
                    <td>
                      {row.grader?.kind ?? "not recorded"}
                      {row.grader?.identity ? ` · ${row.grader.identity}` : ""}
                      {row.grader?.version ? ` (${row.grader.version})` : ""}
                    </td>
                    <td className="as-small as-muted">
                      {row.claim
                        ? "a claim by that model, not established here"
                        : row.grader?.kind === "objective"
                          ? "computed from stored records"
                          : "recorded human decision"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      {/* ----------------------------------------------- context transfers */}
      <Section
        icon={<GitCommitVertical size={13} aria-hidden="true" />}
        title="Context transfers"
        note="Which provider and host received which inputs. This is the record of what left this machine."
      >
        {transfers.error ? (
          <EmptyState
            compact
            title="Transfers are unavailable"
            error={transfers.error}
            missingRoutes={["GET /api/runs/:id/transfers"]}
          />
        ) : null}
        {!transfers.error && transferRows.length === 0 && !transfers.loading ? (
          <EmptyState
            compact
            title="No transfer recorded"
            description="Nothing has been sent to a provider for this run yet."
          />
        ) : null}
        {transferRows.length ? (
          <ul className="as-lineage-nodes" role="list">
            {transferRows.map((row, index) => (
              <li key={row.id ?? index}>
                <span className="as-tag">{providerLabel(row.provider)}</span>
                <span>{row.host ?? "local"}</span>
                <span className="as-muted as-small">
                  {row.files ?? row.fileCount ?? 0} file(s)
                  {row.bytes ? ` · ${row.bytes} bytes` : ""}
                  {(row.at ?? row.timestamp)
                    ? ` · ${formatTime(row.at ?? row.timestamp)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* ------------------------------------------- contract + checkpoints */}
      <Section
        icon={<Flag size={13} aria-hidden="true" />}
        title="Task contract, checkpoints and change requests"
      >
        <h5>Contract</h5>
        {contract.error ? (
          <EmptyState
            compact
            title="Contract unavailable"
            error={contract.error}
            missingRoutes={["GET /api/workspaces/:id/tasks/:taskId/contract"]}
          />
        ) : contract.data ? (
          <dl className="as-passport as-lineage-contract">
            <div>
              <dt>Completion criteria</dt>
              <dd>
                {(contract.data.completionCriteria ?? []).join("; ") ||
                  "none recorded"}
              </dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>{contract.data.reviewer ?? "none recorded"}</dd>
            </div>
            <div>
              <dt>Output schema</dt>
              <dd>{contract.data.outputSchema ? "recorded" : "none"}</dd>
            </div>
          </dl>
        ) : (
          <p className="as-muted as-small">No contract set for this task.</p>
        )}

        <h5>Contract outcomes</h5>
        {contractFailures.length === 0 ? (
          <p className="as-muted as-small">
            No contract check has been recorded against this run.
          </p>
        ) : (
          <ul className="as-lineage-nodes" role="list">
            {contractFailures.map((entry) => (
              <li key={entry.id}>
                <span
                  className={`as-tag ${entry.action?.includes("failed") ? "as-tag-warn" : ""}`}
                >
                  {entry.action}
                </span>
                <span className="as-muted as-small">
                  {formatTime(entry.timestamp ?? entry.createdAt)} · by{" "}
                  {entry.actor ?? "system"}
                </span>
                {entry.details ? (
                  <code className="as-mono as-small">
                    {JSON.stringify(entry.details).slice(0, 200)}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <h5>Checkpoints</h5>
        {checkpoints.error ? (
          <EmptyState
            compact
            title="Checkpoints unavailable"
            error={checkpoints.error}
            missingRoutes={["GET /api/workspaces/:id/checkpoints"]}
          />
        ) : checkpointRows.length === 0 ? (
          <p className="as-muted as-small">
            No checkpoint covers this run. A checkpoint records task statuses
            only; restoring one never re-runs work and never touches files.
          </p>
        ) : (
          <ul className="as-lineage-nodes" role="list">
            {checkpointRows.slice(0, 10).map((row) => (
              <li key={row.id}>
                <span className="as-tag">{row.kind ?? "manual"}</span>
                <span>{row.label ?? row.id.slice(0, 8)}</span>
                <span className="as-muted as-small">
                  {formatTime(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h5>Request-change outcomes</h5>
        {decisions.error ? (
          <EmptyState
            compact
            title="Decisions unavailable"
            error={decisions.error}
            missingRoutes={["GET /api/runs/:id/decisions"]}
          />
        ) : changeRequests.length === 0 ? (
          <p className="as-muted as-small">
            No change was requested on this run. A request-change leaves the
            approval pending: the run keeps waiting until it is approved or
            denied.
          </p>
        ) : (
          <ul className="as-lineage-nodes" role="list">
            {changeRequests.map((row) => (
              <li key={row.id}>
                <span className="as-tag as-tag-warn">change requested</span>
                <span>{row.note ?? "no note recorded"}</span>
                <span className="as-muted as-small">
                  by {row.actor} · {formatTime(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
