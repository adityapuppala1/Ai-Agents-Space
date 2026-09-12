import test from "node:test";
import assert from "node:assert/strict";
import {
  cueForAgent,
  buildChoreography,
  liveLinkSummaries,
  domainPropForAgent,
} from "../apps/web/src/office/choreography.js";

test("recorded activities map to concrete visual cues", () => {
  const cue = cueForAgent({
    id: "a",
    activity: "RESEARCHING",
    currentAction: "Search provider documentation",
    activityProvenance: "provider",
  });
  assert.equal(cue.destination, "library");
  assert.equal(cue.animation, "reading");
  assert.equal(cue.prop, "sources");
  assert.equal(cue.provenance, "provider");

  const command = cueForAgent(
    { id: "b", activity: "COMMANDING", currentAction: "Run build" },
    { message: { summary: "Older message" } },
  );
  assert.equal(command.prop, "command");
  assert.equal(command.label, "Run build");
});

test("data props require recorded file or task evidence", () => {
  assert.equal(
    domainPropForAgent({ currentFile: "analysis.ipynb" }),
    "notebook",
  );
  assert.equal(domainPropForAgent({ currentFile: "warehouse.sql" }), "query");
  assert.equal(
    domainPropForAgent({ currentAction: "Run dbt pipeline" }),
    "pipeline",
  );
  assert.equal(
    domainPropForAgent({ taskTitle: "Validate parquet dataset" }),
    "dataset",
  );
  assert.equal(
    domainPropForAgent({ currentAction: "Render dashboard chart" }),
    "chart",
  );
  assert.equal(
    domainPropForAgent({ currentAction: "Refactor login form" }),
    null,
  );

  const cue = cueForAgent({
    id: "data-agent",
    activity: "COMMANDING",
    currentFile: "metrics.sql",
    currentAction: "Run query",
  });
  assert.equal(cue.prop, "query");
  assert.equal(cue.label, "Run query");
});

test("communication is created only from recorded handoffs", () => {
  const plan = buildChoreography({
    agents: [{ id: "a" }, { id: "b" }],
    handoffs: [
      { id: "h1", fromAgentId: "a", toAgentId: "b", taskTitle: "Review patch" },
      { id: "h2", fromAgentId: "a", toAgentId: "missing" },
    ],
  });
  assert.equal(plan.interactions.length, 1);
  assert.equal(plan.interactions[0].label, "Review patch");
  assert.equal(
    buildChoreography({ agents: [{ id: "a" }] }).interactions.length,
    0,
  );
  assert.deepEqual(buildChoreography({ agents: null, handoffs: null }), {
    cues: [],
    interactions: [],
  });
});

test("agent conversation links require a recorded recipient", () => {
  const plan = buildChoreography({
    agents: [{ id: "a" }, { id: "b" }],
    messages: {
      a: {
        eventId: "m1",
        toAgentId: "b",
        summary: "Please review",
        timestamp: "2026-09-10T10:00:00Z",
      },
      b: { eventId: "m2", summary: "No recipient recorded" },
    },
  });
  assert.equal(plan.interactions.length, 1);
  assert.equal(plan.interactions[0].kind, "message");
  assert.equal(plan.interactions[0].evidenceId, "m1");
  assert.equal(plan.interactions[0].fromName, "Agent");
  assert.equal(plan.interactions[0].toName, "Agent");
});

test("live link summaries show only active provider runs and recorded interactions", () => {
  const agents = [
    {
      id: "a",
      name: "Nova",
      provider: "claude-code",
      activeProviderRun: true,
      runId: "run-1",
      currentAction: "Editing the dashboard",
      lastEventAt: "2026-09-10T10:05:00Z",
    },
    {
      id: "b",
      name: "Sage",
      provider: "codex",
      activeProviderRun: false,
      runId: "run-2",
    },
  ];
  const choreography = buildChoreography({
    agents,
    messages: {
      a: {
        eventId: "m1",
        toAgentId: "b",
        summary: "Please review",
        timestamp: "2026-09-10T10:04:00Z",
      },
    },
  });
  const links = liveLinkSummaries({ agents, choreography });
  assert.deepEqual(
    links.map((link) => link.kind),
    ["provider", "message"],
  );
  assert.equal(links[0].from, "Claude Code");
  assert.equal(links[0].to, "Nova");
  assert.equal(links[0].label, "Editing the dashboard");
  assert.equal(links[1].from, "Nova");
  assert.equal(links[1].to, "Sage");
});
