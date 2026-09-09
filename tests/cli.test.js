import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import { createWorkspaceServer } from "../packages/server/src/server.js";
import { TaskGraph } from "../packages/core/src/workflows/TaskGraph.js";
import { WorkflowService } from "../packages/core/src/workflows/WorkflowService.js";
import { Analytics } from "../packages/core/src/analytics/Analytics.js";
import { ContextManifest } from "../packages/core/src/context/ContextManifest.js";
import workflowRoutes from "../packages/server/src/routes/workflows.js";
import analyticsRoutes from "../packages/server/src/routes/analytics.js";
import contextRoutes from "../packages/server/src/routes/context.js";
import exportRoutes from "../packages/server/src/routes/export.js";
import workspaceRoutes from "../packages/server/src/routes/workspaces.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "bin", "agent-space.js");

/** Echo route standing in for module F's hook bridge. */
async function fakeHookRoute(ctx) {
  if (ctx.method === "POST" && ctx.path === "/api/hooks/claude-code") {
    const payload = await ctx.body(262144);
    if (payload.tool_input?.command === "REJECT") {
      ctx.send(401, { error: "Unauthorized" });
      return true;
    }
    if (payload.tool_input?.command === "HANG")
      await new Promise((resolve) => setTimeout(resolve, 2500));
    ctx.send(200, {
      hookSpecificOutput: {
        hookEventName: payload.hook_event_name,
        permissionDecision: "allow",
        permissionDecisionReason: `echo ${payload.tool_name}`,
      },
    });
    return true;
  }
  if (ctx.method === "GET" && ctx.path === "/api/hooks/claude-code/status") {
    ctx.send(200, { installed: false });
    return true;
  }
  return false;
}

