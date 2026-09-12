import test from "node:test";
import assert from "node:assert/strict";
import {
  cardProgress,
  buildEventsFrom,
  isBuildCommand,
  isDeployCommand,
  agentDirectory,
} from "../apps/web/src/hooks/viewLogic.js";
import {
  pulseEntries,
  runningProviderSet,
  PULSE_STATES,
  compatibilityRows,
  connectionState,
  connectionSummary,
  connectionOutages,
  groupCapabilities,
} from "../apps/web/src/hooks/providerStatus.js";

/**
 * Truth rules for small UI labels: a provider run never shows an invented
 * percentage, and provider detection is never worded as more than it proves.
 */

test("a provider-backed task card shows run status and elapsed, never a percentage", () => {
  const task = { status: "IN_PROGRESS", progress: 0 };
  const run = {
    mode: "observed",
    status: "running",
    startedAt: "2026-09-11T10:00:00.000Z",
  };
  const now = Date.parse("2026-09-11T10:46:04.000Z");
  assert.equal(cardProgress(task, run, now), "Running 46m 04s");
  assert.doesNotMatch(cardProgress(task, run, now), /%/);
  const stale = {
    ...run,
    status: "stale",
    endedAt: "2026-09-11T10:05:00.000Z",
  };
  assert.equal(cardProgress(task, stale, now), "Stale 5m 00s");
  assert.equal(
    cardProgress(task, { mode: "managed", status: "queued" }, now),
    "Queued",
  );
});

test("only a manual or demo task in progress carries a percentage", () => {
  assert.equal(
    cardProgress({ status: "IN_PROGRESS", progress: 30 }, null),
    "30%",
  );
  assert.equal(
    cardProgress(
      { status: "IN_PROGRESS", progress: 30 },
      { mode: "manual", status: "running" },
    ),
    "30%",
  );
  assert.equal(cardProgress({ status: "QUEUE", progress: 0 }, null), null);
  assert.equal(
    cardProgress({ status: "COMPLETED", progress: 100 }, null),
    null,
  );
});

test("the provider pulse lists providers on this machine with honest states", () => {
  const connections = [
    { id: "a", provider: "codex", alias: "default", status: "ready" },
    { id: "b", provider: "claude-code", alias: "default", status: "ready" },
    { id: "c", provider: "copilot", alias: "default", status: "detected" },
    { id: "d", provider: "cursor", alias: "default", status: "missing" },
    { id: "e", provider: "claude-code", alias: "work", status: "ready" },
    { id: "f", provider: "gemini", alias: "default", status: "error" },
  ];
  const entries = pulseEntries(connections, new Set(["claude-code"]));
  // An absent provider is left to the Connections page; aliases are not
  // repeated in the top bar; order is stable.
  assert.deepEqual(
    entries.map((entry) => [entry.provider, entry.state, entry.label]),
    [
      ["claude-code", "running", "Running"],
      ["codex", "ready", "Available"],
      ["copilot", "detected", "Installed"],
      ["gemini", "error", "Failed"],
    ],
  );
  // "Available" never claims a run was verified.
  assert.match(PULSE_STATES.ready.detail, /does not verify a run/);
});

test("running providers come from live sessions and active runs only", () => {
  const running = runningProviderSet(
    [
      { provider: "codex", activeProviderRun: true },
      { provider: "copilot", activeProviderRun: false },
    ],
    [
      { provider: "claude-code", liveSessions: 1 },
      { provider: "gemini", liveSessions: 0 },
    ],
  );
  assert.deepEqual([...running].sort(), ["claude-code", "codex"]);
});

test("only a command that runs a build or deploy counts as one", () => {
  // Observed on this machine: tool names inside other commands were being
  // shown on the office pipeline wall as builds.
  for (const text of [
    "Ran: npm uninstall @tailwindcss/vite tailwindcss",
    "Ran: npx prettier --write apps/web/vite.config.js",
    "Ran: git push origin main",
    "Ran: grep -rn build src",
    "Ran: cat Makefile",
  ])
    assert.equal(isBuildCommand(text) || isDeployCommand(text), false, text);
  for (const text of [
    "Ran: npm run build",
    "Ran: vite build apps/web --config apps/web/vite.config.js",
    "Ran: cargo build --release",
    "Ran: dotnet build",
    "Ran: cd web && pnpm build",
    "Ran: make",
  ])
    assert.equal(isBuildCommand(text), true, text);
  for (const text of [
    "Ran: npm publish",
    "Ran: kubectl apply -f deploy.yaml",
    "Ran: terraform apply",
  ])
    assert.equal(isDeployCommand(text), true, text);
});

