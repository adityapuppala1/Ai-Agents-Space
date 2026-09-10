import React, { useEffect, useMemo, useRef, useState } from "react";
import { MoveRight, Check, X, Keyboard } from "lucide-react";
import { maskText, providerLabel } from "../hooks/useApi.js";
import { assignmentCompatibility } from "../hooks/viewLogic.js";
import ProviderBadge from "./ProviderBadge.jsx";
import EmptyState from "./EmptyState.jsx";
import { useSelection } from "./SelectionProvider.jsx";

export const DRAG_TYPE = "application/x-agent-space-task";

/* The compatibility rule is in ../hooks/viewLogic.js (covered by node:test). */
export { assignmentCompatibility };

function AgentSummary({ agent }) {
  return (
    <>
      <span
        className="avatar small"
        style={{ "--agent-color": agent.color }}
        aria-hidden="true"
      >
        {agent.initials}
      </span>
      <strong>{agent.name}</strong>
      <span className="as-muted as-small">{agent.role}</span>
      {agent.provider ? (
        <ProviderBadge provider={agent.provider} size="small" />
      ) : null}
      <span className={`as-tag ${agent.taskId ? "as-tag-warn" : ""}`}>
        {agent.taskId ? "busy" : "available"}
      </span>
    </>
  );
}

/**
 * Drag a task card onto an agent card, see the proposed assignment, then
 * dispatch. Every pointer action has a keyboard equivalent:
 *
 *   Tab to a task → press "A" → an agent listbox opens → arrows/Home/End
 *   choose → Enter proposes → Enter again confirms → Escape cancels.
 *
 * The proposal step is not optional: dropping never dispatches straight away,
 * because assignment can start real provider work.
 *
 * @param {{
 *   tasks: any[],                    // [{ id, title, status, provider, assignedAgentId }]
 *   agents: any[],                   // [{ id, name, role, color, initials, provider, taskId, archivedAt }]
 *   onAssign: (taskId: string, agentId: string) => Promise<any>|any,
 *   onDispatch?: (taskId: string, agentId: string) => Promise<any>|any, // optional "assign and run now"
 *   compatibility?: (task:any, agent:any) => { ok:boolean, reason:string, level:string },
 *   label?: string,
 *   presentation?: boolean
 * }} props
 */
