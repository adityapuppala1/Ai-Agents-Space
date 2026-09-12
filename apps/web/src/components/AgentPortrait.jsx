import React from "react";

/**
 * The illustrated bot used for an agent everywhere outside the 3D scene: the
 * office roster, the Agents directory, the inspector and the archived list.
 * Its colour is the profile colour; the antenna lights only while the agent
 * has recorded work. Decorative: the agent's name is always beside it.
 */
export default function AgentPortrait({ agent, size = "md" }) {
  const active = Boolean(
    agent?.activeProviderRun || (agent?.activity && agent.activity !== "IDLE"),
  );
  return (
    <span
      className={`agent-portrait agent-portrait-${size} ${active ? "is-active" : ""}`}
      style={{ "--agent-color": agent?.color }}
      aria-hidden="true"
    >
      <i className="agent-portrait-aerial" />
      <i className="agent-portrait-head">
        <b />
        <b />
        <em />
      </i>
      <i className="agent-portrait-body" />
      <i className="agent-portrait-shadow" />
    </span>
  );
}