test("the pipeline wall shows recent recorded builds and every test check", () => {
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const events = [
    {
      id: 1,
      kind: "command",
      message: "Ran: npm run build",
      timestamp: "2026-09-11T11:30:00.000Z",
    },
    {
      id: 2,
      kind: "command",
      message: "Ran: npm uninstall @tailwindcss/vite",
      timestamp: "2026-09-11T11:40:00.000Z",
    },
    {
      id: 3,
      kind: "test",
      message: "Ran: node --test",
      timestamp: "2026-09-11T11:50:00.000Z",
    },
    {
      id: 4,
      kind: "command",
      message: "Ran: npm run build",
      timestamp: "2026-09-10T08:00:00.000Z",
    },
  ];
  const list = buildEventsFrom(events, null, { now });
  assert.deepEqual(
    list.map((item) => [item.id, item.kind, item.status]),
    [
      [1, "build", "recorded"],
      [3, "check", "recorded"],
    ],
  );
  assert.equal(buildEventsFrom([], null, { now }), undefined);
  // The workspace snapshot sends epoch milliseconds, not ISO strings; the
  // window must hold for those too (Date.parse of a number is NaN).
  const numeric = events.map((event) => ({
    ...event,
    timestamp: Date.parse(event.timestamp),
  }));
  assert.deepEqual(
    buildEventsFrom(numeric, null, { now }).map((item) => item.id),
    [1, 3],
  );
});

test("the compatibility card reads the keyed object the server returns", () => {
  const rows = compatibilityRows({
    "claude-code": {
      provider: "claude-code",
      version: "2.1.258",
      testedVersions: ["2.1.258", "2.1.266"],
      testedOS: ["win32"],
      supported: true,
      reason: "Claude Code 2.1.258 was tested on win32.",
      notes: "Headless stream-json launch and the hook bridge were exercised.",
    },
    gemini: {
      provider: "gemini",
      version: "0.59.0",
      testedVersions: [],
      testedOS: [],
      supported: false,
      reason: "Gemini CLI 0.59.0 has not been tested on this OS.",
    },
  });
  assert.deepEqual(
    rows.map((row) => [row.provider, row.tested, row.testedVersions.length]),
    [
      ["claude-code", true, 2],
      ["gemini", false, 0],
    ],
  );
  assert.match(rows[1].reason, /not been tested/);
  assert.deepEqual(compatibilityRows(null), []);
  assert.equal(
    compatibilityRows([{ provider: "codex", verified: true }])[0].tested,
    true,
  );
});

test("the agent directory sorts working, attention and idle agents and filters them", () => {
  const agents = [
    {
      id: "a",
      name: "Atlas",
      role: "Architect",
      activity: "IDLE",
      skills: ["planning"],
    },
    {
      id: "n",
      name: "Nova",
      role: "Frontend",
      activity: "CODING",
      provider: "codex",
      activeProviderRun: true,
    },
    {
      id: "e",
      name: "Echo",
      role: "Backend",
      activity: "WAITING_APPROVAL",
      runStatus: "waiting_approval",
      provider: "claude-code",
    },
    {
      id: "s",
      name: "Sage",
      role: "Research",
      activity: "STALE",
      runStatus: "stale",
      provider: "codex",
    },
  ];
  const all = agentDirectory(agents);
  assert.deepEqual(all.counts, { all: 4, working: 1, attention: 2, idle: 1 });
  // Needs attention first, then working, then idle; names break ties.
  assert.deepEqual(
    all.rows.map((row) => row.agent.id),
    ["e", "s", "n", "a"],
  );
  assert.equal(all.rows.find((row) => row.agent.id === "s").state, "attention");
  assert.deepEqual(
    agentDirectory(agents, { status: "working" }).rows.map((r) => r.agent.id),
    ["n"],
  );
  assert.deepEqual(
    agentDirectory(agents, { provider: "codex" }).rows.map((r) => r.agent.id),
    ["s", "n"],
  );
  // Search reaches name, role, skills and the provider's display name.
  assert.deepEqual(
    agentDirectory(agents, { query: "planning" }).rows.map((r) => r.agent.id),
    ["a"],
  );
  assert.deepEqual(
    agentDirectory(agents, { query: "claude" }).rows.map((r) => r.agent.id),
    ["e"],
  );
  assert.deepEqual(all.providers, ["claude-code", "codex"]);
});

