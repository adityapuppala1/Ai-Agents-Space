import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices } from "../packages/core/src/services.js";
import { RunRecorder } from "../packages/core/src/runs/RunRecorder.js";
import { createRunWorker } from "../packages/core/src/runs/RunWorker.js";
import { createSearch } from "../packages/core/src/search/Search.js";
import { validateResult } from "../packages/core/src/workflows/contracts.js";
import {
  extractSnippets,
  fileHintFor,
  hasFileTarget,
  normalizeLanguage,
  selectSnippets,
  snippetDigest,
  SNIPPET_LIMIT,
} from "../packages/core/src/runs/artifacts.js";

const F = "```";
const lines = (...parts) => parts.join("\n");
const reasonsOf = (skipped) => skipped.map((entry) => entry.reason);

function setup(t) {
  const services = createServices({ demo: false });
  const dataDir = mkdtempSync(join(tmpdir(), "agent-space-snippets-"));
  const recorder = new RunRecorder(services, { broadcastIntervalMs: 1 });
  const worker = createRunWorker(services, { recorder, dataDir });
  const workspace = services.hub.get(
    services.hub.create({ name: "Snippets" }).id,
  );
  const run = recorder.ensureRun({
    workspaceId: workspace.id,
    agentId: workspace.createAgent({ name: "Claude Code", role: "Coder" }).id,
    mode: "managed",
    provider: "claude-code",
    createTask: { title: "Explain the sort" },
  });
  t.after(async () => {
    await worker.close();
    recorder.flush();
    await services.close();
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* Windows may hold a handle briefly */
    }
  });
  const entry = {
    runId: run.id,
    snippets: [],
    snippetDigests: new Set(),
    snippetOverflow: 0,
    messageIndex: 0,
  };
  const message = (text) =>
    worker.collectSnippets(entry, { kind: "message", data: { text } });
  const capture = (final = {}, touchedFiles = new Set()) =>
    worker.captureSnippets(entry, final, touchedFiles);
  const snippetArtifacts = () =>
    recorder.artifacts(run.id).filter((a) => a.kind === "snippet");
  return {
    services,
    recorder,
    worker,
    workspace,
    run,
    entry,
    message,
    capture,
    snippetArtifacts,
  };
}

test("the fence info string is the only source of a snippet's language", () => {
  const found = extractSnippets(
    lines(
      "Here is the helper:",
      "",
      `${F}js`,
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      F,
      "",
      "And an unlabelled one:",
      "",
      F,
      "some_call(1)",
      "another_call(2)",
      F,
    ),
  );
  assert.equal(found.length, 2);
  assert.equal(found[0].language, "javascript");
  assert.equal(found[0].languageRaw, "js");
  assert.equal(found[0].languageSource, "fence");
  assert.equal(
    found[0].body,
    "export function add(a, b) {\n  return a + b;\n}",
  );
  assert.doesNotMatch(found[0].body, /```/);

  // An unlabelled fence reports no language rather than guessing one from a
  // body that plainly looks like code.
  assert.equal(found[1].language, null);
  assert.equal(found[1].languageRaw, null);
  assert.equal(found[1].languageSource, "none");
  assert.deepEqual(normalizeLanguage(null), {
    language: null,
    languageRaw: null,
    languageSource: "none",
  });
  assert.equal(normalizeLanguage("PY").language, "python");
});

test("tilde fences parse and a wider fence swallows the fence it wraps", () => {
  const tilde = extractSnippets(
    lines("~~~py", "def go():", "    return 1", "~~~"),
  );
  assert.equal(tilde.length, 1);
  assert.equal(tilde[0].language, "python");
  assert.equal(tilde[0].languageRaw, "py");

  const nested = extractSnippets(
    lines(
      "````markdown",
      "Use this:",
      `${F}js`,
      "run();",
      F,
      "That is all.",
      "````",
    ),
  );
  assert.equal(nested.length, 1, "the wrapped fence is body, not a snippet");
  assert.match(nested[0].body, /```js/);
  assert.equal(nested[0].language, "markdown");
});

