import test from "node:test";
import assert from "node:assert/strict";
import { createServices } from "../packages/core/src/services.js";
import {
  Router,
  SENSITIVITY_LEVELS,
  VENDORS,
  allowedFallback,
  capRefusal,
  dataRefusal,
  effectiveSensitivity,
  rankProviders,
  stricterSensitivity,
  vendorOf,
} from "../packages/core/src/routing/router.js";
import {
  validatePolicy,
  mergePolicy,
} from "../packages/core/src/policy/Policy.js";

/**
 * Routing ranks assistants and says why; the data rules and daily caps are
 * enforced at launch, so a ranking is advice and a refusal is not.
 */

const connected = (statuses) => (provider) =>
  statuses[provider] ? { status: statuses[provider] } : { status: "missing" };
const allConnected = connected({
  "claude-code": "ready",
  codex: "ready",
  copilot: "ready",
  cursor: "ready",
  gemini: "ready",
});
const byId = (result) =>
  Object.fromEntries(result.candidates.map((c) => [c.provider, c]));
const failing = (candidate) =>
  candidate.checks.filter((check) => !check.ok).map((check) => check.check);

test("an assistant that cannot be started or is not connected is never recommended", () => {
  const result = rankProviders({
    connectionOf: connected({ "claude-code": "ready", codex: "detected" }),
  });
  const c = byId(result);
  assert.equal(result.recommended, "claude-code");
  assert.equal(c["claude-code"].eligible, true);
  assert.equal(c.codex.eligible, true, "installed, sign-in not verified");
  assert.deepEqual(failing(c.cursor), ["launch", "connection"]);
  assert.deepEqual(failing(c.copilot), ["connection"]);
  // Eligible first; connected before merely installed.
  assert.deepEqual(
    result.candidates.slice(0, 2).map((c) => c.provider),
    ["claude-code", "codex"],
  );
  assert.match(result.why, /^Claude Code: connected, launch verified/);
});

test("data rules keep a label's work with the vendors allowed to receive it", () => {
  assert.equal(vendorOf("codex"), "openai");
  assert.equal(vendorOf("claude-code"), "anthropic");
  assert.ok(VENDORS.github);
  const policy = { dataRules: { confidential: ["anthropic"], restricted: [] } };
  const confidential = byId(
    rankProviders({
      policy,
      label: "confidential",
      connectionOf: allConnected,
    }),
  );
  assert.equal(confidential["claude-code"].eligible, true);
  assert.deepEqual(failing(confidential.codex), ["data"]);
  assert.match(
    confidential.codex.checks.find((check) => check.check === "data").text,
    /Confidential work may go only to Anthropic.*Codex sends work to OpenAI/,
  );
  const restricted = rankProviders({
    policy,
    label: "restricted",
    connectionOf: allConnected,
  });
  assert.equal(restricted.recommended, null, "no vendor may receive it");
  assert.equal(restricted.why, null);
  // A label without a rule may go anywhere; no label, no rule applies.
  assert.equal(dataRefusal(policy, "internal", "codex"), null);
  assert.equal(dataRefusal(policy, null, "codex"), null);
});

test("a task can raise its label, never lower it", () => {
  assert.deepEqual(SENSITIVITY_LEVELS, [
    "public",
    "internal",
    "confidential",
    "restricted",
  ]);
  assert.equal(stricterSensitivity("internal", "confidential"), "confidential");
  assert.equal(stricterSensitivity("confidential", "public"), "confidential");
  assert.equal(stricterSensitivity(null, "public"), "public");
  assert.equal(stricterSensitivity(null, null), null);
  const policy = { dataSensitivity: "internal" };
  assert.equal(effectiveSensitivity(policy, "restricted"), "restricted");
  assert.equal(effectiveSensitivity(policy, "public"), "internal");
  assert.equal(effectiveSensitivity({}, null), null);
});

