import { activityOf } from "./data.js";

const CUES = Object.freeze({
  IDLE: { destination: "desk", animation: "idle", prop: null, effect: "quiet" },
  // A manual task reports nothing, so the figure waits at its own desk with no
  // effect rather than acting out the profile's working style.
  MANUAL: {
    destination: "desk",
    animation: "waiting",
    prop: null,
    effect: "quiet",
  },
  ANALYZING: {
    destination: "library",
    animation: "thinking",
    prop: "plan",
    effect: "focus",
  },
  CODING: {
    destination: "desk",
    animation: "typing",
    prop: "code",
    effect: "keystrokes",
  },
  RESEARCHING: {
    destination: "library",
    animation: "reading",
    prop: "sources",
    effect: "scan",
  },
  TESTING: {
    destination: "qa",
    animation: "operating",
    prop: "test run",
    effect: "sequence",
  },
  DEBUGGING: {
    destination: "desk",
    animation: "tracing",
    prop: "trace",
    effect: "inspect",
  },
  REVIEWING: {
    destination: "review",
    animation: "reviewing",
    prop: "artifact",
    effect: "compare",
  },
  COMMANDING: {
    destination: "desk",
    animation: "terminal",
    prop: "command",
    effect: "terminal",
  },
  MESSAGING: {
    destination: "meeting",
    animation: "talking",
    prop: "message",
    effect: "speech",
  },
  DELEGATING: {
    destination: "meeting",
    animation: "handoff",
    prop: "task",
    effect: "transfer",
  },
  WAITING_APPROVAL: {
    destination: "meeting",
    animation: "requesting",
    prop: "approval",
    effect: "attention",
  },
  BLOCKED: {
    destination: "desk",
    animation: "blocked",
    prop: "issue",
    effect: "warning",
  },
  ERROR: {
    destination: "desk",
    animation: "error",
    prop: "failure",
    effect: "alarm",
  },
  STALE: {
    destination: "desk",
    animation: "waiting",
    prop: null,
    effect: "stale",
  },
});

const DOMAIN_PROP_RULES = [
  [/\.ipynb(?:\b|$)/i, "notebook"],
  [/\.sql(?:\b|$)|\b(query|select|warehouse)\b/i, "query"],
  [
    /\b(etl|elt|pipeline|dbt|airflow|extract|transform|load job)\b/i,
    "pipeline",
  ],
  [/\b(dataset|dataframe|parquet|csv|table schema)\b/i, "dataset"],
  [/\b(chart|dashboard|visuali[sz]|plot|report graph)\b/i, "chart"],
];

/** A domain prop only when the recorded file/action/task names the domain. */
export function domainPropForAgent(agent) {
  const evidence = [agent?.currentFile, agent?.currentAction, agent?.taskTitle]
    .filter(Boolean)
    .join(" ");
  if (!evidence) return null;
  for (const [pattern, prop] of DOMAIN_PROP_RULES)
    if (pattern.test(evidence)) return prop;
  return null;
}

export { isOnFloor } from "./presence.js";

export function cueForAgent(agent, { message, artifact } = {}) {
  const activity = activityOf(agent);
  const base = CUES[activity] ?? CUES.IDLE;
  const messageRelevant = ["MESSAGING", "DELEGATING"].includes(activity);
  const artifactRelevant = activity === "REVIEWING";
  const domainProp = [
    "ANALYZING",
    "CODING",
    "RESEARCHING",
    "TESTING",
    "DEBUGGING",
    "REVIEWING",
    "COMMANDING",
  ].includes(activity)
    ? domainPropForAgent(agent)
    : null;
  return {
    agentId: agent?.id ?? null,
    activity,
    ...base,
    prop:
      domainProp ??
      (artifactRelevant && artifact
        ? "artifact"
        : messageRelevant && message
          ? "message"
          : base.prop),
    evidenceId: agent?.lastEventId ?? agent?.eventId ?? null,
    provenance: agent?.activityProvenance ?? "recorded",
    label:
      messageRelevant && message?.summary
        ? message.summary
        : (agent?.currentAction ?? agent?.taskTitle ?? activity.toLowerCase()),
  };
}

