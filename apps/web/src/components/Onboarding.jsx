import React, { useMemo, useState } from "react";
import {
  Rocket,
  Plug,
  FolderPlus,
  Wand2,
  Receipt,
  Check,
  ChevronRight,
  ChevronLeft,
  Stethoscope,
} from "lucide-react";
import { apiFetch, useApi, providerLabel } from "../hooks/useApi.js";
import { useLocalStorage } from "../hooks/useLocalStorage.js";
import EmptyState from "./EmptyState.jsx";
import { SAMPLE_SCOPE, ONBOARDING_STEP_IDS } from "../hooks/viewLogic.js";

export const ONBOARDING_KEY = "agent-space-onboarding";

/** Steps, in order. Every one is skippable and the flow can be reopened. */
const STEP_META = [
  { id: "demo", label: "Try the demo", icon: <Rocket size={13} /> },
  {
    id: "connect",
    label: "Connect your first provider",
    icon: <Plug size={13} />,
  },
  {
    id: "sample",
    label: "Disposable sample workspace",
    icon: <FolderPlus size={13} />,
  },
  { id: "workflow", label: "Starter workflow", icon: <Wand2 size={13} /> },
  { id: "billing", label: "What costs money", icon: <Receipt size={13} /> },
];

/** Steps in the order `ONBOARDING_STEP_IDS` declares, so tests and UI agree. */
export const ONBOARDING_STEPS = ONBOARDING_STEP_IDS.map((id) =>
  STEP_META.find((step) => step.id === id),
).filter(Boolean);

/* The stated scope lives in ../hooks/viewLogic.js (covered by node:test). */
export { SAMPLE_SCOPE };

function StepShell({ title, children, note }) {
  return (
    <div className="as-onboard-step">
      <h3>{title}</h3>
      {children}
      {note ? <p className="as-muted as-small">{note}</p> : null}
    </div>
  );
}

/**
 * Short, skippable onboarding: the local demo first (no credentials needed),
 * then "Connect your first provider" driven by the connection doctor, then a
 * disposable sample workspace with its scope stated up front, then a
 * one-click starter workflow from the template gallery, and finally a plain
 * explanation of who bills what.
 *
 * Progress is a per-browser preference (localStorage), so nothing about the
 * onboarding is recorded in the database.
 *
 * @param {{
 *   open?: boolean,
 *   onClose?: () => void,
 *   workspaceId?: string|null,
 *   demoWorkspaceId?: string|null,
 *   onOpenWorkspace?: (workspaceId: string) => void,
 *   onOpenConnections?: () => void,
 *   onOpenTemplates?: () => void,
 *   onStartDemo?: () => void,
 *   storageKey?: string
 * }} props
 */
