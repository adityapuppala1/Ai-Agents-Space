import test from "node:test";
import assert from "node:assert/strict";
import {
  canStart,
  defaultTeam,
  relayPreview,
  roleNames,
  teamPayload,
} from "../apps/web/src/hooks/teamLogic.js";

/**
 * The team dialog: who holds each role, which assistant runs it, what the
 * relay looks like, and exactly what is sent to POST /teams.
 */

const template = {
  id: "bug-clinic",
  name: "Bug clinic",
  roles: [
    { key: "investigator", name: "Investigator" },
    { key: "developer", name: "Developer" },
    { key: "qa", name: "QA engineer" },
  ],
  steps: [
    { key: "reproduce", title: "Reproduce", role: "investigator" },
    {
      key: "diagnose",
      title: "Diagnose",
      role: "investigator",
      dependsOn: ["reproduce"],
    },
    { key: "fix", title: "Fix", role: "developer", dependsOn: ["diagnose"] },
    {
      key: "regression",
      title: "Regression",
      role: "qa",
      provider: "codex",
      dependsOn: ["fix"],
    },
  ],
};

test("roles read as names, never [object Object]", () => {
  assert.equal(roleNames(template), "Investigator, Developer, QA engineer");
  assert.equal(roleNames({ roles: ["a", "b"] }), "a, b");
  assert.equal(roleNames({}), "");
});

test("a profile named for a role is proposed; otherwise a new one; the template's assistant is kept", () => {
  const agents = [
    { id: "d1", name: "developer", provider: "claude-code" },
    { id: "old", name: "Investigator", archived: true },
  ];
  const team = defaultTeam(template, agents);
  assert.deepEqual(team.developer, { agent: "d1", provider: "claude-code" });
  // An archived profile is not reused.
  assert.deepEqual(team.investigator, { agent: "new", provider: "" });
  assert.deepEqual(team.qa, { agent: "new", provider: "codex" });
});

test("the first step starts only with an assistant, and the payload says exactly who and what", () => {
  const team = {
    investigator: { agent: "new", provider: "" },
    developer: { agent: "d1", provider: "claude-code" },
    qa: { agent: "", provider: "" },
  };
  assert.deepEqual(canStart(template, team), {
    ok: false,
    missing: ["Reproduce"],
  });
  // Asked to start without an assistant: it is not requested.
  assert.equal(teamPayload(template, team, {}, true).start, false);
  team.investigator.provider = "claude-code";
  assert.equal(canStart(template, team).ok, true);
  assert.deepEqual(teamPayload(template, team, { issue: "Login" }, true), {
    templateId: "bug-clinic",
    inputs: { issue: "Login" },
    agentByRole: { developer: "d1" },
    providerByRole: { investigator: "claude-code", developer: "claude-code" },
    // Only the role marked "new": the unstaffed QA role gets no profile.
    createAgents: ["investigator"],
    start: true,
  });
});

test("the relay preview names who holds each step and what it waits for", () => {
  const team = {
    investigator: { agent: "new", provider: "claude-code" },
    developer: { agent: "d1", provider: "" },
    qa: { agent: "", provider: "" },
  };
  const preview = relayPreview(template, team, [{ id: "d1", name: "Nova" }]);
  assert.deepEqual(
    preview.map((step) => [step.title, step.holder, step.provider, step.after]),
    [
      ["Reproduce", "Investigator", "claude-code", []],
      ["Diagnose", "Investigator", "claude-code", ["Reproduce"]],
      ["Fix", "Nova", "", ["Diagnose"]],
      ["Regression", "Unassigned", "codex", ["Fix"]],
    ],
  );
});

test("step titles show what was typed, never a raw {{placeholder}}", async () => {
  const { fillTitle, shortTitle } =
    await import("../apps/web/src/hooks/teamLogic.js");
  assert.equal(
    fillTitle("Reproduce: {{issue}}", { issue: " Login " }),
    "Reproduce: Login",
  );
  assert.equal(fillTitle("Reproduce: {{ issue }}", {}), "Reproduce: …");
  assert.equal(shortTitle("Reproduce: {{issue}}"), "Reproduce");
  assert.equal(shortTitle("{{issue}}"), "{{issue}}");
  const preview = relayPreview(template, {}, [], { issue: "Login" });
  assert.equal(preview[1].title, "Diagnose");
  assert.deepEqual(preview[1].after, ["Reproduce"]);
});