test("connection rows use the product words and an absent CLI is not a failure", () => {
  const running = new Set(["claude-code"]);
  const label = (connection) => connectionState(connection, running).label;
  assert.equal(label({ provider: "codex", status: "ready" }), "Available");
  assert.equal(label({ provider: "copilot", status: "detected" }), "Installed");
  assert.equal(
    label({ provider: "cursor", status: "missing" }),
    "Not detected",
  );
  assert.equal(label({ provider: "gemini", status: "error" }), "Failed");
  assert.equal(label({ provider: "gemini", status: "weird" }), "Not checked");
  assert.equal(label({ provider: "claude-code", status: "ready" }), "Running");
  // A live session cannot be attributed to one of several accounts.
  assert.equal(
    label({ provider: "claude-code", alias: "work", status: "ready" }),
    "Available",
  );
  assert.equal(
    connectionState({ provider: "cursor", status: "missing" }, running).tone,
    "muted",
  );
  // No sign-in file is explained, not escalated to a claim of signed-out.
  const unsigned = connectionState(
    {
      provider: "copilot",
      status: "detected",
      details: { authHint: "no-credentials-file" },
    },
    running,
  );
  assert.equal(unsigned.label, "Installed");
  assert.match(unsigned.detail, /no sign-in file was found/);
  assert.match(unsigned.detail, /keychain/);

  const summary = connectionSummary(
    [
      { provider: "claude-code", status: "ready" },
      { provider: "claude-code", alias: "work", status: "ready" },
      { provider: "codex", status: "ready" },
      { provider: "copilot", status: "detected" },
      { provider: "cursor", status: "missing" },
    ],
    running,
  );
  assert.deepEqual(
    summary.map((entry) => `${entry.count} ${entry.label}`),
    ["1 Running", "1 Available", "1 Installed", "1 Not detected"],
  );
});

test("the outage banner fires for a failed check or a tripped breaker, never for an absent CLI", () => {
  const connections = [
    { id: "cursor-default", provider: "cursor", status: "missing" },
    {
      id: "gemini-default",
      provider: "gemini",
      status: "error",
      error: "exit 1",
    },
    { id: "codex-default", provider: "codex", status: "ready" },
    {
      id: "copilot-default",
      provider: "copilot",
      status: "error",
      enabled: false,
    },
  ];
  const breakers = [
    { provider: "codex", state: "open", lastError: "usage limit" },
    { provider: "claude-code", state: "closed" },
  ];
  const outages = connectionOutages(connections, breakers);
  assert.deepEqual(
    outages.map((row) => [row.provider, row.reason]),
    [
      ["gemini", "exit 1"],
      ["codex", "usage limit"],
    ],
  );
  // The health payload once had no breaker list; nothing is invented then.
  assert.deepEqual(
    connectionOutages([{ provider: "codex", status: "ready" }], null),
    [],
  );
});

test("the capability matrix is grouped by level with readable names", () => {
  const groups = groupCapabilities({
    observe: "verified",
    launch: "verified",
    attach: "experimental",
    fork: "unsupported",
    delegate: "odd-value",
  });
  assert.deepEqual(
    groups.verified.map((cap) => cap.label),
    ["Observe sessions", "Launch runs"],
  );
  assert.deepEqual(
    groups.experimental.map((cap) => cap.key),
    ["attach"],
  );
  assert.deepEqual(
    groups.unsupported.map((cap) => cap.key),
    ["fork"],
  );
  assert.deepEqual(
    groups.unknown.map((cap) => cap.key),
    ["delegate"],
  );
});