test("required capabilities, allow lists and daily caps each exclude, with the reason", () => {
  const matrices = {
    "claude-code": { launch: "verified", approve: "unknown" },
    codex: { launch: "experimental", approve: "experimental" },
    copilot: { launch: "verified", approve: "unsupported" },
  };
  const base = {
    providers: ["claude-code", "codex", "copilot"],
    connectionOf: allConnected,
    capabilitiesOf: (id) => matrices[id],
  };
  const approve = byId(rankProviders({ ...base, requires: ["approve"] }));
  assert.deepEqual(failing(approve["claude-code"]), ["requires"]);
  assert.equal(approve.codex.eligible, true, "experimental is allowed");
  assert.match(
    approve.copilot.checks.find((c) => c.check === "requires").text,
    /Needs approve, which is unsupported for GitHub Copilot/,
  );
  const strict = byId(
    rankProviders({ ...base, requires: ["approve"], allowExperimental: false }),
  );
  assert.equal(strict.codex.eligible, false);

  const allowed = byId(
    rankProviders({ ...base, policy: { allowedProviders: ["codex"] } }),
  );
  assert.deepEqual(failing(allowed["claude-code"]), ["allowed"]);

  const policy = { providerDailyTokens: { codex: 1000 } };
  const over = byId(
    rankProviders({
      ...base,
      policy,
      usageOf: (id) =>
        id === "codex" ? { tokens: 1500, reported: true } : { tokens: 0 },
    }),
  );
  assert.deepEqual(failing(over.codex), ["budget"]);
  assert.match(
    capRefusal(policy, "codex", { tokens: 1500 }).reason,
    /Codex has used 1,500 of its 1,000 tokens for today/,
  );
  assert.equal(capRefusal(policy, "codex", { tokens: 999 }), null);
  assert.equal(capRefusal(policy, "claude-code", { tokens: 9e9 }), null);
});