export default function DragAssign({
  tasks = [],
  agents = [],
  onAssign,
  onDispatch,
  compatibility = assignmentCompatibility,
  label = "Assign a task to an agent",
  presentation = false,
}) {
  const selection = useSelection();
  const [draggingTaskId, setDraggingTaskId] = useState(null);
  const [hoverAgentId, setHoverAgentId] = useState(null);
  const [proposal, setProposal] = useState(null); // { taskId, agentId }
  const [picker, setPicker] = useState(null); // { taskId, index }
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState("");
  const pickerRef = useRef(null);
  const confirmRef = useRef(null);

  const openTasks = useMemo(
    () => tasks.filter((task) => task.status !== "COMPLETED"),
    [tasks],
  );
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archivedAt),
    [agents],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  useEffect(() => {
    if (picker) setTimeout(() => pickerRef.current?.focus(), 0);
  }, [picker]);
  useEffect(() => {
    if (proposal) setTimeout(() => confirmRef.current?.focus(), 0);
  }, [proposal]);

  const propose = (taskId, agentId) => {
    const task = taskById.get(taskId);
    const agent = agentById.get(agentId);
    const verdict = compatibility(task, agent);
    setProposal({ taskId, agentId });
    setPicker(null);
    setLive(
      `Proposed: ${task?.title ?? taskId} to ${agent?.name ?? agentId}. ${verdict.reason}. Press Enter to dispatch, Escape to cancel.`,
    );
  };

  const confirm = async (andRun = false) => {
    if (!proposal) return;
    const { taskId, agentId } = proposal;
    const verdict = compatibility(taskById.get(taskId), agentById.get(agentId));
    if (!verdict.ok) {
      setMessage(verdict.reason);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (andRun && onDispatch) await onDispatch(taskId, agentId);
      else await onAssign?.(taskId, agentId);
      const agent = agentById.get(agentId);
      setMessage(
        `${taskById.get(taskId)?.title ?? "Task"} assigned to ${agent?.name ?? agentId}.${
          andRun ? " A run was requested; the server enforces the policy." : ""
        }`,
      );
      setLive(`Assigned to ${agent?.name ?? agentId}.`);
      setProposal(null);
    } catch (error) {
      setMessage(error?.message ?? "Assignment failed.");
    } finally {
      setBusy(false);
    }
  };

  const onTaskKeyDown = (event, task) => {
    if (event.key.toLowerCase() === "a" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setPicker({ taskId: task.id, index: 0 });
      setLive(
        `Choosing an agent for ${task.title}. Use the arrow keys, then press Enter.`,
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selection.selectTask?.(task.id);
    }
  };

  const onPickerKeyDown = (event) => {
    if (!picker) return;
    const list = activeAgents;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPicker({
        ...picker,
        index: Math.min(picker.index + 1, list.length - 1),
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPicker({ ...picker, index: Math.max(picker.index - 1, 0) });
    } else if (event.key === "Home") {
      event.preventDefault();
      setPicker({ ...picker, index: 0 });
    } else if (event.key === "End") {
      event.preventDefault();
      setPicker({ ...picker, index: list.length - 1 });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const agent = list[picker.index];
      if (agent) propose(picker.taskId, agent.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
      setLive("Agent selection cancelled.");
    }
  };

  const proposedTask = proposal ? taskById.get(proposal.taskId) : null;
  const proposedAgent = proposal ? agentById.get(proposal.agentId) : null;
  const verdict =
    proposedTask && proposedAgent
      ? compatibility(proposedTask, proposedAgent)
      : null;

  return (
    <section className="as-dragassign" aria-label={label}>
      <p className="as-muted as-small">
        <Keyboard size={12} aria-hidden="true" /> Drag a task onto an agent, or
        focus a task and press <kbd>A</kbd> to choose an agent with the
        keyboard. Nothing is dispatched until you confirm the proposal.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}

      <div className="as-dragassign-grid">
        <div className="as-dragassign-col">
          <h4 id="as-dragassign-tasks">Tasks</h4>
          {openTasks.length === 0 ? (
            <EmptyState
              compact
              title="No open tasks"
              description="Create a task to assign it to an agent."
            />
          ) : (
            <ul
              className="as-dragassign-list"
              aria-labelledby="as-dragassign-tasks"
            >
              {openTasks.map((task) => (
                <li key={task.id}>
                  <div
                    className={`as-drag-task ${draggingTaskId === task.id ? "dragging" : ""} ${
                      selection.selectedTaskId === task.id ? "selected" : ""
                    }`}
                    draggable
                    tabIndex={0}
                    role="button"
                    aria-label={`Task ${task.title}. Press A to assign it to an agent.`}
                    aria-grabbed={draggingTaskId === task.id}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, task.id);
                      event.dataTransfer.setData(
                        "text/plain",
                        task.title ?? "",
                      );
                      event.dataTransfer.effectAllowed = "move";
                      setDraggingTaskId(task.id);
                    }}
                    onDragEnd={() => {
                      setDraggingTaskId(null);
                      setHoverAgentId(null);
                    }}
                    onKeyDown={(event) => onTaskKeyDown(event, task)}
                    onClick={() => selection.selectTask?.(task.id)}
                  >
                    <strong>{maskText(task.title, presentation)}</strong>
                    <span className="as-row as-wrap as-small as-muted">
                      <span className={`priority priority-${task.priority}`}>
                        {task.priority}
                      </span>
                      {task.provider ? (
                        <ProviderBadge provider={task.provider} size="small" />
                      ) : (
                        <span className="as-tag">no runtime required</span>
                      )}
                      {task.assignedAgentId ? (
                        <span className="as-tag">
                          assigned to{" "}
                          {agentById.get(task.assignedAgentId)?.name ??
                            "an agent"}
                        </span>
                      ) : null}
                    </span>
                  </div>

                  {picker?.taskId === task.id ? (
                    <ul
                      ref={pickerRef}
                      className="as-agent-picker"
                      role="listbox"
                      tabIndex={0}
                      aria-label={`Choose an agent for ${task.title}`}
                      aria-activedescendant={
                        activeAgents[picker.index]
                          ? `as-pick-${activeAgents[picker.index].id}`
                          : undefined
                      }
                      onKeyDown={onPickerKeyDown}
                      onBlur={() => setPicker(null)}
                    >
                      {activeAgents.length === 0 ? (
                        <li className="as-muted">No agents available.</li>
                      ) : null}
                      {activeAgents.map((agent, index) => {
                        const check = compatibility(task, agent);
                        return (
                          <li
                            key={agent.id}
                            id={`as-pick-${agent.id}`}
                            role="option"
                            aria-selected={index === picker.index}
                            aria-disabled={!check.ok}
                            className={`as-agent-option ${index === picker.index ? "active" : ""} ${check.ok ? "" : "disabled"}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() =>
                              check.ok && propose(task.id, agent.id)
                            }
                          >
                            <AgentSummary agent={agent} />
                            <span
                              className={`as-tag ${check.level === "ok" ? "" : "as-tag-warn"}`}
                            >
                              {check.reason}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="as-dragassign-col">
          <h4 id="as-dragassign-agents">Agents</h4>
          {activeAgents.length === 0 ? (
            <EmptyState
              compact
              title="No agents yet"
              description="Add an agent profile to give tasks a destination."
            />
          ) : (
            <ul
              className="as-dragassign-list"
              aria-labelledby="as-dragassign-agents"
            >
              {activeAgents.map((agent) => {
                const dragged = draggingTaskId
                  ? taskById.get(draggingTaskId)
                  : null;
                const check = dragged ? compatibility(dragged, agent) : null;
                return (
                  <li key={agent.id}>
                    <div
                      className={`as-drop-agent ${hoverAgentId === agent.id ? "over" : ""} ${
                        check && !check.ok ? "incompatible" : ""
                      }`}
                      role="button"
                      tabIndex={0}
                      aria-label={`Agent ${agent.name}${agent.taskId ? ", busy" : ", available"}. Drop a task here, or select the agent.`}
                      aria-dropeffect={draggingTaskId ? "move" : "none"}
                      onDragOver={(event) => {
                        if (!draggingTaskId) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect =
                          check && !check.ok ? "none" : "move";
                        setHoverAgentId(agent.id);
                      }}
                      onDragLeave={() =>
                        setHoverAgentId((current) =>
                          current === agent.id ? null : current,
                        )
                      }
                      onDrop={(event) => {
                        event.preventDefault();
                        const taskId =
                          event.dataTransfer.getData(DRAG_TYPE) ||
                          draggingTaskId;
                        setHoverAgentId(null);
                        setDraggingTaskId(null);
                        if (taskId) propose(taskId, agent.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selection.selectAgent?.(agent.id);
                        }
                      }}
                      onClick={() => selection.selectAgent?.(agent.id)}
                    >
                      <AgentSummary agent={agent} />
                      {check ? (
                        <span
                          className={`as-tag ${check.ok ? "" : "as-tag-warn"}`}
                        >
                          {check.ok ? "drop to propose" : check.reason}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {proposal && proposedTask && proposedAgent ? (
        <div
          className="as-proposal"
          role="alertdialog"
          aria-label="Proposed assignment"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setProposal(null);
              setLive("Proposal cancelled.");
            }
          }}
        >
          <h4>Proposed assignment</h4>
          <p className="as-proposal-line">
            <strong>{proposedTask.title}</strong>
            <MoveRight size={14} aria-hidden="true" />
            <span>
              {proposedAgent.name} · {proposedAgent.role}
            </span>
          </p>
          <dl className="as-proposal-detail">
            <div>
              <dt>Destination</dt>
              <dd>
                {proposedAgent.name} in this workspace
                {proposedAgent.provider
                  ? ` (${providerLabel(proposedAgent.provider)})`
                  : " (no runtime set on the profile)"}
              </dd>
            </div>
            <div>
              <dt>Runtime that would execute</dt>
              <dd>
                {providerLabel(
                  proposedTask.provider ?? proposedAgent.provider ?? "manual",
                )}
              </dd>
            </div>
            <div>
              <dt>Compatibility</dt>
              <dd>
                <span
                  className={`as-tag ${verdict?.level === "ok" ? "" : "as-tag-warn"}`}
                >
                  {verdict?.reason}
                </span>
              </dd>
            </div>
          </dl>
          <p className="as-muted as-small">
            Assigning records the assignment only. Starting a run is a separate,
            explicit action, and the server enforces the workspace policy either
            way.
          </p>
          <div className="as-row">
            <button
              ref={confirmRef}
              type="button"
              className="button primary"
              disabled={busy || !verdict?.ok}
              onClick={() => confirm(false)}
            >
              <Check size={12} /> Assign
            </button>
            {onDispatch ? (
              <button
                type="button"
                className="button"
                disabled={busy || !verdict?.ok}
                onClick={() => confirm(true)}
              >
                Assign and run now
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setProposal(null);
                setLive("Proposal cancelled.");
              }}
            >
              <X size={12} /> Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