test("the workspace switcher states what is going on without repeating detection", async () => {
  const { workspaceStats, workspaceRuntimeNote } =
    await import("../apps/web/src/hooks/workspaceSummary.js");
  const { themeLabel } = await import("../apps/web/src/office/themeCatalog.js");
  assert.equal(
    workspaceStats({ agents: 3, activeRuns: 2, attention: 1 }),
    "3 agents · 2 running · 1 needs attention",
  );
  // Zero counts are left out rather than shown as "0 need attention".
  assert.equal(workspaceStats({ agents: 1, activeRuns: 0 }), "1 agent");
  assert.equal(workspaceStats({}), "No agents yet");
  // Every workspace may launch every runtime: nothing to add per row.
  const open = [
    { provider: "codex", status: "ready" },
    { provider: "claude-code", status: "detected" },
    { provider: "cursor", status: "missing" },
  ];
  assert.equal(workspaceRuntimeNote(open, "w1"), null);
  // Once a runtime is scoped, each row names what it may launch.
  const scoped = [
    { provider: "codex", status: "ready", allowedWorkspaces: ["w2"] },
    { provider: "claude-code", status: "detected" },
  ];
  assert.equal(workspaceRuntimeNote(scoped, "w1"), "Can launch: Claude Code");

  // One signal per row, because a row is skimmed rather than read.
  const { workspaceSignal } = await import(
    "../apps/web/src/hooks/workspaceSummary.js"
  );
  // Attention outranks running: it is the only one that needs the reader.
  assert.deepEqual(workspaceSignal({ activeRuns: 2, attention: 1 }), {
    text: "1 attention",
    tone: "attention",
    label: "1 needs attention",
  });
  assert.equal(workspaceSignal({ activeRuns: 2 }).text, "2 running");
  assert.equal(workspaceSignal({ attention: 3 }).label, "3 need attention");
  // Nothing going on says nothing at all, never "0 running".
  assert.equal(workspaceSignal({ agents: 5, activeRuns: 0, attention: 0 }), null);
  assert.equal(workspaceSignal({}), null);
  assert.equal(
    workspaceRuntimeNote(scoped, "w2"),
    "Can launch: Codex, Claude Code",
  );
  // A theme id never reaches the screen as an id.
  assert.equal(themeLabel("data-lab").label, "Data lab");
  assert.equal(themeLabel("new-theme").label, "New theme");
});

test("the operations summary uses product words and waits for data", async () => {
  const { healthSummary, providerCounts, formatBytes } =
    await import("../apps/web/src/hooks/opsSummary.js");
  // Before the health check answers, nothing is claimed.
  assert.equal(healthSummary(null).label, "Checking health…");
  assert.equal(healthSummary({ status: "ok", alerts: [] }).label, "Healthy");
  const degraded = healthSummary({
    status: "degraded",
    alerts: [{ code: "ops.dispatch-stopped" }],
  });
  assert.equal(degraded.label, "Needs attention");
  assert.match(degraded.detail, /1 alert/);
  assert.equal(
    healthSummary({ status: "down", db: { writable: false } }).detail,
    "the database is not writable",
  );
  // Observed on this machine: "Providers ready 3 of 5 detected" counted a
  // CLI that is not installed as detected.
  const counts = providerCounts({
    providers: {
      connections: [
        { provider: "claude-code", status: "ready", enabled: true },
        { provider: "codex", status: "ready", enabled: true },
        { provider: "gemini", status: "ready", enabled: false },
        { provider: "copilot", status: "detected", enabled: true },
        { provider: "cursor", status: "missing", enabled: true },
        { provider: "codex", alias: "work", status: "ready", enabled: true },
      ],
    },
  });
  assert.deepEqual(counts, { installed: 4, available: 2 });
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(52_428_800), "50 MB");
  assert.equal(formatBytes(null), null);
});

