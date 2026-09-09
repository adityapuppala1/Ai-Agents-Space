import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, schemaVersion } from "../packages/core/src/db.js";
import {
  Audit,
  auditHash,
  canonicalJson,
  csvCell,
  redactSecrets,
} from "../packages/core/src/audit/Audit.js";
import auditRoutes from "../packages/server/src/routes/audit.js";

function setup() {
  const db = openDatabase(":memory:");
  let clock = 1_700_000_000_000;
  const audit = new Audit(db, { now: () => (clock += 1000) });
  return { db, audit };
}

test("migration 5 adds the hash chain columns", () => {
  const { db } = setup();
  assert.ok(schemaVersion(db) >= 5, "schema is at least v5");
  const columns = db
    .prepare("PRAGMA table_info(audit_log)")
    .all()
    .map((row) => row.name);
  for (const column of ["prev_hash", "hash", "sequence"])
    assert.ok(columns.includes(column), `audit_log has ${column}`);
});

test("records are chained: sequence increments and prev_hash links", () => {
  const { audit } = setup();
  const first = audit.record({ actor: "alice", action: "run.start" });
  const second = audit.record({
    actor: "bob",
    action: "run.cancel",
    target: "run-1",
  });
  assert.equal(first.sequence, 1);
  assert.equal(first.prevHash, null);
  assert.equal(second.sequence, 2);
  assert.equal(second.prevHash, first.hash);
  assert.match(first.hash, /^[0-9a-f]{64}$/);

  const recomputed = auditHash({
    sequence: 2,
    timestamp: second.timestamp,
    actor: "bob",
    action: "run.cancel",
    target: "run-1",
    policyDecision: null,
    details: {},
    prevHash: first.hash,
  });
  assert.equal(recomputed, second.hash);
});

test("verify walks the chain and reports the first broken sequence", () => {
  const { db, audit } = setup();
  for (let i = 0; i < 5; i += 1)
    audit.record({ actor: "alice", action: `step.${i}`, details: { i } });
  const clean = audit.verify();
  assert.equal(clean.ok, true);
  assert.equal(clean.brokenAt, null);
  assert.equal(clean.count, 5);
  assert.equal(clean.unchained, 0);

  // Tamper with the third record's contents, leaving its hash in place.
  db.prepare("UPDATE audit_log SET actor = ? WHERE sequence = 3").run(
    "mallory",
  );
  const broken = audit.verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 3);
  assert.match(broken.brokenReason, /does not match/);
});

test("verify detects a record removed from the middle of the chain", () => {
  const { db, audit } = setup();
  for (let i = 0; i < 4; i += 1)
    audit.record({ actor: "alice", action: `step.${i}` });
  db.prepare("DELETE FROM audit_log WHERE sequence = 2").run();
  const broken = audit.verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 3);
  assert.match(broken.brokenReason, /removed/);
});

test("pruning the oldest records keeps the chain verifiable", () => {
  const { db, audit } = setup();
  for (let i = 0; i < 4; i += 1)
    audit.record({ actor: "alice", action: `step.${i}` });
  db.prepare("DELETE FROM audit_log WHERE sequence <= 2").run();
  const result = audit.verify();
  assert.equal(result.ok, true, "retention trims a prefix, not the middle");
  assert.equal(result.firstSequence, 3);
  assert.equal(result.count, 2);
});

test("secret-looking details are still redacted before hashing", () => {
  const { audit } = setup();
  const entry = audit.record({
    actor: "alice",
    action: "connection.probe",
    details: { authToken: "sk-abcdef123456", provider: "codex" },
  });
  assert.equal(entry.details.authToken, "[redacted]");
  assert.equal(entry.details.provider, "codex");
  assert.equal(
    JSON.stringify(redactSecrets({ apiKey: "x" })),
    JSON.stringify({ apiKey: "[redacted]" }),
  );
  assert.equal(audit.verify().ok, true);
});

test("canonical JSON sorts keys so detail order cannot change a hash", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const a = auditHash({
    sequence: 1,
    timestamp: 1,
    actor: "x",
    action: "y",
    target: null,
    policyDecision: null,
    details: { one: 1, two: 2 },
    prevHash: null,
  });
  const b = auditHash({
    sequence: 1,
    timestamp: 1,
    actor: "x",
    action: "y",
    target: null,
    policyDecision: null,
    details: { two: 2, one: 1 },
    prevHash: null,
  });
  assert.equal(a, b);
});

