import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Building2, Layers, Sparkles, Users } from "lucide-react";
import { apiFetch, useApi, providerLabel } from "../hooks/useApi.js";
import Dialog from "./Dialog.jsx";
import { connectionReason } from "./TaskLauncher.jsx";
import { themeLabel } from "../office/themeCatalog.js";
import { routingReason } from "../hooks/routingLogic.js";
import {
  canStart,
  defaultTeam,
  relayPreview,
  roleKey,
  roleName,
  roleNames,
  roleSteps,
  shortTitle,
  teamPayload,
} from "../hooks/teamLogic.js";

/** The assistants that can launch here, with the reason for any that cannot. */
function useAssistants(connections, capabilities, workspaceId) {
  return useMemo(() => {
    const byProvider = new Map();
    for (const connection of connections) {
      const reason = connectionReason(connection, capabilities, workspaceId);
      const existing = byProvider.get(connection.provider);
      if (!existing || (existing.reason && !reason))
        byProvider.set(connection.provider, {
          provider: connection.provider,
          reason,
        });
    }
    return [...byProvider.values()].sort(
      (a, b) =>
        (a.reason ? 1 : 0) - (b.reason ? 1 : 0) ||
        a.provider.localeCompare(b.provider),
    );
  }, [connections, capabilities, workspaceId]);
}

/**
 * The routing ranking for this workspace's own label (POST /route): the
 * recommended assistant, and the reason any other is excluded. Null when the
 * server has no routing (it answers 404).
 */
function useRouting(workspaceId) {
  const [routing, setRouting] = useState(null);
  useEffect(() => {
    if (!workspaceId) return undefined;
    let stale = false;
    apiFetch(`/workspaces/${encodeURIComponent(workspaceId)}/route`, {
      method: "POST",
      body: {},
    })
      .then((result) => {
        if (!stale) setRouting(result);
      })
      .catch(() => {
        if (!stale) setRouting(null);
      });
    return () => {
      stale = true;
    };
  }, [workspaceId]);
  return routing;
}

function templateList(data) {
  return Array.isArray(data) ? data : (data?.templates ?? []);
}

/**
 * Workflow template gallery (GET /api/templates). Using a template deploys a
 * team: its inputs, who holds each role (an existing agent, a new profile
 * named for the role, or nobody yet), the assistant each role runs on, and
 * whether the first steps start now. Posts to
 * `POST /api/workspaces/:id/teams`; each later step starts when the one
 * before it is accepted, and receives its result (a recorded handoff).
 * @param {{ workspaceId: string, agents?: any[], connections?: any[], capabilities?: object, onInstantiated?: (workflow: any, result?: any) => void, onEnvironment?: (environment: string) => Promise<void>|void }} props
 */