test("a live session is Active, Quiet or Ended from its recorded state", async () => {
  const { sessionState } = await import("../apps/web/src/hooks/viewLogic.js");
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  assert.equal(
    sessionState(
      { live: true, status: "running", lastEventAt: now - 5000 },
      now,
    ).label,
    "Active",
  );
  // An open process whose run went stale is not "live" work.
  const quiet = sessionState(
    { live: true, status: "stale", lastEventAt: now - 12 * 60_000 },
    now,
  );
  assert.equal(quiet.label, "Quiet");
  assert.match(quiet.detail, /nothing has been recorded for 12m 00s/);
  assert.equal(sessionState({ live: false }, now).label, "Ended");
  assert.equal(
    sessionState({ live: true, endedAt: now - 1000 }, now).key,
    "ended",
  );
  assert.match(
    sessionState({ live: true, status: "running" }, now).detail,
    /first event/,
  );
});

test("a manual task shows that it is in progress, never the profile's working style", async () => {
  const { isManualWork, activityOf, isOnFloor } =
    await import("../apps/web/src/office/presence.js");
  const { hoverPreview } = await import("../apps/web/src/office/data.js");
  const { cueForAgent } =
    await import("../apps/web/src/office/choreography.js");
  const { campusRooms } = await import("../apps/web/src/views/campusData.js");
  // What the server sends for Nova on a manual task: the state is the working
  // style chosen on the profile ("CODING"), not anything that was reported.
  const nova = {
    id: "nova",
    name: "Nova",
    taskId: "t1",
    taskTitle: "Write the release notes",
    state: "CODING",
    activity: null,
    activityProvenance: "profile",
    runMode: "manual",
  };
  assert.equal(isManualWork(nova), true);
  assert.equal(activityOf(nova), "MANUAL");
  assert.equal(isOnFloor(nova), true);
  const preview = hoverPreview(nova);
  assert.equal(preview.activity, "In progress");
  assert.equal(preview.manual, true);
  // The figure waits at its own desk; nothing is acted out.
  const cue = cueForAgent(nova);
  assert.equal(cue.destination, "desk");
  assert.equal(cue.effect, "quiet");
  // Servers before the "profile" provenance sent "user" for the same case.
  assert.equal(isManualWork({ ...nova, activityProvenance: "user" }), true);
  // A blocked task is a recorded fact, and so is a provider's activity.
  assert.equal(
    isManualWork({ ...nova, state: "BLOCKED", activityProvenance: "user" }),
    false,
  );
  assert.equal(
    isManualWork({
      ...nova,
      runMode: "observed",
      activity: "CODING",
      activityProvenance: "inferred",
    }),
    false,
  );
  // A demo task is simulated and labelled as such elsewhere.
  assert.equal(
    isManualWork({
      ...nova,
      runMode: "simulated",
      activityProvenance: "system",
    }),
    false,
  );
  // No task, no work.
  assert.equal(isManualWork({ ...nova, taskId: undefined }), false);
  // The enriched agent's own flag wins.
  assert.equal(isManualWork({ ...nova, manualWork: false }), false);
  // Campus files it apart from the room its working style would suggest.
  const [room] = campusRooms({ agents: [nova] });
  assert.equal(room.name, "Manual tasks");
  assert.equal(room.people[0].activity, "MANUAL");
});

test("the activity feed groups by day and never dates an event it cannot", async () => {
  const { activityDays } = await import("../apps/web/src/hooks/viewLogic.js");
  const { timeAgo } = await import("../apps/web/src/hooks/useApi.js");
  const now = new Date(2026, 8, 11, 17, 5, 0).getTime();
  const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).getTime();
  const events = [
    { id: "a", timestamp: at(11, 17, 1) },
    { id: "b", timestamp: at(11, 9) },
    { id: "c", timestamp: at(10, 23, 59) },
    { id: "d", timestamp: at(8, 12) },
    { id: "e", timestamp: null },
    // An ISO string from an older payload still lands on its day.
    { id: "f", timestamp: new Date(at(8, 11)).toISOString() },
  ];
  const days = activityDays(events, now);
  assert.deepEqual(
    days.map((day) => [
      day.label === "Today" || day.label === "Yesterday" ? day.label : "date",
      day.events.map((e) => e.id).join(""),
    ]),
    [
      ["Today", "ab"],
      ["Yesterday", "c"],
      ["date", "df"],
      ["date", "e"],
    ],
  );
  assert.equal(days.at(-1).label, "Time not recorded");
  assert.deepEqual(activityDays([], now), []);
  // Relative times grow past the hour instead of reading "125m ago".
  assert.equal(timeAgo(now - 30_000, now), "just now");
  assert.equal(timeAgo(now - 4 * 60_000, now), "4m ago");
  assert.equal(timeAgo(now - 125 * 60_000, now), "2h ago");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3d ago");
  assert.equal(timeAgo(new Date(now - 60_000).toISOString(), now), "1m ago");
  assert.equal(timeAgo(null, now), null);
  assert.equal(timeAgo("not a date", now), null);
});

