import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Workflow,
  Plus,
  Link2,
  Unlink,
  ShieldCheck,
  Save,
  Trash2,
  FileJson,
} from "lucide-react";
import { apiFetch, useApi, layerGraph } from "../hooks/useApi.js";
import {
  addStepDraft,
  removeStepDraft,
  updateStepDraft,
  addEdgeDraft,
  removeEdgeDraft,
  draftEdges,
  hasEdge,
  summarizeDraft,
  blankStep,
} from "../hooks/workflowEdit.js";
import EmptyState from "../components/EmptyState.jsx";

const NODE_W = 170;
const NODE_H = 46;
const GAP_X = 70;
const GAP_Y = 18;

const PROBLEM_TEXT = {
  cycle: "Dependency cycle",
  unreachable: "Unreachable step",
  "missing-input": "Missing input",
  "permission-conflict": "Permission conflict",
};

/** Element ids must survive step keys, which may carry hyphens and digits. */
const slug = (value) => String(value).replace(/[^a-zA-Z0-9-]/g, "-");

/**
 * Visual editor for a workflow's step graph.
 *
 * The graph it draws is `definition.steps[]` — the same array the versioned
 * export already writes — so every save is a new, reviewable version of the
 * file format that already ships, with `formatVersion` unchanged.
 *
 * The four launch checks (cycles, unreachable steps, missing inputs,
 * permission conflicts) are never computed here: Validate posts the draft to
 * `POST /api/workflows/:id/validate-draft` and Save re-runs the same checks
 * server-side, so there is one copy of them in the product.
 *
 * Everything is reachable from the keyboard: the canvas nodes are buttons,
 * `L` links the focused step into the selected one, `Delete` unlinks it, and
 * the same three actions have plain form controls below the canvas.
 *
 * @param {{ workspaceId: string, onOpenTask?: (taskId: string) => void }} props
 */