export default function TemplateGallery({
  workspaceId,
  agents = [],
  connections = [],
  capabilities = {},
  onInstantiated,
  onEnvironment,
}) {
  const templates = useApi("/templates");
  const [selected, setSelected] = useState(null);
  const [feedback, setFeedback] = useState("");
  const assistants = useAssistants(connections, capabilities, workspaceId);
  const list = templateList(templates.data);
  const domains = [...new Set(list.map((t) => t.domain ?? "general"))].sort();

  return (
    <section className="as-gallery" aria-label="Workflow templates">
      <header className="as-section-head">
        <h3>
          <Layers size={14} aria-hidden="true" /> Templates
        </h3>
        <span className="as-muted">{list.length} available</span>
      </header>
      {templates.error ? (
        <div className="form-error" role="alert">
          {templates.error.message}
        </div>
      ) : null}
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {domains.map((domain) => (
        <div key={domain} className="as-gallery-group">
          <h4>{domain}</h4>
          <div className="as-gallery-grid">
            {list
              .filter((t) => (t.domain ?? "general") === domain)
              .map((template) => (
                <article key={template.id} className="as-card as-template">
                  <strong>{template.name}</strong>
                  <p className="as-muted">{template.description}</p>
                  <p className="as-muted as-small">
                    {template.steps?.length ?? 0} steps · roles:{" "}
                    {roleNames(template) || "any"}
                    {template.priority ? ` · ${template.priority}` : ""}
                  </p>
                  {template.recommendedEnvironment ? (
                    <span className="as-environment-badge">
                      <Building2 size={11} aria-hidden="true" /> Data Lab ready
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setSelected(template)}
                    aria-label={`Use template ${template.name}`}
                  >
                    <Sparkles size={12} /> Use
                  </button>
                </article>
              ))}
          </div>
        </div>
      ))}
      {selected ? (
        <Dialog
          title={`Use "${selected.name}"`}
          onClose={() => setSelected(null)}
          wide
        >
          <p className="modal-intro">{selected.description}</p>
          <TeamSetup
            key={selected.id}
            template={selected}
            workspaceId={workspaceId}
            agents={agents}
            assistants={assistants}
            onEnvironment={onEnvironment}
            onCancel={() => setSelected(null)}
            onDeployed={(result) => {
              onInstantiated?.(result.workflow, result);
              setFeedback(deployedMessage(selected, result));
              setSelected(null);
            }}
          />
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * "Deploy a team" from the office: choose a template, then staff it with the
 * same form the template gallery uses.
 * @param {{ workspaceId: string, agents?: any[], connections?: any[], capabilities?: object, onClose: () => void, onDeployed?: (result: any) => void, onEnvironment?: (environment: string) => Promise<void>|void }} props
 */
export function TeamDialog({
  workspaceId,
  agents = [],
  connections = [],
  capabilities = {},
  onClose,
  onDeployed,
  onEnvironment,
}) {
  const templates = useApi("/templates");
  const [selected, setSelected] = useState(null);
  const assistants = useAssistants(connections, capabilities, workspaceId);
  // Only templates with more than one role make a team.
  const list = templateList(templates.data).filter(
    (template) => (template.roles ?? []).length > 1,
  );
  return (
    <Dialog
      title={selected ? `Deploy a team: ${selected.name}` : "Deploy a team"}
      onClose={onClose}
      wide
    >
      {selected ? (
        <>
          <button
            type="button"
            className="button team-back"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={14} aria-hidden="true" /> All templates
          </button>
          <p className="modal-intro">{selected.description}</p>
          <TeamSetup
            key={selected.id}
            template={selected}
            workspaceId={workspaceId}
            agents={agents}
            assistants={assistants}
            onEnvironment={onEnvironment}
            onCancel={onClose}
            onDeployed={(result) => onDeployed?.(result)}
          />
        </>
      ) : (
        <>
          <p className="modal-intro">
            A team works a job step by step: each step has a role, each role an
            agent and an assistant, and each finished step hands its result to
            the next. Choose what the team should do.
          </p>
          {templates.error ? (
            <div className="form-error" role="alert">
              {templates.error.message}
            </div>
          ) : null}
          {!templates.data && !templates.error ? (
            <p className="as-muted">Loading templates…</p>
          ) : null}
          <ul className="team-templates">
            {list.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() => setSelected(template)}
                  aria-label={`Deploy a team for ${template.name}`}
                >
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                  <small>
                    {template.steps?.length ?? 0} steps · {roleNames(template)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}

/**
 * The team form: inputs, who holds each role and on which assistant, how the
 * work passes along, and whether the first step starts now. Posts to
 * `POST /api/workspaces/:id/teams` and hands the result to `onDeployed`.
 */
export function TeamSetup({
  template,
  workspaceId,
  agents = [],
  assistants = [],
  onEnvironment,
  onCancel,
  onDeployed,
}) {
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const routing = useRouting(workspaceId);
  // Fields start empty: the template's sample values are shown as hints, not
  // submitted, so a workflow is never created about an invented client.
  const keys = template?.inputKeys ?? Object.keys(template?.sampleInputs ?? {});
  const [inputs, setInputs] = useState(() =>
    Object.fromEntries(keys.map((key) => [key, ""])),
  );
  const [team, setTeam] = useState(() => defaultTeam(template, activeAgents));
  const [useEnvironment, setUseEnvironment] = useState(
    Boolean(template.recommendedEnvironment),
  );
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = (key, field, value) =>
    setTeam((current) => ({
      ...current,
      [key]: { ...(current[key] ?? {}), [field]: value },
    }));
  const startable = canStart(template, team);
  const staffedCount = Object.values(team).filter(
    (choice) => choice.agent,
  ).length;
  const deploy = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch(
        `/workspaces/${encodeURIComponent(workspaceId)}/teams`,
        {
          method: "POST",
          body: teamPayload(template, team, inputs, startNow),
        },
      );
      if (useEnvironment && template.recommendedEnvironment)
        await onEnvironment?.(template.recommendedEnvironment);
      onDeployed?.(result);
    } catch (err) {
      // A server started before team deploys existed has no such route; the
      // page is newer than the server until it restarts.
      setError(
        err.status === 404 &&
          /route not found/i.test(String(err.body?.error ?? err.message))
          ? "This Agent Space server was started before teams could be deployed. Restart it, then try again. Nothing was created."
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        deploy();
      }}
    >
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="as-muted">This template needs no inputs.</p>
      ) : null}
      {keys.map((key, index) => {
        const sample = template.sampleInputs?.[key];
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        const field = {
          required: true,
          value: inputs[key] ?? "",
          placeholder: sample ? `For example: ${sample}` : "",
          onChange: (e) => setInputs({ ...inputs, [key]: e.target.value }),
          "data-autofocus": index === 0 ? true : undefined,
        };
        return (
          <label key={key}>
            {label}
            {String(sample ?? "").length > 60 ? (
              <textarea rows={3} {...field} />
            ) : (
              <input {...field} />
            )}
          </label>
        );
      })}
      {template.recommendedEnvironment ? (
        <label className="as-environment-choice">
          <input
            type="checkbox"
            checked={useEnvironment}
            onChange={(event) => setUseEnvironment(event.target.checked)}
          />
          <span>
            <strong>
              Open this workflow in{" "}
              {themeLabel(template.recommendedEnvironment).label}
            </strong>
            <small>
              Switch this workspace after its tasks are created. You can turn
              this off or change the office later.
            </small>
          </span>
        </label>
      ) : null}
      {(template.roles ?? []).length ? (
        <fieldset className="team-roles">
          <legend>
            <Users size={14} aria-hidden="true" /> Team
          </legend>
          <p className="as-muted as-small">
            Who does each part, and which assistant runs it. Each step hands its
            result to the next one when you accept it.
          </p>
          {(template.roles ?? []).map((role) => (
            <RoleRow
              key={roleKey(role)}
              role={role}
              steps={roleSteps(template).get(roleKey(role)) ?? []}
              choice={team[roleKey(role)] ?? { agent: "", provider: "" }}
              agents={activeAgents}
              assistants={assistants}
              routing={routing}
              onChoose={(field, value) => choose(roleKey(role), field, value)}
            />
          ))}
        </fieldset>
      ) : null}
      <div className="team-relay-preview">
        <strong>How the work passes along</strong>
        <ol className="as-steps">
          {relayPreview(template, team, activeAgents, inputs).map((step) => (
            <li key={step.key}>
              <strong>{step.title}</strong>{" "}
              <span className="as-muted">
                {step.holder}
                {step.holder === step.role ? "" : ` (${step.role})`} ·{" "}
                {step.provider
                  ? providerLabel(step.provider)
                  : "started by hand"}
                {step.after.length
                  ? ` · after ${step.after.join(", ")}`
                  : " · first"}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <label className="as-environment-choice">
        <input
          type="checkbox"
          checked={startNow && startable.ok}
          disabled={!startable.ok}
          onChange={(event) => setStartNow(event.target.checked)}
        />
        <span>
          <strong>Start the first step now</strong>
          <small>
            {startable.ok
              ? "It starts with its assistant. The office shows the team at work and each handoff as it happens."
              : `Choose an assistant for ${(startable.missing ?? []).join(", ") || "the first step"} to start it now.`}
          </small>
        </span>
      </label>
      <div className="modal-actions">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="button primary"
          disabled={
            busy || Object.values(inputs).some((value) => !String(value).trim())
          }
        >
          {staffedCount ? "Deploy team" : "Create tasks"}
        </button>
      </div>
    </form>
  );
}

/** One role of the team: who holds it, and the assistant it runs on. */
function RoleRow({
  role,
  steps,
  choice,
  agents,
  assistants,
  routing,
  onChoose,
}) {
  const name = roleName(role);
  // A template that names the assistant for every step of the role decides.
  const fixed = steps.length > 0 && steps.every((step) => step.provider);
  const named = agents.find(
    (agent) => String(agent.name).toLowerCase() === name.toLowerCase(),
  );
  return (
    <div className="team-role">
      <div className="team-role-name">
        <strong>{name}</strong>
        <small>
          {steps.length} step{steps.length === 1 ? "" : "s"}:{" "}
          {steps.map((step) => shortTitle(step.title)).join(", ")}
        </small>
      </div>
      <label>
        Agent
        <select
          value={choice.agent}
          onChange={(e) => onChoose("agent", e.target.value)}
        >
          {named ? null : <option value="new">New profile “{name}”</option>}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {agent.role && agent.role !== agent.name
                ? ` · ${agent.role}`
                : ""}
            </option>
          ))}
          <option value="">Nobody yet (assign later)</option>
        </select>
      </label>
      <label>
        Assistant
        {fixed ? (
          <select
            value={steps[0].provider}
            disabled
            title="This template chooses the assistant for these steps"
          >
            <option value={steps[0].provider}>
              {providerLabel(steps[0].provider)}
            </option>
          </select>
        ) : (
          <select
            value={choice.provider}
            onChange={(e) => onChoose("provider", e.target.value)}
          >
            <option value="">None: start by hand</option>
            {assistants.map((option) => {
              const routed = routingReason(routing, option.provider);
              let note = "";
              if (option.reason) note = ` (${option.reason})`;
              else if (routed) note = ` (${routed})`;
              else if (routing?.recommended === option.provider)
                note = " (recommended)";
              return (
                <option
                  key={option.provider}
                  value={option.provider}
                  disabled={Boolean(option.reason || routed)}
                >
                  {providerLabel(option.provider)}
                  {note}
                </option>
              );
            })}
          </select>
        )}
      </label>
    </div>
  );
}

/** What was created, who is on the team, and what started (or why not). */
export function deployedMessage(template, result) {
  const members = (result?.team ?? []).filter((member) => member.agentId);
  const started = (result?.started ?? []).filter((item) => !item.error);
  const failed = (result?.started ?? []).filter((item) => item.error);
  const count = result?.workflow?.tasks?.length ?? template.steps?.length ?? 0;
  const parts = [`Created ${count} task(s) from "${template.name}"`];
  parts.push(
    members.length
      ? `team: ${members.map((member) => member.agentName).join(", ")}`
      : "nobody staffed yet",
  );
  if (started.length)
    parts.push(
      `${started.length} first step${started.length === 1 ? "" : "s"} started`,
    );
  if (failed.length)
    parts.push(`${failed.length} could not start: ${failed[0].error}`);
  return `${parts.join(" · ")}.`;
}