test("a fence names a file in its info, the line above, or a leading comment", () => {
  assert.equal(fileHintFor({ info: "js src/app.js" }), "src/app.js");
  assert.equal(fileHintFor({ info: "js:src/app.js" }), "src/app.js");
  assert.equal(fileHintFor({ info: 'js title="src/app.js"' }), "src/app.js");
  assert.equal(fileHintFor({ precedingLine: "**src/app.js**" }), "src/app.js");
  assert.equal(
    fileHintFor({ precedingLine: "File: src/app.js" }),
    "src/app.js",
  );
  assert.equal(fileHintFor({ firstBodyLine: "// src/app.js" }), "src/app.js");
  assert.equal(fileHintFor({ firstBodyLine: "# app/main.py" }), "app/main.py");
  assert.equal(
    fileHintFor({ firstBodyLine: "<!-- index.html -->" }),
    "index.html",
  );
  assert.equal(
    fileHintFor({ info: "python", precedingLine: "Try this:" }),
    null,
  );

  for (const text of [
    lines(`${F}js src/app.js`, "boot();", "start();", F),
    lines("**src/app.js**", "", `${F}js`, "boot();", "start();", F),
    lines(`${F}js`, "// src/app.js", "boot();", "start();", F),
  ]) {
    const [snippet] = extractSnippets(text);
    assert.equal(snippet.fileHint, "src/app.js", text);
    assert.equal(hasFileTarget(snippet).targeted, true, text);
  }
});

test("a fence that mentions a file the run touched counts as targeted", () => {
  const text = lines(
    "The helpers.js module now exports the shape below.",
    "Use it wherever you need an empty record:",
    "",
    `${F}js`,
    "export const shape = { id: null, name: null };",
    "export const empty = () => ({ ...shape });",
    F,
  );
  const [snippet] = extractSnippets(text);
  assert.equal(
    snippet.fileHint,
    null,
    "the line above the fence names no file",
  );
  assert.equal(hasFileTarget(snippet).targeted, false);
  const targeted = hasFileTarget(snippet, {
    touchedFiles: new Set(["src/helpers.js"]),
  });
  assert.equal(targeted.targeted, true);
  assert.match(targeted.reason, /helpers\.js/);
  assert.deepEqual(
    reasonsOf(
      selectSnippets([snippet], {
        touchedFiles: new Set(["src/helpers.js"]),
      }).skipped,
    ),
    ["targeted"],
  );
});

test("diff and patch fences are never materialized as snippets", () => {
  assert.equal(
    hasFileTarget({ language: "diff", fileHint: null, hintWindow: "" })
      .targeted,
    true,
  );
  const found = extractSnippets(
    lines(
      `${F}diff`,
      "@@ -1,2 +1,3 @@",
      "-const a = 1;",
      "+const a = 2;",
      "+const b = 3;",
      F,
      "",
      `${F}patch`,
      "*** Begin Patch",
      "*** Update File: lib/thing.rb",
      "*** End Patch",
      F,
    ),
  );
  assert.equal(found.length, 2);
  const { kept, skipped } = selectSnippets(found);
  assert.equal(kept.length, 0);
  assert.deepEqual(reasonsOf(skipped), ["targeted", "targeted"]);
});

test("short and non-code fences are dropped with a stated reason", () => {
  const found = extractSnippets(
    lines(
      `${F}js`,
      "go();",
      F,
      "",
      `${F}text`,
      "The build finished in 4.2 seconds with no errors.",
      "Nothing else of interest happened during the run.",
      F,
      "",
      `${F}console`,
      "$ npm run build --silent --workspaces false",
      "$ npm run lint --silent --workspaces false",
      F,
    ),
  );
  const { kept, skipped } = selectSnippets(found);
  assert.equal(kept.length, 0);
  assert.deepEqual(reasonsOf(skipped), [
    "too-short",
    "non-code-language",
    "non-code-language",
  ]);
  for (const entry of skipped) assert.ok(entry.detail, "every drop says why");
});

test("a fence naming a secret path is refused before anything else", () => {
  const found = extractSnippets(
    lines(
      `${F}env .env`,
      "API_TOKEN=not-a-real-token-value-here",
      "API_HOST=https://example.invalid",
      F,
    ),
  );
  assert.equal(found[0].fileHint, ".env");
  const { kept, skipped } = selectSnippets(found);
  assert.equal(kept.length, 0);
  assert.deepEqual(reasonsOf(skipped), ["secret"]);
});

test("the digest ignores line endings, trailing spaces and trailing blanks", () => {
  const a = snippetDigest("javascript", "run();\nstop();");
  const b = snippetDigest("javascript", "run();  \r\nstop();\t\r\n\r\n\r\n");
  assert.equal(a, b);
  assert.notEqual(a, snippetDigest("typescript", "run();\nstop();"));
  assert.notEqual(a, snippetDigest("javascript", "run();\nstop(1);"));
});