test("pass rates rank only with enough graded results; the workspace's order wins", () => {
  const same = () => ({ launch: "verified" });
  const base = {
    providers: ["claude-code", "codex"],
    connectionOf: allConnected,
    capabilitiesOf: same,
  };
  const graded = byId(
    rankProviders({
      ...base,
      evaluationsOf: (id) =>
        id === "codex" ? { pass: 9, fail: 1 } : { pass: 2, fail: 8 },
    }),
  );
  assert.match(
    graded.codex.checks.find((c) => c.check === "evaluation").text,
    /90% of graded results passed \(9 of 10\)/,
  );
  const ranked = rankProviders({
    ...base,
    evaluationsOf: (id) =>
      id === "codex" ? { pass: 9, fail: 1 } : { pass: 2, fail: 8 },
  });
  assert.equal(ranked.recommended, "codex");
  // Too few grades: no comparison, so the tie falls back to the id.
  const few = rankProviders({
    ...base,
    evaluationsOf: (id) =>
      id === "codex" ? { pass: 3, fail: 0 } : { pass: 0, fail: 3 },
  });
  assert.equal(few.recommended, "claude-code");
  assert.match(
    byId(few).codex.checks.find((c) => c.check === "evaluation").text,
    /3 graded results; 5 needed to compare/,
  );
  // The workspace's own order comes before everything else that qualifies.
  const preferred = rankProviders({
    ...base,
    policy: { routingPreference: ["claude-code"] },
    evaluationsOf: (id) =>
      id === "codex" ? { pass: 9, fail: 1 } : { pass: 2, fail: 8 },
  });
  assert.equal(preferred.recommended, "claude-code");
  assert.match(preferred.why, /first in this workspace's order/);
});

test("a fallback is offered only where the work's data may go", () => {
  const rules = { dataRules: { confidential: ["anthropic"] } };
  assert.deepEqual(
    allowedFallback("claude-code", { rules, label: "confidential" }),
    { provider: "claude-code", refused: null },
  );
  const refused = allowedFallback("codex", { rules, label: "confidential" });
  assert.equal(refused.provider, null);
  assert.match(refused.refused, /Codex sends work to OpenAI/);
  assert.deepEqual(allowedFallback(null, { rules, label: "confidential" }), {
    provider: null,
    refused: null,
  });
});

test("routing fields are validated and merged with safe defaults", () => {
  assert.deepEqual(
    validatePolicy({
      dataSensitivity: "internal",
      dataRules: { confidential: ["anthropic", "anthropic"], public: null },
      providerDailyTokens: { codex: 5000, copilot: null },
      routingPreference: ["claude-code", "codex", "claude-code"],
      minEvaluations: 3,
    }),
    {
      dataSensitivity: "internal",
      dataRules: { confidential: ["anthropic"] },
      providerDailyTokens: { codex: 5000 },
      routingPreference: ["claude-code", "codex"],
      minEvaluations: 3,
    },
  );
  for (const bad of [
    { dataSensitivity: "secret" },
    { dataRules: { secret: [] } },
    { dataRules: { public: ["acme"] } },
    { providerDailyTokens: { nobody: 5 } },
    { providerDailyTokens: { codex: 0 } },
    { routingPreference: ["nobody"] },
    { minEvaluations: 0 },
  ])
    assert.throws(() => validatePolicy(bad), /./, JSON.stringify(bad));
  const merged = mergePolicy({}, {});
  assert.equal(merged.dataSensitivity, null);
  assert.deepEqual(merged.dataRules, {});
  assert.deepEqual(merged.providerDailyTokens, {});
  assert.deepEqual(merged.routingPreference, []);
  assert.equal(merged.minEvaluations, 5);
});

test("the data rule and the daily cap are enforced at launch; a task cannot loosen them", () => {
  const services = createServices({ demo: false });
  const workspace = services.hub.create({ name: "Routed" });
  services.policy.setForWorkspace(workspace.id, {
    dataSensitivity: "confidential",
    dataRules: { confidential: ["anthropic"] },
    providerDailyTokens: { "claude-code": 1000 },
  });
  const launch = (provider, override = null) =>
    services.policy.evaluateLaunch({
      workspaceId: workspace.id,
      provider,
      override,
    });
  const codex = launch("codex");
  assert.equal(codex.allowed, false);
  assert.equal(codex.rule, "launch.data.destination");
  assert.equal(codex.effective.sensitivity, "confidential");
  // A task that calls itself public does not lower the workspace label.
  assert.equal(launch("codex", { sensitivity: "public" }).allowed, false);
  // A run override cannot carry its own looser rules either.
  assert.equal(launch("codex", { dataRules: {} }).allowed, false);
  assert.equal(launch("claude-code").allowed, true);

  // Claude Code reported 1,200 tokens today: its cap is reached.
  const agent = services.hub.get(workspace.id).createAgent({
    name: "Claude",
    role: "Coder",
    provider: "claude-code",
  });
  const task = services.hub.get(workspace.id).create({ title: "Earlier work" });
  services.db
    .prepare(
      `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, status, started_at, mode, usage)
       VALUES ('run-cap', ?, ?, ?, '{}', 'claude-code', 'completed', ?, 'managed', ?)`,
    )
    .run(
      workspace.id,
      task.id,
      agent.id,
      Date.now(),
      JSON.stringify({ input_tokens: 700, output_tokens: 500 }),
    );
  const capped = launch("claude-code");
  assert.equal(capped.allowed, false);
  assert.equal(capped.rule, "launch.budget.provider");
  assert.match(capped.reason, /1,200 of its 1,000 tokens/);
});

test("the router reads the workspace, the task's label and the live facts", () => {
  const services = createServices({ demo: false });
  services.connections = {
    list: () => [
      { provider: "claude-code", status: "ready", enabled: true },
      { provider: "codex", status: "ready", enabled: true },
      {
        provider: "copilot",
        status: "ready",
        enabled: true,
        allowedWorkspaces: ["elsewhere"],
      },
    ],
    hooksInstalled: () => true,
  };
  const router = new Router(services);
  const workspace = services.hub.create({ name: "Routed" });
  services.policy.setForWorkspace(workspace.id, {
    dataRules: { confidential: ["anthropic"] },
  });
  const open = router.rank({ workspaceId: workspace.id });
  assert.equal(open.label, null);
  assert.equal(byId(open).codex.eligible, true);
  assert.deepEqual(failing(byId(open).copilot), ["connection"]);
  // With hooks installed, Claude Code's approvals are verified.
  assert.equal(
    byId(router.rank({ workspaceId: workspace.id, requires: ["approve"] }))[
      "claude-code"
    ].eligible,
    true,
  );
  const task = services.hub.get(workspace.id).create({
    title: "Customer export",
    executionPolicy: { sensitivity: "confidential" },
  });
  const labelled = router.rank({ workspaceId: workspace.id, taskId: task.id });
  assert.equal(labelled.label, "confidential");
  assert.equal(labelled.recommended, "claude-code");
  assert.deepEqual(failing(byId(labelled).codex), ["data"]);
});