test("older activity pages join the live head without a gap or a duplicate", async () => {
  const { mergeEventHistory, eventHistoryTotal } =
    await import("../apps/web/src/hooks/viewLogic.js");
  const ev = (sequence) => ({
    id: `e${sequence}`,
    sequence,
    timestamp: sequence,
  });
  // The first page was read from the newest event: 101..200.
  const fetched = Array.from({ length: 100 }, (_, i) => ev(200 - i));
  // Ten new events arrived since; the live head is now 151..210, so 141..150
  // have scrolled off it but are still in the fetched page.
  const head = Array.from({ length: 60 }, (_, i) => ev(210 - i));
  const merged = mergeEventHistory(head, fetched);
  assert.equal(merged.length, 110);
  assert.equal(merged[0].sequence, 210);
  assert.equal(merged.at(-1).sequence, 101);
  for (let i = 1; i < merged.length; i++)
    assert.equal(merged[i - 1].sequence - merged[i].sequence, 1);
  // The total grows with events newer than the one it was read at.
  assert.equal(eventHistoryTotal({ total: 200, newest: 200 }, head), 210);
  assert.equal(eventHistoryTotal(null, head), null);
  // An older server's snapshot has no sequence: order by time instead.
  const old = mergeEventHistory([
    { id: "a", timestamp: 1 },
    { id: "b", timestamp: 3 },
    { id: "c", timestamp: 2 },
  ]);
  assert.deepEqual(
    old.map((event) => event.id),
    ["b", "c", "a"],
  );
});

test("a request that needs two approvers says who has approved and who is still needed", async () => {
  const { dualApprovalState, approverLabel } =
    await import("../apps/web/src/hooks/viewLogic.js");
  assert.equal(dualApprovalState({ requiredDecisions: 1 }), null);
  const none = dualApprovalState({ requiredDecisions: 2, decisions: [] });
  assert.equal(none.remaining, 2);
  assert.equal(none.awaitingSecond, false);
  const one = dualApprovalState({
    requiredDecisions: 2,
    awaitingSecondApprover: true,
    decisions: [
      { actor: "local-user:Alice", decision: "approve" },
      { actor: "local-user:Carol", decision: "request-change" },
    ],
  });
  // A change request is not an approval.
  assert.deepEqual(one.approvedLabels, ["Alice"]);
  assert.equal(one.remaining, 1);
  assert.equal(one.awaitingSecond, true);
  assert.equal(approverLabel("local-user"), "local-user");
  assert.equal(approverLabel("token:ops"), "ops");
  assert.equal(approverLabel(""), "someone");
});

test("a run action is reported as what it did, never 'review accepted.' after a rejection", async () => {
  const { actionMessage } = await import("../apps/web/src/hooks/viewLogic.js");
  assert.match(
    actionMessage("review", { decision: "reject" }),
    /^Review rejected/,
  );
  assert.match(
    actionMessage("review", { decision: "accept" }),
    /^Review accepted/,
  );
  assert.match(actionMessage("cancel"), /not undone/);
  assert.equal(
    actionMessage("retry", {}, { attempt: 2 }),
    "Retry started as attempt 2.",
  );
  assert.equal(
    actionMessage("input", { text: "go" }),
    "Input sent to the run.",
  );
  assert.equal(actionMessage("input", { resume: true }), "Resume requested.");
});
