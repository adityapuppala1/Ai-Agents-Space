// The relay of a multi-agent workflow: its steps in dependency order, who
// holds each one, and where the baton is now. Built only from the tasks the
// workspace snapshot carries (workflowId, dependsOn, status, assignedAgentId),
// so the office can show a team at work without guessing. Pure module.

const STATE_ORDER = { active: 0, blocked: 1, ready: 2, waiting: 3, done: 4 };

/**
 * A step's state from its task: "done" (completed), "active" (in progress),
 * "blocked", "ready" (queued, everything it waits for is done) or "waiting"
 * (queued behind a step that is not done yet).
 */
export function stepState(task, byId) {
  if (task.status === "COMPLETED") return "done";
  if (task.status === "BLOCKED") return "blocked";
  if (task.status === "IN_PROGRESS") return "active";
  const pending = (task.dependsOn ?? []).filter(
    (id) => byId.get(id) && byId.get(id).status !== "COMPLETED",
  );
  return pending.length ? "waiting" : "ready";
}

/** Longest-path layer of each task inside one workflow (roots are 0). */
function layers(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map();
  const visiting = new Set();
  const layerOf = (task) => {
    if (memo.has(task.id)) return memo.get(task.id);
    if (visiting.has(task.id)) return 0; // a cycle; the graph check reports it
    visiting.add(task.id);
    let layer = 0;
    for (const id of task.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (dependency) layer = Math.max(layer, layerOf(dependency) + 1);
    }
    visiting.delete(task.id);
    memo.set(task.id, layer);
    return layer;
  };
  for (const task of tasks) layerOf(task);
  return memo;
}

/**
 * One relay per workflow that has more than one step and is not finished:
 * { workflowId, templateId, steps: [{ taskId, title, agentId, agentName,
 * state, layer, waitingOn: [{ taskId, agentName }] }], holders, done, total }.
 * A finished workflow drops out; the Timeline keeps its history.
 */
export function workflowRelays(tasks = [], agents = []) {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const groups = new Map();
  for (const task of tasks ?? []) {
    if (!task?.workflowId) continue;
    const list = groups.get(task.workflowId) ?? [];
    list.push(task);
    groups.set(task.workflowId, list);
  }
  const relays = [];
  for (const [workflowId, list] of groups) {
    if (list.length < 2) continue;
    const byId = new Map(list.map((task) => [task.id, task]));
    const layerOf = layers(list);
    const steps = list
      .map((task) => {
        const state = stepState(task, byId);
        return {
          taskId: task.id,
          title: task.title,
          agentId: task.assignedAgentId ?? null,
          agentName: task.assignedAgentId
            ? (names.get(task.assignedAgentId) ?? "Unknown agent")
            : null,
          state,
          layer: layerOf.get(task.id) ?? 0,
          // The assistant chosen for the step, and whether it is a demo task.
          provider: task.provider ?? null,
          simulated: task.source === "demo",
          waitingOn:
            state === "waiting"
              ? (task.dependsOn ?? [])
                  .map((id) => byId.get(id))
                  .filter((dep) => dep && dep.status !== "COMPLETED")
                  .map((dep) => ({
                    taskId: dep.id,
                    title: dep.title,
                    agentId: dep.assignedAgentId ?? null,
                    agentName: dep.assignedAgentId
                      ? (names.get(dep.assignedAgentId) ?? "Unknown agent")
                      : null,
                  }))
              : [],
        };
      })
      .sort(
        (a, b) =>
          a.layer - b.layer ||
          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
          String(a.title).localeCompare(String(b.title)),
      );
    const done = steps.filter((step) => step.state === "done").length;
    if (done === steps.length) continue;
    relays.push({
      workflowId,
      templateId: list.find((task) => task.templateId)?.templateId ?? null,
      steps,
      holders: steps
        .filter((step) => step.state === "active" && step.agentId)
        .map((step) => step.agentId),
      done,
      total: steps.length,
    });
  }
  return relays.sort((a, b) => b.holders.length - a.holders.length);
}

/**
 * Team members who stand on the floor because their relay is live: someone
 * in the same workflow is working (or is blocked) right now, and this member
 * holds a later step that is waiting for it, or ready but not started.
 * Map agentId -> { state: "waiting" | "ready", stepTitle, taskId,
 * workflowId, waitingOn }. A member holding an active step of that relay is
 * not listed (it is at work), and a stalled relay (nobody working) puts
 * nobody on the floor: waiting on nothing is not activity.
 */
export function relayPresence(relays = []) {
  const out = new Map();
  for (const relay of relays ?? []) {
    const live = relay.steps.some(
      (step) => step.state === "active" || step.state === "blocked",
    );
    if (!live) continue;
    for (const step of relay.steps) {
      if (!step.agentId || !["waiting", "ready"].includes(step.state)) continue;
      if (relay.holders.includes(step.agentId) || out.has(step.agentId))
        continue;
      out.set(step.agentId, {
        state: step.state,
        stepTitle: step.title,
        taskId: step.taskId,
        workflowId: relay.workflowId,
        provider: step.provider,
        simulated: step.simulated,
        waitingOn: step.waitingOn,
      });
    }
  }
  return out;
}

/** "Waiting for Atlas", "Waiting for Atlas and Nova", or "Ready to start". */
export function relayLabel(relay) {
  if (!relay) return null;
  if (relay.state !== "waiting") return "Ready to start";
  const names = [
    ...new Set(
      (relay.waitingOn ?? []).map((dep) => dep.agentName ?? "an open step"),
    ),
  ];
  if (!names.length) return "Waiting";
  if (names.length === 1) return `Waiting for ${names[0]}`;
  return `Waiting for ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "bug-clinic" -> "Bug clinic"; a relay without a template is a "Team relay". */
export function relayName(relay) {
  const id = relay?.templateId;
  if (!id) return "Team relay";
  const words = String(id).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Team relay";
}

/**
 * Who is waiting on whom, for dashed "waiting for" lines in the office:
 * [{ fromAgentId (the one waiting), toAgentId (the one it waits for),
 * taskId, label }]. Only between two assigned, different agents.
 */
export function waitingLinks(relays = []) {
  const links = [];
  for (const relay of relays)
    for (const step of relay.steps)
      for (const dep of step.waitingOn)
        if (step.agentId && dep.agentId && step.agentId !== dep.agentId)
          links.push({
            id: `wait:${step.taskId}:${dep.taskId}`,
            fromAgentId: step.agentId,
            toAgentId: dep.agentId,
            taskId: step.taskId,
            label: `${step.agentName} waits for ${dep.agentName}: ${dep.title}`,
          });
  return links;
}
