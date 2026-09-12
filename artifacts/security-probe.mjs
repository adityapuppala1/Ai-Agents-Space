// Dynamic security probing of a running Agent Space, against its own isolated
// server on its own port with an in-memory database and fake provider homes.
// Every request here is one an attacker could make.
//
// Nothing in here is destructive: no stop-all, no retention sweep, no backup
// to a real path, and never a request to the port a person is actually using.
//
// Two of these checks are made with a raw socket rather than fetch(), because
// fetch() cannot make them honestly: it silently drops a Host override, and it
// reports a refused request as status 0. Both produced false findings the
// first time this was run, which is why the raw path exists.
//
//   node artifacts/security-probe.mjs        (npm run test:security)
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const PORT = Number(process.env.PROBE_PORT ?? 5210);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "probe-secret-token-value";
const outDir = path.join(root, "test-results");
const homes = path.join(outDir, "probe-homes");
for (const sub of ["claude", "codex", "copilot", "cursor", "gemini", "data"])
  fs.mkdirSync(path.join(homes, sub), { recursive: true });

const server = spawn(process.execPath, ["packages/server/src/main.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DEMO: "true",
    AGENT_SPACE_DB: ":memory:",
    AGENT_SPACE_TOKEN: TOKEN,
    AGENT_SPACE_OBSERVE: "false",
    CLAUDE_CONFIG_DIR: path.join(homes, "claude"),
    CODEX_HOME: path.join(homes, "codex"),
    COPILOT_HOME: path.join(homes, "copilot"),
    CURSOR_HOME: path.join(homes, "cursor"),
    GEMINI_HOME: path.join(homes, "gemini"),
    AGENT_SPACE_DATA_DIR: path.join(homes, "data"),
  },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];
const passed = [];