export function buildChoreography({
  agents = [],
  handoffs = [],
  messages = null,
  artifactsByAgent = null,
} = {}) {
  const roster = Array.isArray(agents) ? agents : [];
  const recordedHandoffs = Array.isArray(handoffs) ? handoffs : [];
  const cues = roster.map((agent) =>
    cueForAgent(agent, {
      message: messages?.[agent.id],
      artifact: artifactsByAgent?.[agent.id]?.[0],
    }),
  );
  const known = new Set(roster.map((agent) => agent.id));
  const names = new Map(
    roster.map((agent) => [agent.id, agent.name ?? "Agent"]),
  );
  // The six most recent: callers pass events newest first, and slicing the
  // unsorted tail kept the six oldest instead.
  const handoffInteractions = recordedHandoffs
    .filter(
      (handoff) =>
        handoff &&
        known.has(handoff.fromAgentId) &&
        known.has(handoff.toAgentId),
    )
    .sort((left, right) => timeOf(left.timestamp) - timeOf(right.timestamp))
    .slice(-6)
    .map((handoff, index) => ({
      id: handoff.id ?? `handoff-${index}`,
      kind: "handoff",
      fromAgentId: handoff.fromAgentId,
      toAgentId: handoff.toAgentId,
      fromName: names.get(handoff.fromAgentId) ?? "Agent",
      toName: names.get(handoff.toAgentId) ?? "Agent",
      label: handoff.taskTitle || "Recorded task handoff",
      artifact: handoff.artifact ?? null,
      detail: handoff.detail ?? null,
      simulated: handoff.simulated === true,
      timestamp: handoff.timestamp ?? null,
      evidenceId: handoff.id ?? null,
    }));
  const messageInteractions = Object.entries(messages ?? {})
    .filter(
      ([fromAgentId, message]) =>
        known.has(fromAgentId) &&
        known.has(message?.toAgentId) &&
        fromAgentId !== message.toAgentId,
    )
    .map(([fromAgentId, message], index) => ({
      id: message.eventId ?? `message-${index}`,
      kind: "message",
      fromAgentId,
      toAgentId: message.toAgentId,
      fromName: names.get(fromAgentId) ?? "Agent",
      toName: names.get(message.toAgentId) ?? "Agent",
      label: message.summary || "Recorded agent message",
      timestamp: message.timestamp ?? null,
      evidenceId: message.eventId ?? null,
    }));
  const interactions = [...handoffInteractions, ...messageInteractions]
    .sort((left, right) => timeOf(left.timestamp) - timeOf(right.timestamp))
    .slice(-8);
  return { cues, interactions };
}

/** Epoch ms for a recorded time: events carry numbers, older callers ISO text. */
function timeOf(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function liveLinkSummaries({
  agents = [],
  choreography = null,
  max = 5,
} = {}) {
  const providerLinks = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.activeProviderRun && agent.provider)
    .map((agent) => ({
      id: `provider:${agent.runId ?? agent.id}`,
      kind: "provider",
      from: providerLabel(agent.provider),
      to: agent.name ?? "Agent",
      label: agent.currentAction ?? agent.taskTitle ?? "Active provider run",
      evidenceId: agent.runId ?? null,
      tone: "provider",
      timestamp:
        agent.lastEventAt ?? agent.updatedAt ?? agent.startedAt ?? null,
    }));
  const agentLinks = (choreography?.interactions ?? []).map((interaction) => ({
    id: interaction.id,
    kind: interaction.kind,
    from: interaction.fromName ?? "Agent",
    to: interaction.toName ?? "Agent",
    label: interaction.label,
    evidenceId: interaction.evidenceId ?? null,
    tone: interaction.kind === "message" ? "message" : "handoff",
    timestamp: interaction.timestamp ?? null,
  }));
  return [...providerLinks, ...agentLinks]
    .sort((left, right) =>
      String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")),
    )
    .slice(0, max);
}

function providerLabel(provider) {
  const labels = {
    "claude-code": "Claude Code",
    codex: "Codex",
    copilot: "GitHub Copilot",
    cursor: "Cursor",
    gemini: "Gemini",
    antigravity: "Antigravity",
    opencode: "OpenCode",
    aider: "Aider",
    windsurf: "Windsurf",
    simulated: "Demo",
  };
  return labels[provider] ?? provider ?? "Provider";
}