export default function Onboarding({
  open = true,
  onClose,
  workspaceId = null,
  demoWorkspaceId = "demo",
  onOpenWorkspace,
  onOpenConnections,
  onOpenTemplates,
  onStartDemo,
  storageKey = ONBOARDING_KEY,
}) {
  const [state, setState] = useLocalStorage(storageKey, {
    step: 0,
    done: [],
    dismissed: false,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(null); // { id, values }
  const [sample, setSample] = useState({
    name: "Sample (disposable)",
    rootPath: "",
  });
  const doctor = useApi(open ? "/connections/doctor" : null);
  const templates = useApi(open ? "/templates" : null);

  const step = Math.min(
    Math.max(0, Number(state?.step) || 0),
    ONBOARDING_STEPS.length - 1,
  );
  const done = new Set(Array.isArray(state?.done) ? state.done : []);
  const current = ONBOARDING_STEPS[step];

  const findings = useMemo(() => {
    const data = doctor.data;
    if (!data) return [];
    return Array.isArray(data) ? data : (data.findings ?? data.results ?? []);
  }, [doctor.data]);
  const readyProviders = findings.filter((entry) => entry.level === "ok");

  const go = (next) =>
    setState({
      ...state,
      step: Math.min(Math.max(0, next), ONBOARDING_STEPS.length - 1),
    });
  const complete = (id, next = step + 1) =>
    setState({ ...state, done: [...new Set([...done, id])], step: next });

  if (!open) return null;

  const createSample = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const created = await apiFetch("/workspaces", {
        method: "POST",
        body: {
          name: sample.name.trim() || "Sample (disposable)",
          rootPath: sample.rootPath.trim() || null,
        },
      });
      setMessage(
        `Created "${created.name}". Everything a run may touch is limited to its folder.`,
      );
      onOpenWorkspace?.(created.id);
      complete("sample");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // A template's steps name inputs ({{client}}); they are asked for here, so
  // no task is ever created with a placeholder in its title.
  const startWorkflow = async (templateId, inputs = {}) => {
    if (!workspaceId) {
      setError("Choose a workspace first.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/workflows`,
        { method: "POST", body: { templateId, inputs } },
      );
      setPicked(null);
      const count = result?.tasks?.length ?? result?.taskIds?.length ?? 0;
      setMessage(
        `Created ${count || "the"} task${count === 1 ? "" : "s"} from the template. Nothing has been dispatched: start a run when you are ready.`,
      );
      complete("workflow");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="as-onboard" aria-label="Setup">
      <header className="as-section-head">
        <h2>Set up Agent Space</h2>
        <div className="as-row">
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setState({ ...state, dismissed: true });
              onClose?.();
            }}
          >
            Skip for now
          </button>
        </div>
      </header>
      <p className="as-muted as-small">
        Every step is optional and you can come back here at any time from
        Settings → Setup. Agent Space starts a provider only when you ask it to.
      </p>

      <ol className="as-onboard-steps" aria-label="Setup steps">
        {ONBOARDING_STEPS.map((entry, index) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`as-onboard-tab ${index === step ? "active" : ""} ${done.has(entry.id) ? "done" : ""}`}
              aria-current={index === step ? "step" : undefined}
              onClick={() => go(index)}
            >
              {done.has(entry.id) ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                entry.icon
              )}
              <span>{entry.label}</span>
              {done.has(entry.id) ? (
                <span className="sr-only">completed</span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>

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

      {current.id === "demo" ? (
        <StepShell
          title="Start with the local demo — no credentials needed"
          note="The demo workspace is simulated. Its runs are labelled Demo and never touch a provider, a repository, or your quota."
        >
          <p>
            The demo workspace is already in your database. It shows six agents
            moving through recorded, simulated events so you can learn the
            layout before connecting anything.
          </p>
          <div className="as-row as-wrap">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                onOpenWorkspace?.(demoWorkspaceId);
                onStartDemo?.();
                complete("demo");
              }}
            >
              Open the demo workspace
            </button>
            <button type="button" className="button" onClick={() => go(1)}>
              Skip the demo
            </button>
          </div>
        </StepShell>
      ) : null}

      {current.id === "connect" ? (
        <StepShell
          title="Connect your first provider"
          note="Agent Space never asks for an API key. Each CLI keeps its own login; we only check whether its credential file exists."
        >
          <p className="as-row as-wrap">
            <Stethoscope size={13} aria-hidden="true" />
            <span>
              The connection doctor below reads the installed runtimes and says,
              in plain language, what is missing.
            </span>
          </p>
          {doctor.error ? (
            <EmptyState
              compact
              title="The doctor could not run"
              error={doctor.error}
              missingRoutes={["GET /api/connections/doctor"]}
            />
          ) : null}
          {!doctor.error && findings.length === 0 && !doctor.loading ? (
            <EmptyState
              compact
              title="No runtimes detected yet"
              description="Install a supported CLI, then re-run detection from Connections."
              actions={[
                {
                  label: "Open Connections",
                  onClick: onOpenConnections,
                  primary: true,
                },
              ]}
            />
          ) : null}
          <ul className="as-onboard-doctor" role="list">
            {findings.map((entry, index) => (
              <li
                key={`${entry.provider ?? "provider"}-${index}`}
                className={`as-doctor-row as-doctor-${entry.level ?? "unknown"}`}
              >
                <span className="as-row as-wrap">
                  <strong>{providerLabel(entry.provider)}</strong>
                  <span
                    className={`as-tag ${entry.level === "ok" ? "" : "as-tag-warn"}`}
                  >
                    {entry.level === "ok"
                      ? "ready"
                      : entry.level === "warn"
                        ? "needs attention"
                        : "blocked"}
                  </span>
                  <span>{entry.title}</span>
                </span>
                {entry.detail ? (
                  <span className="as-muted as-small">{entry.detail}</span>
                ) : null}
                {entry.fix ? (
                  <span className="as-small">
                    <strong>Fix:</strong> {entry.fix}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="as-row as-wrap">
            <button
              type="button"
              className="button primary"
              onClick={onOpenConnections}
            >
              Open Connections
            </button>
            <button
              type="button"
              className="button"
              onClick={() => complete("connect")}
              disabled={busy}
            >
              {readyProviders.length
                ? "Continue"
                : "Continue without a provider"}
            </button>
          </div>
        </StepShell>
      ) : null}

      {current.id === "sample" ? (
        <StepShell
          title="A disposable sample workspace"
          note="Agent Space has no server route that scaffolds a repository on disk, so it does not pretend to create one: point this workspace at a scratch folder you already have (a fresh `git init` folder works well)."
        >
          <h4>Scope and resource assumptions</h4>
          <ul className="as-onboard-scope">
            {SAMPLE_SCOPE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <form onSubmit={createSample} aria-label="Create a sample workspace">
            <div className="form-columns">
              <label>
                Workspace name
                <input
                  value={sample.name}
                  onChange={(event) =>
                    setSample({ ...sample, name: event.target.value })
                  }
                />
              </label>
              <label>
                Scratch folder <span className="optional">(optional)</span>
                <input
                  value={sample.rootPath}
                  onChange={(event) =>
                    setSample({ ...sample, rootPath: event.target.value })
                  }
                  placeholder="C:\\src\\agent-space-sample"
                />
              </label>
            </div>
            <div className="as-row as-wrap">
              <button type="submit" className="button primary" disabled={busy}>
                Create the sample workspace
              </button>
              <button
                type="button"
                className="button"
                onClick={() => complete("sample")}
              >
                Skip
              </button>
            </div>
          </form>
        </StepShell>
      ) : null}

      {current.id === "workflow" ? (
        <StepShell
          title="One-click starter workflow"
          note="Instantiating a template creates tasks with their dependencies. It dispatches nothing: each run still needs your explicit start, and the workspace policy is enforced by the server."
        >
          {templates.error ? (
            <EmptyState
              compact
              title="Templates could not be loaded"
              error={templates.error}
              missingRoutes={["GET /api/templates"]}
            />
          ) : null}
          {!workspaceId ? (
            <p className="as-muted">
              Choose a workspace first — the tasks are created inside it.
            </p>
          ) : null}
          <ul className="as-onboard-templates" role="list">
            {(Array.isArray(templates.data) ? templates.data : [])
              .slice(0, 6)
              .map((template) => (
                <li key={template.id}>
                  <div>
                    <strong>{template.name}</strong>
                    <span className="as-muted as-small">
                      {" "}
                      {template.domain ? `· ${template.domain}` : ""} ·{" "}
                      {template.steps?.length ?? 0} steps
                    </span>
                    {template.description ? (
                      <p className="as-muted as-small">
                        {template.description}
                      </p>
                    ) : null}
                  </div>
                  {picked?.id === template.id ? null : (
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !workspaceId}
                      onClick={() => {
                        const keys = template.inputKeys ?? [];
                        if (keys.length)
                          setPicked({
                            id: template.id,
                            values: Object.fromEntries(
                              keys.map((key) => [key, ""]),
                            ),
                          });
                        else startWorkflow(template.id);
                      }}
                    >
                      Create tasks
                    </button>
                  )}
                  {picked?.id === template.id ? (
                    <form
                      className="as-onboard-inputs"
                      aria-label={`Inputs for ${template.name}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        startWorkflow(template.id, picked.values);
                      }}
                    >
                      {Object.keys(picked.values).map((key, index) => (
                        <label key={key}>
                          {key.charAt(0).toUpperCase() + key.slice(1)}
                          <input
                            required
                            autoFocus={index === 0}
                            value={picked.values[key]}
                            placeholder={
                              template.sampleInputs?.[key]
                                ? `For example: ${String(template.sampleInputs[key]).slice(0, 80)}`
                                : ""
                            }
                            onChange={(event) =>
                              setPicked({
                                ...picked,
                                values: {
                                  ...picked.values,
                                  [key]: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                      <div className="as-row as-wrap">
                        <button
                          type="submit"
                          className="button primary"
                          disabled={
                            busy ||
                            Object.values(picked.values).some(
                              (value) => !value.trim(),
                            )
                          }
                        >
                          Create {template.steps?.length ?? ""} tasks
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setPicked(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : null}
                </li>
              ))}
          </ul>
          <div className="as-row as-wrap">
            <button type="button" className="button" onClick={onOpenTemplates}>
              Open the full template gallery
            </button>
            <button
              type="button"
              className="button"
              onClick={() => complete("workflow")}
            >
              Skip
            </button>
          </div>
        </StepShell>
      ) : null}

      {current.id === "billing" ? (
        <StepShell title="What costs money, and what does not">
          <ul className="as-onboard-billing">
            <li>
              <strong>Agent Space is local software.</strong> It runs on this
              machine against a local SQLite database. There is no account, no
              subscription, and no cloud service to pay for.
            </li>
            <li>
              <strong>Providers bill you directly (BYOK).</strong> Claude Code,
              Codex, Copilot, Cursor and Gemini each keep their own login and
              their own plan. A managed run spends whatever that provider
              charges for it, on your own account.
            </li>
            <li>
              <strong>Agent Space never holds a credential.</strong> It checks
              only whether a provider's credential file exists; it never reads,
              copies, or stores a token.
            </li>
            <li>
              <strong>Nothing paid runs during setup.</strong> The demo is
              simulated; a template creates tasks only. A provider starts when
              you press Run and not before.
            </li>
            <li>
              <strong>Cost figures are the provider's.</strong> Analytics shows
              cost only when the provider reported it, or as an explicit
              estimate from a pricing table you supplied. Missing cost stays
              "not reported".
            </li>
          </ul>
          <div className="as-row as-wrap">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setState({
                  ...state,
                  done: [...new Set([...done, "billing"])],
                  dismissed: true,
                });
                onClose?.();
              }}
            >
              Finish setup
            </button>
          </div>
        </StepShell>
      ) : null}

      <nav className="as-row as-onboard-nav" aria-label="Setup navigation">
        <button
          type="button"
          className="button"
          onClick={() => go(step - 1)}
          disabled={step === 0}
        >
          <ChevronLeft size={12} /> Back
        </button>
        <button
          type="button"
          className="button"
          onClick={() => go(step + 1)}
          disabled={step >= ONBOARDING_STEPS.length - 1}
        >
          Next <ChevronRight size={12} />
        </button>
        <span className="as-muted as-small">
          Step {step + 1} of {ONBOARDING_STEPS.length}
        </span>
      </nav>
    </section>
  );
}

/**
 * Persistent way back into setup. Render it anywhere (a settings row, the
 * rail); it reports how far the flow got.
 * @param {{ onOpen: () => void, storageKey?: string }} props
 */
export function SetupEntry({ onOpen, storageKey = ONBOARDING_KEY }) {
  const [state] = useLocalStorage(storageKey, { done: [], dismissed: false });
  const done = Array.isArray(state?.done) ? state.done.length : 0;
  return (
    <button
      type="button"
      className="button as-setup-entry"
      onClick={onOpen}
      aria-label={`Open setup. ${done} of ${ONBOARDING_STEPS.length} steps completed.`}
    >
      <Rocket size={12} /> Setup
      <span className="as-count">
        {done}/{ONBOARDING_STEPS.length}
      </span>
    </button>
  );
}