export default function WorkflowEditor({ workspaceId, onOpenTask }) {
  const list = useApi(
    workspaceId
      ? `/workspaces/${encodeURIComponent(workspaceId)}/workflows`
      : null,
  );
  const [workflowId, setWorkflowId] = useState("");
  const detail = useApi(
    workflowId
      ? `/workflows/${encodeURIComponent(workflowId)}/definition`
      : null,
  );
  const drift = useApi(
    workflowId
      ? `/workflows/${encodeURIComponent(workflowId)}/materialization`
      : null,
  );

  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const [link, setLink] = useState({ from: "", to: "" });
  const [fileText, setFileText] = useState("");

  const workflows = list.data ?? [];
  const loaded = detail.data ?? null;
  const roles = loaded?.roles ?? [];
  const requiredTools = loaded?.requiredTools ?? [];

  useEffect(() => {
    if (!workflowId && workflows.length) setWorkflowId(workflows[0].id);
  }, [workflows, workflowId]);

  // The baseline follows whatever the server last returned, including the
  // version a save just wrote.
  useEffect(() => {
    if (!loaded) return;
    setDraft(structuredClone(loaded.definition ?? {}));
    setForm(blankStep(loaded.roles ?? []));
  }, [loaded]);

  // Transient state belongs to the chosen workflow, not to a reload: clearing
  // it on every fetch would wipe the confirmation a save just wrote.
  useEffect(() => {
    setSelected(null);
    setReport(null);
    setMessage("");
    setError("");
    setFileText("");
  }, [workflowId]);

  const steps = useMemo(() => draft?.steps ?? [], [draft]);
  const edges = useMemo(() => draftEdges(draft), [draft]);
  const summary = useMemo(
    () => summarizeDraft(loaded?.definition ?? {}, draft ?? {}),
    [loaded, draft],
  );
  const selectedStep = steps.find((step) => step.key === selected) ?? null;

  const layout = useMemo(() => {
    if (!steps.length) return null;
    const nodes = steps.map((step) => ({ id: step.key }));
    const { layers, position } = layerGraph(nodes, edges);
    const tallest = Math.max(1, ...layers.map((layer) => layer.length));
    const width = Math.max(1, layers.length) * (NODE_W + GAP_X) + 20;
    const height = tallest * (NODE_H + GAP_Y) + 20;
    const place = (id) => {
      const point = position.get(id);
      if (!point) return null;
      const layerHeight = layers[point.layer].length * (NODE_H + GAP_Y);
      return {
        x: 10 + point.layer * (NODE_W + GAP_X),
        y:
          10 + (height - 20 - layerHeight) / 2 + point.index * (NODE_H + GAP_Y),
      };
    };
    return { place, width, height };
  }, [steps, edges]);

  const touch = (next) => {
    setDraft(next);
    setReport(null);
    setError("");
  };

  const addLink = (from, to) => {
    if (!from || !to || from === to) {
      setError("A step cannot wait for itself.");
      return;
    }
    if (hasEdge(draft, from, to)) {
      setError(`"${to}" already waits for "${from}".`);
      return;
    }
    touch(addEdgeDraft(draft, from, to));
    setMessage(
      `"${to}" now waits for "${from}". Nothing is written until you save.`,
    );
  };

  const dropLink = (from, to) => {
    touch(removeEdgeDraft(draft, from, to));
    setMessage(`"${to}" no longer waits for "${from}".`);
  };

  const addStep = (event) => {
    event.preventDefault();
    if (!form?.key.trim() || !form.title.trim()) {
      setError("A new step needs a key and a title.");
      return;
    }
    touch(addStepDraft(draft, { ...form, key: form.key.trim() }));
    setMessage(
      `Step "${form.key.trim()}" added to the draft. Validate it, then save.`,
    );
    setSelected(form.key.trim());
    setForm(blankStep(roles));
  };

  const removeStep = (key) => {
    const dependents = steps
      .filter((step) => (step.dependsOn ?? []).includes(key))
      .map((step) => step.key);
    if (
      dependents.length &&
      !globalThis.confirm?.(
        `${dependents.join(", ")} wait for "${key}". Remove those links too?`,
      )
    )
      return;
    touch(removeStepDraft(draft, key, { cascade: true }));
    setSelected(null);
    setMessage(
      `Step "${key}" removed from the draft. Any task already created for it is kept.`,
    );
  };

  const validate = useCallback(async () => {
    if (!workflowId || !draft) return;
    setBusy(true);
    setError("");
    try {
      setReport(
        await apiFetch(
          `/workflows/${encodeURIComponent(workflowId)}/validate-draft`,
          { method: "POST", body: { definition: draft } },
        ),
      );
    } catch (err) {
      setReport(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [workflowId, draft]);

  const save = async () => {
    if (!workflowId || !draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    setFileText(""); // an exported document from before the save is stale
    try {
      const saved = await apiFetch(
        `/workflows/${encodeURIComponent(workflowId)}/definition`,
        {
          method: "PUT",
          body: { definition: draft, expectedHash: loaded?.definitionHash },
        },
      );
      setMessage(
        `Saved as version ${saved.version}, status draft. Publish it from the workflow once it has been reviewed.`,
      );
      await detail.reload();
      await drift.reload();
      await list.reload();
    } catch (err) {
      setError(
        err.status === 409
          ? `${err.message} Nothing was overwritten.`
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const showFile = async () => {
    if (fileText) {
      setFileText("");
      return;
    }
    try {
      const exported = await apiFetch(
        `/workflows/${encodeURIComponent(workflowId)}/export`,
      );
      setFileText(JSON.stringify(exported, null, 2));
    } catch (err) {
      setError(err.message);
    }
  };

  if (list.error)
    return (
      <EmptyState
        title="Workflows are unavailable"
        error={list.error}
        missingRoutes={["GET /api/workspaces/:id/workflows"]}
      />
    );
  if (!list.loading && workflows.length === 0)
    return (
      <EmptyState
        icon={<Workflow size={28} />}
        title="No workflow to edit yet"
        description="Instantiate a template from the task board first. The editor edits the workflow definition — the file a reviewer reads in Git — not the tasks it already created."
      />
    );

  const editable = loaded?.editable !== false;

  return (
    <section className="as-wfeditor" aria-label="Workflow editor">
      <header className="as-section-head">
        <h3>
          <Workflow size={14} aria-hidden="true" /> Workflow editor
        </h3>
        <span className="as-muted">
          {steps.length} step(s) · {edges.length} link(s) · arrows point to the
          step that waits
        </span>
      </header>

      <div className="as-row as-wrap as-wfeditor-bar">
        <label className="as-inline-label" htmlFor="wf-editor-workflow">
          Workflow
        </label>
        <select
          id="wf-editor-workflow"
          value={workflowId}
          onChange={(event) => setWorkflowId(event.target.value)}
        >
          {workflows.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {loaded ? (
          <span className="as-tag">
            Version {loaded.version} ·{" "}
            {loaded.publishedAt ? "published" : "draft"}
          </span>
        ) : null}
        {summary.changes ? (
          <span className="as-tag as-tag-warn">
            {summary.changes} unsaved change(s)
          </span>
        ) : null}
      </div>

      {detail.error ? (
        <EmptyState
          title="This workflow's definition is unavailable"
          error={detail.error}
          missingRoutes={["GET /api/workflows/:id/definition"]}
        />
      ) : null}
      {!editable ? (
        <p className="as-feedback" role="status">
          This workflow is orchestrated by {loaded?.owner}. Its definition is
          edited there, and Agent Space will refuse a save.
        </p>
      ) : null}
      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}

      {layout ? (
        <div className="as-depmap-scroll">
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
            role="group"
            aria-label="Workflow step graph"
          >
            <defs>
              <marker
                id="as-wf-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" className="as-dep-arrow" />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const a = layout.place(edge.from);
              const b = layout.place(edge.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              return (
                <path
                  key={`${edge.from}-${edge.to}-${index}`}
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  className="as-dep-edge"
                  markerEnd="url(#as-wf-arrow)"
                />
              );
            })}
            {steps.map((step) => {
              const point = layout.place(step.key);
              if (!point) return null;
              const linked = selected && hasEdge(draft, step.key, selected);
              return (
                <g
                  key={step.key}
                  transform={`translate(${point.x},${point.y})`}
                  className={`as-dep-node as-dep-queue ${selected === step.key ? "selected" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${step.title || step.key}, step ${step.key}${
                    selected && selected !== step.key
                      ? `. Press L to make ${selected} wait for it${linked ? ", or Delete to unlink it" : ""}`
                      : ". Press Enter to select it"
                  }`}
                  onClick={() => setSelected(step.key)}
                  onKeyDown={(event) => {
                    const key = event.key.toLowerCase();
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(step.key);
                    } else if (
                      editable &&
                      key === "l" &&
                      selected &&
                      selected !== step.key
                    ) {
                      event.preventDefault();
                      addLink(step.key, selected);
                    } else if (
                      editable &&
                      (event.key === "Delete" || event.key === "Backspace") &&
                      selected &&
                      linked
                    ) {
                      event.preventDefault();
                      dropLink(step.key, selected);
                    }
                  }}
                >
                  <rect width={NODE_W} height={NODE_H} rx={8} />
                  <text x={10} y={18} className="as-dep-title">
                    {String(step.title || step.key).slice(0, 24)}
                  </text>
                  <text x={10} y={35} className="as-dep-status">
                    {step.key}
                    {step.role ? ` · ${step.role}` : ""}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}

      <div className="as-wfeditor-grid">
        <form className="as-wfeditor-panel" onSubmit={addStep}>
          <fieldset disabled={!editable || busy}>
            <legend>
              <Plus size={12} aria-hidden="true" /> Add a step
            </legend>
            <label htmlFor="wf-new-key">Step key</label>
            <input
              id="wf-new-key"
              value={form?.key ?? ""}
              placeholder="triage"
              onChange={(event) =>
                setForm({ ...form, key: event.target.value.toLowerCase() })
              }
            />
            <label htmlFor="wf-new-title">Step title</label>
            <input
              id="wf-new-title"
              value={form?.title ?? ""}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
            />
            <label htmlFor="wf-new-role">Role</label>
            <select
              id="wf-new-role"
              value={form?.role ?? ""}
              onChange={(event) =>
                setForm({ ...form, role: event.target.value })
              }
            >
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name ?? role.key}
                </option>
              ))}
            </select>
            <label htmlFor="wf-new-instructions">Instructions</label>
            <textarea
              id="wf-new-instructions"
              rows={2}
              value={form?.instructions ?? ""}
              onChange={(event) =>
                setForm({ ...form, instructions: event.target.value })
              }
            />
            <label htmlFor="wf-new-deliverable">Deliverable</label>
            <input
              id="wf-new-deliverable"
              value={form?.deliverable ?? ""}
              onChange={(event) =>
                setForm({ ...form, deliverable: event.target.value })
              }
            />
            <label htmlFor="wf-new-dependson">Waits for (optional)</label>
            <select
              id="wf-new-dependson"
              value={form?.dependsOn?.[0] ?? ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  dependsOn: event.target.value ? [event.target.value] : [],
                })
              }
            >
              <option value="">Nothing — this step can start first</option>
              {steps.map((step) => (
                <option key={step.key} value={step.key}>
                  {step.title || step.key}
                </option>
              ))}
            </select>
            <fieldset className="as-wfeditor-tools">
              <legend>Tools this step may use</legend>
              {requiredTools.length === 0 ? (
                <p className="as-muted as-small">
                  This workflow declares no tool vocabulary, so the step gets
                  none. The save path refuses a tool outside it.
                </p>
              ) : null}
              {requiredTools.map((tool) => (
                <label key={tool} htmlFor={`wf-new-tool-${slug(tool)}`}>
                  <input
                    type="checkbox"
                    id={`wf-new-tool-${slug(tool)}`}
                    checked={
                      form?.contract?.allowedTools?.includes(tool) ?? false
                    }
                    onChange={(event) => {
                      const current = form?.contract?.allowedTools ?? [];
                      setForm({
                        ...form,
                        contract: {
                          ...form.contract,
                          allowedTools: event.target.checked
                            ? [...current, tool]
                            : current.filter((entry) => entry !== tool),
                        },
                      });
                    }}
                  />
                  {tool}
                </label>
              ))}
            </fieldset>
            <button type="submit" className="button">
              <Plus size={12} aria-hidden="true" /> Add step
            </button>
          </fieldset>
        </form>

        <div className="as-wfeditor-panel">
          <h4>
            <Link2 size={13} aria-hidden="true" /> Links
          </h4>
          <p className="as-muted as-small">
            A link means the second step waits for the first. On the canvas,
            select a step, then press <kbd>L</kbd> on another one to make the
            selection wait for it, or <kbd>Delete</kbd> to unlink it.
          </p>
          <label htmlFor="wf-link-from">Link from</label>
          <select
            id="wf-link-from"
            value={link.from}
            disabled={!editable}
            onChange={(event) => setLink({ ...link, from: event.target.value })}
          >
            <option value="">Choose the step that runs first…</option>
            {steps.map((step) => (
              <option key={step.key} value={step.key}>
                {step.title || step.key}
              </option>
            ))}
          </select>
          <label htmlFor="wf-link-to">Link to</label>
          <select
            id="wf-link-to"
            value={link.to}
            disabled={!editable}
            onChange={(event) => setLink({ ...link, to: event.target.value })}
          >
            <option value="">Choose the step that waits…</option>
            {steps.map((step) => (
              <option key={step.key} value={step.key}>
                {step.title || step.key}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={!editable || busy}
            onClick={() => addLink(link.from, link.to)}
          >
            <Link2 size={12} aria-hidden="true" /> Add link
          </button>
          <ul className="as-depeditor-list" aria-label="Links in this workflow">
            {edges.length === 0 ? (
              <li className="as-muted as-small">No links yet.</li>
            ) : null}
            {edges.map((edge) => (
              <li key={`${edge.from}->${edge.to}`}>
                <span>
                  {edge.from} → {edge.to}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  disabled={!editable || busy}
                  aria-label={`Remove the link from ${edge.from} to ${edge.to}`}
                  onClick={() => dropLink(edge.from, edge.to)}
                >
                  <Unlink size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="as-wfeditor-panel">
          <h4>Selected step</h4>
          {!selectedStep ? (
            <p className="as-muted as-small">
              Select a step on the canvas (click it, or Tab to it and press
              Enter) to edit its wording or remove it.
            </p>
          ) : (
            <>
              <label htmlFor={`wf-step-${slug(selectedStep.key)}-title`}>
                Title of {selectedStep.key}
              </label>
              <input
                id={`wf-step-${slug(selectedStep.key)}-title`}
                value={selectedStep.title ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  touch(
                    updateStepDraft(draft, selectedStep.key, {
                      title: event.target.value,
                    }),
                  )
                }
              />
              <label htmlFor={`wf-step-${slug(selectedStep.key)}-instructions`}>
                Instructions for {selectedStep.key}
              </label>
              <textarea
                id={`wf-step-${slug(selectedStep.key)}-instructions`}
                rows={3}
                value={selectedStep.instructions ?? ""}
                disabled={!editable}
                onChange={(event) =>
                  touch(
                    updateStepDraft(draft, selectedStep.key, {
                      instructions: event.target.value,
                    }),
                  )
                }
              />
              <button
                type="button"
                className="button"
                disabled={!editable || busy}
                onClick={() => removeStep(selectedStep.key)}
              >
                <Trash2 size={12} aria-hidden="true" /> Remove step
              </button>
            </>
          )}
        </div>
      </div>

      <div className="as-row as-wrap">
        <button
          type="button"
          className="button"
          onClick={validate}
          disabled={busy || !draft}
        >
          <ShieldCheck size={12} aria-hidden="true" /> Validate
        </button>
        <button
          type="button"
          className="button primary"
          onClick={save}
          disabled={busy || !editable || summary.changes === 0}
        >
          <Save size={12} aria-hidden="true" /> Save as a new version
        </button>
        <button type="button" className="button" onClick={showFile}>
          <FileJson size={12} aria-hidden="true" />{" "}
          {fileText ? "Hide the file" : "View as file"}
        </button>
        {summary.changes ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(structuredClone(loaded?.definition ?? {}));
              setReport(null);
              setMessage("Draft discarded.");
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>

      {report ? (
        <div
          className={`as-verdict as-verdict-${report.ok ? "allow" : "deny"}`}
          role="status"
        >
          <strong>{report.ok ? "VALID" : "PROBLEMS FOUND"}</strong>
          <span>
            {report.checked} step(s) checked · {(report.problems ?? []).length}{" "}
            problem(s)
          </span>
          {(report.problems ?? []).length ? (
            <ul className="as-validation-list">
              {report.problems.map((problem, index) => (
                <li key={`${problem.code}-${problem.taskId}-${index}`}>
                  <span className="as-tag as-tag-warn">
                    {PROBLEM_TEXT[problem.code] ?? problem.code}
                  </span>
                  <span>{problem.title ?? problem.taskId ?? "workflow"}</span>
                  <span className="as-muted as-small">{problem.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {fileText ? (
        <div className="as-wfeditor-file">
          <h4>
            <FileJson size={13} aria-hidden="true" /> The file a reviewer reads
          </h4>
          <p className="as-muted as-small">
            The saved document, exactly as `GET /api/workflows/:id/export`
            returns it: sorted keys, no timestamps, and a sha256 over the
            definition. Unsaved draft changes are not in it.
          </p>
          <pre className="as-pre">{fileText}</pre>
        </div>
      ) : null}

      {drift.data ? (
        <div className="as-wfeditor-drift">
          <h4>Tasks already created from this workflow</h4>
          <p className="as-muted as-small">{drift.data.note}</p>
          <ul className="as-validation-list">
            {drift.data.steps.map((step) => (
              <li key={step.key}>
                <span className="as-tag">{step.key}</span>
                <span>
                  {step.taskId
                    ? `task exists · ${step.runs} run(s)`
                    : "no task yet"}
                </span>
                {step.taskId && onOpenTask ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenTask(step.taskId)}
                  >
                    Open the task for {step.key}
                  </button>
                ) : null}
              </li>
            ))}
            {drift.data.orphanTasks.map((task) => (
              <li key={task.taskId}>
                <span className="as-tag as-tag-warn">
                  {task.stepKey ?? "no step key"}
                </span>
                <span>
                  {task.title} — this task has no step in the definition any
                  more, and was kept ({task.runs} run(s) recorded)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