function run(args, { input, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          ...process.env,
          AGENT_SPACE_URL: "",
          AGENT_SPACE_TOKEN: "",
          ...env,
        },
        windowsHide: true,
        timeout: 20000,
      },
      (error, stdout, stderr) =>
        resolvePromise({ code: error?.code ?? 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function boot(t, { token = null } = {}) {
  const services = createServices({ demo: true });
  const graph = new TaskGraph(services);
  services.workflows = new WorkflowService(services, { graph });
  services.analytics = new Analytics(services);
  services.context = new ContextManifest(services, { git: false });
  const server = createWorkspaceServer({
    services,
    token,
    routes: [
      fakeHookRoute,
      workflowRoutes,
      analyticsRoutes,
      contextRoutes,
      exportRoutes,
      workspaceRoutes,
    ],
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { services, server, url };
}

test("workspaces --json prints the workspace list with exit 0", async (t) => {
  const { url } = await boot(t);
  const result = await run(["workspaces", "--json", "--url", url]);
  assert.equal(result.code, 0, result.stderr);
  const list = JSON.parse(result.stdout);
  assert.equal(list[0].id, "demo");
  const human = await run(["workspaces", "--url", url]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^id\s+name/);
  assert.match(human.stdout, /demo/);
});

test("usage errors exit 2 and unreachable servers exit 1", async () => {
  const none = await run([]);
  assert.equal(none.code, 2);
  assert.match(none.stdout, /Commands/);
  const unknown = await run(["frobnicate", "--url", "http://127.0.0.1:1"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command/);
  const bad = await run(["task", "create", "--url", "http://127.0.0.1:1"]);
  assert.equal(bad.code, 2);
  const down = await run([
    "workspaces",
    "--json",
    "--url",
    "http://127.0.0.1:1",
  ]);
  assert.equal(down.code, 1);
  assert.match(down.stderr, /Cannot reach/);
});

test("hook claude-code forwards stdin to the server and prints the response verbatim", async (t) => {
  const { url } = await boot(t);
  const payload = {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    cwd: "C:/work",
  };
  const result = await run(["hook", "claude-code", "--url", url], {
    input: JSON.stringify(payload),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "echo Bash",
    },
  });
  // The env var is honored when --url is omitted.
  const viaEnv = await run(["hook", "claude-code"], {
    input: JSON.stringify(payload),
    env: { AGENT_SPACE_URL: url },
  });
  assert.equal(viaEnv.code, 0);
  assert.equal(
    JSON.parse(viaEnv.stdout).hookSpecificOutput.permissionDecision,
    "allow",
  );
  // Never blocks Claude Code: server down → {} on stdout, exit 0, error on stderr.
  const down = await run(
    ["hook", "claude-code", "--url", "http://127.0.0.1:1"],
    { input: JSON.stringify(payload) },
  );
  assert.equal(down.code, 0);
  assert.equal(down.stdout.trim(), "{}");
  assert.match(down.stderr, /agent-space hook/);
  const garbage = await run(["hook", "claude-code", "--url", url], {
    input: "not json",
  });
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout.trim(), "{}");
  const status = await run(["hook", "status", "--json", "--url", url]);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).installed, false);
});

test("token auth, templates, workflow start, graph, tasks, analytics, and doctor over HTTP", async (t) => {
  const { url } = await boot(t, { token: "secret" });
  const denied = await run(["workspaces", "--json", "--url", url]);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /401/);
  const env = { AGENT_SPACE_TOKEN: "secret" };

  const templates = await run(["templates", "--json", "--url", url], { env });
  assert.equal(templates.code, 0, templates.stderr);
  assert.equal(JSON.parse(templates.stdout).length, 13);

  const created = await run(
    ["task", "create", "demo", "--title", "CLI task", "--json", "--url", url],
    { env },
  );
  assert.equal(created.code, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).title, "CLI task");

  const started = await run([
    "workflow",
    "start",
    "demo",
    "bug-clinic",
    "--input",
    "issue=Flaky test",
    "--json",
    "--url",
    url,
    "--token",
    "secret",
  ]);
  assert.equal(started.code, 0, started.stderr);
  const workflow = JSON.parse(started.stdout);
  assert.equal(workflow.tasks.length, 4);
  assert.equal(workflow.tasks[0].title, "Reproduce: Flaky test");

  const graph = await run(["graph", "demo", "--json", "--url", url], { env });
  assert.equal(graph.code, 0, graph.stderr);
  const g = JSON.parse(graph.stdout);
  assert.equal(g.edges.length, 3);
  assert.equal(g.criticalPath.length, 4);
  const humanGraph = await run(["graph", "demo", "--url", url], { env });
  assert.match(humanGraph.stdout, /critical path: /);

  const tasks = await run(["tasks", "demo", "--url", url], { env });
  assert.equal(tasks.code, 0);
  assert.match(tasks.stdout, /Reproduce: Flaky test/);
  const runs = await run(["runs", "demo", "--json", "--url", url], { env });
  assert.equal(runs.code, 0);
  assert.ok(Array.isArray(JSON.parse(runs.stdout)));

  const analytics = await run(
    ["analytics", "--workspace", "demo", "--json", "--url", url],
    { env },
  );
  assert.equal(analytics.code, 0, analytics.stderr);
  const summary = JSON.parse(analytics.stdout);
  assert.ok(summary.funnel.created >= 11);
  assert.ok(summary.byProvider.some((p) => p.provider === "simulated"));
  assert.equal(summary.byProvider[0].costUsd.reported, false);
  const humanAnalytics = await run(["analytics", "--url", url], { env });
  assert.match(humanAnalytics.stdout, /Funnel: created/);
  assert.match(humanAnalytics.stdout, /not reported/);

  // doctor: health works; connections route is absent in this harness and reported as unavailable.
  const doctor = await run(["doctor", "--json", "--url", url], { env });
  assert.equal(doctor.code, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.health.status, "ok");
  assert.match(report.doctorError, /404/);
});