test("a block quoted twice is one artifact, and re-capturing adds none", (t) => {
  const { recorder, run, message, capture, snippetArtifacts } = setup(t);
  const body = lines(
    "def sort_pairs(pairs):",
    "    return sorted(pairs, key=lambda pair: (pair[1], pair[0]))",
  );
  const text = lines("Here it is:", "", `${F}python`, body, F);
  message(text);
  message(lines("As promised, again:", "", `${F}python`, body, F));
  capture({ finalText: text });

  const artifacts = snippetArtifacts();
  assert.equal(artifacts.length, 1, "one artifact for one distinct block");
  const [artifact] = artifacts;
  assert.equal(artifact.kind, "snippet");
  assert.equal(artifact.path, "");
  assert.equal(artifact.size, Buffer.byteLength(body));
  assert.equal(artifact.content, undefined, "list rows carry no content");
  assert.equal(artifact.metadata.language, "python");
  assert.equal(artifact.metadata.languageRaw, "python");
  assert.equal(artifact.metadata.languageSource, "fence");
  assert.equal(artifact.metadata.detectedBy, "fenced-code-block");
  assert.equal(artifact.metadata.digest, snippetDigest("python", body));
  assert.equal(artifact.metadata.lines, 2);
  assert.equal(artifact.metadata.bytes, Buffer.byteLength(body));
  assert.equal(artifact.metadata.origin.messageIndex, 0);
  assert.equal(artifact.metadata.truncated, false);
  assert.match(artifact.title, /^Snippet 1: python \(2 lines\)$/);
  assert.equal(recorder.artifact(artifact.id).content, body);

  capture({ finalText: text });
  assert.equal(snippetArtifacts().length, 1, "capture is idempotent");
});

test("an unlabelled snippet keeps its artifact and reports no language", (t) => {
  const { message, capture, snippetArtifacts } = setup(t);
  message(
    lines(
      "Something like this:",
      "",
      F,
      "walk(root, (node) => visit(node));",
      "flush(root);",
      F,
    ),
  );
  capture();
  const [artifact] = snippetArtifacts();
  assert.equal(artifact.metadata.language, null);
  assert.equal(artifact.metadata.languageSource, "none");
  assert.match(artifact.title, /^Snippet 1: code \(2 lines\)$/);
});

test("over the cap the extra blocks are counted in a status event", (t) => {
  const { recorder, run, message, capture, snippetArtifacts } = setup(t);
  const blocks = Array.from({ length: 25 }, (_, i) =>
    lines(
      `${F}javascript`,
      `export function helper${i}(value) {`,
      `  return value * ${i + 2};`,
      "}",
      F,
    ),
  ).join("\n\n");
  message(blocks);
  capture();
  assert.equal(snippetArtifacts().length, SNIPPET_LIMIT);
  const notice = recorder
    .events(run.id, { limit: 500 })
    .find((event) => /not materialized as snippets/.test(event.message));
  assert.ok(notice, "the run says what it skipped");
  assert.equal(notice.kind, "status");
  assert.equal(notice.provenance, "system");
  assert.match(notice.message, /^5 code blocks were seen/);
  assert.match(notice.message, /5 over-limit/);
  assert.equal(notice.data.skipped.length, 5);
  assert.equal(notice.data.kept, SNIPPET_LIMIT);
});

test("a snippet is searchable and satisfies an artifact:snippet contract", (t) => {
  const { services, recorder, run, message, capture } = setup(t);
  message(
    lines(
      "Try this:",
      "",
      `${F}python`,
      "def sort_pairs(pairs):",
      "    return sorted(pairs, key=lambda pair: (pair[1], pair[0]))",
      F,
    ),
  );
  capture();
  const search = createSearch(services);
  const hits = search.search({ query: "sort_pairs", kinds: ["artifacts"] });
  assert.equal(hits.empty, false);
  const hit = hits.results.find((row) => /^Snippet 1:/.test(row.title));
  assert.ok(hit, "the snippet artifact is searchable");
  assert.match(hit.basis, /^snippet artifact · \d+ bytes$/);
  assert.equal(hit.runId, run.id);

  const verdict = validateResult(
    { completionCriteria: ["artifact:snippet"] },
    { artifacts: recorder.artifacts(run.id, { withContent: true }) },
  );
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failures, []);
});