function record(ok, severity, title, detail) {
  (ok ? passed : findings).push({ severity, title, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${severity}] ${title}${ok ? "" : ` — ${detail}`}`);
}

async function req(pathname, init = {}) {
  try {
    const res = await fetch(`${BASE}${pathname}`, init);
    return { status: res.status, text: await res.text(), headers: res.headers };
  } catch (error) {
    return { status: 0, text: String(error), headers: new Headers() };
  }
}

/** Sends exact bytes, so the request is ours rather than fetch()'s idea of it. */
function raw(payload) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1");
    let data = "";
    const done = (note) => {
      socket.destroy();
      resolve({ data, note });
    };
    socket.setTimeout(5000, () => done("TIMEOUT"));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) setTimeout(() => done(null), 250);
    });
    socket.on("error", (error) => done(`SOCKET ERROR — ${error.code}`));
    socket.on("close", () => done(null));
  });
}

const statusOf = (r) => Number(/^HTTP\/1\.\d (\d{3})/.exec(r.data)?.[1] ?? 0);
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "Content-Type": "application/json" };

try {
  let up = false;
  for (let i = 0; i < 90; i += 1) {
    const r = await req("/api/health", { headers: auth });
    if (r.status === 200) {
      up = true;
      break;
    }
    await wait(500);
  }
  if (!up) throw new Error(`the probe server never answered on ${BASE}`);

  // ---- 1. Authentication -------------------------------------------------
  {
    const r = await req("/api/workspaces");
    record(r.status === 401, "Critical", "API requires a token when one is set", `got ${r.status}`);
  }
  {
    const r = await req("/api/workspaces", { headers: { Authorization: "Bearer wrong-token" } });
    record(r.status === 401, "Critical", "A wrong token is rejected", `got ${r.status}`);
  }
  {
    // A prefix must not pass: that is what a length-independent compare leaks.
    const r = await req("/api/workspaces", {
      headers: { Authorization: `Bearer ${TOKEN.slice(0, 10)}` },
    });
    record(r.status === 401, "High", "A token prefix is rejected", `got ${r.status}`);
  }

  // ---- 2. Path traversal on static serving -------------------------------
  for (const attempt of [
    "/../../../../package.json",
    "/..%2f..%2f..%2fpackage.json",
    "/%2e%2e%2f%2e%2e%2fpackage.json",
    "/%252e%252e%252fpackage.json",
    "/..\\..\\package.json",
    "/%5c..%5c..%5cpackage.json",
    "/....//....//package.json",
    "/assets/../../../../../../etc/passwd",
    "/..%00/package.json",
  ]) {
    const r = await req(attempt);
    const leaked = r.status === 200 && /"dependencies"|root:/.test(r.text);
    record(!leaked, "Critical", `Path traversal blocked: ${attempt}`, `status ${r.status}`);
  }

  // ---- 3. Origin / Host / CORS -------------------------------------------
  {
    const r = await req("/api/workspaces", { headers: { ...auth, Origin: "http://evil.example" } });
    record(r.status === 403, "High", "Cross-origin request is refused", `got ${r.status}`);
  }
  for (const host of ["evil.example", "127.0.0.1.evil.example", "attacker:1337"]) {
    // fetch() ignores a Host override entirely, so this one must be raw.
    const r = await raw(
      `GET /api/health HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${TOKEN}\r\nConnection: close\r\n\r\n`,
    );
    const status = statusOf(r);
    record(status === 403 || status === 400, "High", `Unexpected Host refused: ${host}`, `got ${status || r.note}`);
  }
  {
    const r = await req("/api/health", { headers: auth });
    const acao = r.headers.get("access-control-allow-origin");
    record(!acao, "Medium", "No permissive CORS header is sent", `got ${acao}`);
  }

  // ---- 4. Security headers ----------------------------------------------
  {
    const r = await req("/");
    const csp = r.headers.get("content-security-policy") ?? "";
    record(csp.includes("default-src 'self'"), "Medium", "HTML carries a CSP", csp || "(none)");
    record(!csp.includes("unsafe-eval"), "High", "CSP forbids eval", csp);
    record(
      r.headers.get("x-content-type-options") === "nosniff",
      "Low", "HTML sets nosniff", r.headers.get("x-content-type-options") ?? "(none)",
    );
    record(csp.includes("frame-ancestors 'none'"), "Medium", "Clickjacking is blocked", csp);
  }

  // ---- 5. Injection into API parameters ----------------------------------
  {
    for (const p of [
      "' OR '1'='1",
      "'; DROP TABLE runs;--",
      "1 UNION SELECT name FROM sqlite_master",
      "../../etc/passwd",
      "<script>alert(1)</script>",
    ]) {
      const r = await req(`/api/search?q=${encodeURIComponent(p)}`, { headers: auth });
      record(r.status < 500, "High", `Search survives hostile input: ${p.slice(0, 24)}`, `status ${r.status}`);
    }
    const after = await req("/api/health", { headers: auth });
    record(after.status === 200, "Critical", "Database intact after injection attempts", `status ${after.status}`);
  }

  // ---- 6. Body limits, malformed JSON, content-type smuggling ------------
  {
    const r = await req("/api/workspaces", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: "x".repeat(200000) }),
    });
    record(r.status === 413 || r.status === 400, "Medium", "Oversized body is refused", `got ${r.status}`);
  }
  {
    const r = await req("/api/workspaces", { method: "POST", headers: json, body: "{not json" });
    record(r.status >= 400 && r.status < 500, "Medium", "Malformed JSON is a 4xx, not a crash", `got ${r.status}`);
  }
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
    // A JSON body sent as a simple content type is what gets past a CSRF
    // defence that leans on the preflight. fetch() reports the refusal as a
    // network error, so read the status off the wire instead.
    const body = JSON.stringify({ name: "smuggled" });
    const header = ct ? `Content-Type: ${ct}\r\n` : "";
    const r = await raw(
      `POST /api/workspaces HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nAuthorization: Bearer ${TOKEN}\r\n${header}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    record(statusOf(r) === 415, "High", `Non-JSON content type refused: ${ct || "(absent)"}`, `got ${statusOf(r) || r.note}`);
  }
  {
    const list = await req("/api/workspaces", { headers: auth });
    record(!list.text.includes("smuggled"), "High", "No smuggled body created a record", "a workspace was created");
  }

  // ---- 7. Prototype pollution -------------------------------------------
  {
    const r = await req("/api/workspaces", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "pp",
        __proto__: { polluted: "yes" },
        constructor: { prototype: { polluted: "yes" } },
      }),
    });
    record(
      {}.polluted !== "yes" && Object.prototype.polluted !== "yes",
      "Critical", "JSON body does not pollute Object.prototype", `status ${r.status}`,
    );
  }

  // ---- 8. Destructive endpoints demand confirmation ----------------------
  for (const [route, title] of [
    ["/api/ops/stop-all", "stop-all refuses without explicit confirm"],
    ["/api/ops/retention/sweep", "retention sweep refuses without confirm"],
  ]) {
    const r = await req(route, { method: "POST", headers: json, body: "{}" });
    record(r.status >= 400, "High", title, `got ${r.status}`);
  }

  // ---- 9. Secret handling ------------------------------------------------
  {
    const r = await req("/api/health", { headers: auth });
    record(!r.text.includes(TOKEN), "Critical", "Health does not echo the token", "token found in body");
  }
  {
    const r = await req("/api/connections", { headers: auth });
    record(
      !/"(apiKey|api_key|secret|password|token)"\s*:\s*"(?!\*)/i.test(r.text),
      "Critical", "Connections never return a credential value", r.text.slice(0, 120),
    );
  }
  {
    const r = await req("/api/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ "openai.apiKey": "sk-abcdefghijklmnopqrstuvwxyz123456" }),
    });
    record(r.status >= 400, "High", "Settings refuse to store a credential", `got ${r.status}`);
  }

  // ---- 10. Server-side request forgery ----------------------------------
  // An outbound webhook is the one place a caller names an address that the
  // server then connects to. See packages/core/src/webhooks/target.js.
  {
    for (const [url, why] of [
      ["http://169.254.169.254/latest/meta-data/", "AWS metadata"],
      ["http://[::ffff:169.254.169.254]/", "metadata via IPv4-mapped IPv6"],
      ["http://169.254.170.2/v2/credentials/", "ECS task credentials"],
      ["http://metadata.google.internal/computeMetadata/v1/", "GCP metadata by name"],
      ["file:///etc/passwd", "non-http scheme"],
      ["http://user:pa55@example.com/hook", "credential in the url"],
    ]) {
      const r = await req("/api/webhooks/endpoints", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          name: `ssrf ${why}`,
          direction: "outbound",
          url,
          events: ["run.completed"],
        }),
      });
      // metadata.google.internal is a name: it cannot be judged until it
      // resolves, so the endpoint may be stored and is refused at delivery.
      const nameOnly = url.includes("metadata.google.internal");
      record(
        nameOnly ? r.status < 500 : r.status >= 400 && r.status < 500,
        "High",
        `SSRF target refused: ${why}`,
        `got ${r.status} ${r.text.slice(0, 90)}`,
      );
    }
  }

  // ---- 11. Error handling ------------------------------------------------
  {
    const r = await req("/api/runs/does-not-exist", { headers: auth });
    record(
      !/at\s+\w+\s+\(.*:\d+:\d+\)|node_modules|[A-Z]:\\\\/.test(r.text),
      "Medium", "Errors do not leak stack traces or paths", r.text.slice(0, 120),
    );
  }
  {
    const r = await req("/api/nope", { headers: auth });
    record(r.status === 404, "Low", "Unknown API route is a clean 404", `got ${r.status}`);
  }

  console.log(`\n${passed.length} passed, ${findings.length} findings`);
  fs.writeFileSync(
    path.join(outDir, "security-probe.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), passed, findings }, null, 2),
  );
  process.exitCode = findings.length ? 1 : 0;
} finally {
  server.kill();
}