test("CSV export quotes commas, quotes, and newlines", () => {
  const { audit } = setup();
  audit.record({
    actor: 'ops "night shift"',
    action: "ops.stopAll",
    target: "a,b",
    details: { reason: "line one\nline two" },
  });
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell(null), "");

  const csv = audit.exportCsv();
  const [header, ...rest] = csv.split("\r\n");
  assert.equal(header.split(",")[0], "sequence");
  const row = rest[0];
  assert.ok(row.includes('"ops ""night shift"""'), "actor quotes are doubled");
  assert.ok(row.includes('"a,b"'), "commas inside a field are quoted");
  assert.ok(
    row.includes("line one\\nline two"),
    "the newline lives inside the JSON details field, escaped",
  );
  // One logical row: the embedded newline is JSON-escaped, not a raw break.
  assert.equal(
    csv.trimEnd().split("\r\n").length,
    2,
    "header plus exactly one record",
  );
});

test("JSON export carries the verification result and the entries", () => {
  const { audit } = setup();
  audit.record({ actor: "alice", action: "one" });
  audit.record({ actor: "alice", action: "two" });
  const parsed = JSON.parse(audit.exportJson());
  assert.equal(parsed.count, 2);
  assert.equal(parsed.verification.ok, true);
  assert.equal(parsed.entries[0].action, "one", "oldest first");
  assert.equal(parsed.entries[1].sequence, 2);
});

test("export filters by since and workspace", () => {
  const { audit } = setup();
  audit.record({
    actor: "a",
    action: "old",
    timestamp: 1000,
    workspaceId: "w1",
  });
  audit.record({
    actor: "a",
    action: "new",
    timestamp: 9000,
    workspaceId: "w2",
  });
  const filtered = JSON.parse(audit.exportJson({ since: 5000 }));
  assert.equal(filtered.count, 1);
  assert.equal(filtered.entries[0].action, "new");
  const scoped = JSON.parse(audit.exportJson({ workspaceId: "w1" }));
  assert.equal(scoped.count, 1);
  assert.equal(scoped.entries[0].action, "old");
});

// --------------------------------------------------------------- routes

test("routes: /api/audit, /api/audit/verify, /api/audit/export", async () => {
  const { audit } = setup();
  audit.record({ actor: "alice", action: "run.start", target: "run-1" });
  const services = { audit };

  const make = (method, path, search = "") => {
    const state = { status: 0, data: null, headers: {}, body: "" };
    const ctx = {
      method,
      path,
      query: new URLSearchParams(search),
      send: (status, data) => {
        state.status = status;
        state.data = data;
      },
      res: {
        writeHead: (status, headers) => {
          state.status = status;
          state.headers = headers;
        },
        end: (text) => {
          state.body = text;
        },
      },
      services,
      actor: "local-user",
      body: async () => ({}),
    };
    return { ctx, state };
  };

  const list = make("GET", "/api/audit");
  assert.equal(await auditRoutes(list.ctx), true);
  assert.ok(
    Array.isArray(list.state.data),
    "/api/audit still returns an array",
  );
  assert.equal(list.state.data[0].action, "run.start");

  const verify = make("GET", "/api/audit/verify");
  assert.equal(await auditRoutes(verify.ctx), true);
  assert.equal(verify.state.data.ok, true);

  const csv = make("GET", "/api/audit/export", "format=csv");
  assert.equal(await auditRoutes(csv.ctx), true);
  assert.match(csv.state.headers["Content-Type"], /text\/csv/);
  assert.match(csv.state.body, /^sequence,id,timestamp/);
  assert.equal(
    audit.list({ action: "audit.export" }).length,
    1,
    "the export itself is audited",
  );

  const bad = make("GET", "/api/audit/export", "format=xml");
  await assert.rejects(auditRoutes(bad.ctx), (error) => error.status === 400);

  const other = make("GET", "/api/other");
  assert.equal(await auditRoutes(other.ctx), false);
});