test("REST routes: dependencies, ready, context preview/stale, export/import, analytics export", async (t) => {
  const { url, services } = await boot(t);
  const json = (path, method = "GET", data) =>
    fetch(url + path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    }).then(async (r) => [
      r.status,
      r.headers.get("content-type"),
      await r.text(),
    ]);
  const parse = (text) => JSON.parse(text);

  let [status, , body] = await json("/api/workspaces", "POST", {
    name: "Routes",
    rootPath: here,
  });
  const ws = parse(body).id;
  [status, , body] = await json(`/api/workspaces/${ws}/tasks`, "POST", {
    title: "A",
  });
  const a = parse(body).id;
  [status, , body] = await json(`/api/workspaces/${ws}/tasks`, "POST", {
    title: "B",
  });
  const b = parse(body).id;
  [status, , body] = await json(
    `/api/workspaces/${ws}/tasks/${b}/dependencies`,
    "PATCH",
    { dependsOn: [a] },
  );
  assert.equal(status, 200);
  assert.deepEqual(parse(body).dependsOn, [a]);
  [status, , body] = await json(
    `/api/workspaces/${ws}/tasks/${a}/dependencies`,
    "PATCH",
    { dependsOn: [b] },
  );
  assert.equal(status, 409);
  assert.match(parse(body).error, /cycle/);
  [status, , body] = await json(`/api/workspaces/${ws}/tasks/ready`);
  assert.deepEqual(
    parse(body).map((n) => n.id),
    [a],
  );
  [status, , body] = await json(`/api/workspaces/${ws}/graph`);
  assert.equal(parse(body).edges.length, 1);
  [status, , body] = await json(`/api/templates/feature-delivery`);
  assert.equal(parse(body).steps.length, 5);
  [status] = await json(`/api/templates/nope`);
  assert.equal(status, 404);
  [status, , body] = await json(`/api/workspaces/${ws}/workflows`, "POST", {
    templateId: "design-review",
    inputs: { screen: "Inbox" },
  });
  assert.equal(status, 201);
  const workflowId = parse(body).id;
  [status, , body] = await json(`/api/workflows/${workflowId}`);
  assert.equal(parse(body).tasks.length, 3);
  [status, , body] = await json(`/api/workspaces/${ws}/workflows`);
  assert.equal(parse(body).length, 1);
  [status, , body] = await json(
    `/api/workflows/${workflowId}/archive`,
    "POST",
    {},
  );
  assert.equal(parse(body).status, "archived");
  [status, , body] = await json(`/api/workspaces/${ws}/workflows`, "POST", {
    inputs: {},
  });
  assert.equal(status, 400);

  [status, , body] = await json(
    `/api/workspaces/${ws}/context/preview`,
    "POST",
    { files: ["cli.test.js", "../.env"], instructions: ["Be brief"] },
  );
  assert.equal(status, 200);
  const manifest = parse(body);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.estimateLabel, "estimate");
  [status, , body] = await json(`/api/workspaces/${ws}/context/stale`, "POST", {
    manifest,
  });
  assert.equal(parse(body).stale, false);

  [status, , body] = await json(`/api/workspaces/${ws}/export`);
  assert.equal(status, 200);
  const exported = parse(body);
  assert.equal(exported.tasks.length, 5);
  assert.ok(!body.includes(here.replace(/\\/g, "\\\\")));
  [status, , body] = await json(`/api/workspaces/import`, "POST", {
    manifest: exported,
    name: "Routes copy",
  });
  assert.equal(status, 201, body);
  assert.equal(parse(body).tasks, 5);
  assert.ok(services.hub.has(parse(body).workspace.id));

  let type;
  [status, type, body] = await json(
    `/api/analytics/export?format=csv&workspace=${ws}`,
  );
  assert.equal(status, 200);
  assert.match(type, /text\/csv/);
  assert.match(body, /^runId,workspaceId/);
  assert.equal(body.trim().split(String.fromCharCode(13, 10)).length, 1);
  [status, , body] = await json(`/api/analytics?workspace=${ws}`);
  assert.equal(parse(body).funnel.created, 5);
  [status] = await json(`/api/analytics?workspace=ghost`);
  assert.equal(status, 404);
});

test("hook claude-code fails closed on timeouts and rejected requests, never when the server is down", async (t) => {
  const { url } = await boot(t);
  const pre = {
    session_id: "s2",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "REJECT" },
    cwd: "C:/work",
  };
  // 401/403 (token misconfiguration): a PreToolUse is denied, visibly.
  const rejected = await run(["hook", "claude-code", "--url", url], {
    input: JSON.stringify(pre),
  });
  assert.equal(rejected.code, 0);
  const denied = JSON.parse(rejected.stdout).hookSpecificOutput;
  assert.equal(denied.hookEventName, "PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /401/);
  assert.match(rejected.stderr, /server responded 401/);
  // Other hook events have no decision to withhold.
  const post = await run(["hook", "claude-code", "--url", url], {
    input: JSON.stringify({ ...pre, hook_event_name: "PostToolUse" }),
  });
  assert.equal(post.stdout.trim(), "{}");
  // The server holds the request (approval pending) past the CLI deadline.
  const slow = await run(
    ["hook", "claude-code", "--url", url, "--timeout", "2"],
    { input: JSON.stringify({ ...pre, tool_input: { command: "HANG" } }) },
  );
  assert.equal(slow.code, 0);
  const timedOut = JSON.parse(slow.stdout).hookSpecificOutput;
  assert.equal(timedOut.permissionDecision, "deny");
  assert.match(timedOut.permissionDecisionReason, /did not answer within 2 s/);
  assert.match(timedOut.permissionDecisionReason, /pending/);
});
