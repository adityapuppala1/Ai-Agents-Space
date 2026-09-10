/**
 * Evaluation, regression benchmarks, and shadow experiments.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - Agent Space asserts only what it can observe. `completion`,
 *     `acceptance`, and `availability` are objective: they read the run's
 *     recorded status, the human review decision, and the recorded
 *     disconnect/rate-limit evidence.
 *   - `correctness` and `security` are NEVER asserted by us. They stay
 *     `unknown` until a human reviewer or a model-grader run supplies a
 *     verdict. A model verdict is stored with the grader identity and the
 *     rubric and is reported as a claim (`claim: true`), never as truth. We
 *     never call a model ourselves: verdicts arrive from a run.
 *   - Benchmark cases freeze their inputs as content hashes. The contents are
 *     never copied into the database.
 *   - A shadow experiment must carry its own explicit token budget and must
 *     be isolated (a git worktree or a scoped output folder) so it can never
 *     apply a duplicate side effect to the production target.
 */

import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";

export const DIMENSIONS = Object.freeze([
  "completion",
  "correctness",
  "security",
  "acceptance",
  "availability",
]);

/** Dimensions Agent Space may compute from its own records. */
export const OBJECTIVE_DIMENSIONS = Object.freeze([
  "completion",
  "acceptance",
  "availability",
]);

/** Dimensions we refuse to assert ourselves, whatever the caller asks. */
export const NEVER_ASSERTED = Object.freeze(["correctness", "security"]);

export const VERDICTS = Object.freeze(["pass", "fail", "unknown"]);
export const GRADER_KINDS = Object.freeze(["objective", "human", "model"]);

const RATE_LIMIT_PATTERN = /rate limit|rate_limit|429|usage limit|quota/i;

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function hash(text) {
  return `sha256:${createHash("sha256").update(String(text)).digest("hex")}`;
}

/** Strips content out of a case input and replaces it with a hash. */
export function freezeInputs(inputs) {
  const source = inputs && typeof inputs === "object" ? inputs : {};
  const files = Array.isArray(source.files)
    ? source.files.map((file) => ({
        path: String(file?.path ?? ""),
        hash:
          file?.hash ??
          (typeof file?.content === "string" ? hash(file.content) : null),
        bytes:
          typeof file?.content === "string"
            ? Buffer.byteLength(file.content)
            : (file?.bytes ?? null),
        revision: file?.revision ?? null,
      }))
    : [];
  const scalars = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "files") continue;
    // Free text (a prompt, a document body) is frozen by hash, never stored.
    scalars[key] =
      typeof value === "string"
        ? { hash: hash(value), bytes: Buffer.byteLength(value) }
        : { hash: hash(JSON.stringify(value ?? null)) };
  }
  const frozen = { files, fields: scalars };
  frozen.hash = hash(JSON.stringify(frozen));
  frozen.note =
    "inputs are frozen as content hashes; the contents themselves are never copied into Agent Space";
  return frozen;
}

export class Evaluation {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  // -------------------------------------------------------------- records

  #row(row) {
    const grader = parseJson(row.grader, {});
    return {
      id: row.id,
      runId: row.run_id,
      dimension: row.dimension,
      verdict: row.verdict,
      score: row.score ?? null,
      grader,
      rubric: row.rubric ?? null,
      evidence: parseJson(row.evidence, {}),
      createdAt: row.created_at,
      // A model verdict is a claim by that model, not a fact established here.
      claim: grader.kind === "model",
    };
  }

  /**
   * Records one evaluation. Correctness and security refuse an objective
   * grader: Agent Space does not decide whether code is correct or safe.
   */
  record({
    runId,
    dimension,
    verdict = "unknown",
    score = null,
    grader = {},
    rubric = null,
    evidence = {},
  } = {}) {
    if (!runId || typeof runId !== "string")
      throw new InputError("runId is required");
    if (!this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId))
      throw new InputError("Run not found", 404);
    if (!DIMENSIONS.includes(dimension))
      throw new InputError(`dimension must be one of ${DIMENSIONS.join(", ")}`);
    if (!VERDICTS.includes(verdict))
      throw new InputError(`verdict must be one of ${VERDICTS.join(", ")}`);
    const kind = grader?.kind;
    if (!GRADER_KINDS.includes(kind))
      throw new InputError(
        `grader.kind must be one of ${GRADER_KINDS.join(", ")}`,
      );
    if (NEVER_ASSERTED.includes(dimension) && kind === "objective")
      throw new InputError(
        `Agent Space never asserts ${dimension} itself. Record a human reviewer or a model grader (with its identity and rubric) as the grader, or leave the verdict unknown.`,
      );
    if (kind === "model") {
      if (!grader.identity)
        throw new InputError(
          "A model grader must record its identity (the model or run that produced the verdict)",
        );
      if (!rubric)
        throw new InputError(
          "A model grader must record the rubric it graded against",
        );
    }
    if (kind === "human" && !grader.identity)
      throw new InputError("A human grader must record who decided");
    if (
      score !== null &&
      (typeof score !== "number" || !Number.isFinite(score))
    )
      throw new InputError("score must be a number or null");
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO evaluations (id, run_id, dimension, verdict, score, grader, rubric, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        dimension,
        verdict,
        score,
        JSON.stringify({
          kind,
          identity: grader.identity ?? null,
          version: grader.version ?? null,
        }),
        rubric ? String(rubric).slice(0, 4000) : null,
        JSON.stringify(evidence ?? {}),
        now,
      );
    this.services.audit?.record?.({
      actor: grader.identity ?? "system",
      action: "evaluation.recorded",
      target: runId,
      runId,
      details: { dimension, verdict, graderKind: kind },
    });
    return this.#row(
      this.db.prepare("SELECT * FROM evaluations WHERE id = ?").get(id),
    );
  }

  list({
    runId = null,
    workspaceId = null,
    dimension = null,
    limit = 200,
  } = {}) {
    const clauses = [];
    const params = [];
    if (runId) {
      clauses.push("e.run_id = ?");
      params.push(runId);
    }
    if (workspaceId) {
      clauses.push("r.workspace_id = ?");
      params.push(workspaceId);
    }
    if (dimension) {
      clauses.push("e.dimension = ?");
      params.push(dimension);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT e.* FROM evaluations e LEFT JOIN runs r ON r.id = e.run_id
         ${where} ORDER BY e.created_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(Number(limit) || 200, 1000))
      .map((row) => this.#row(row));
  }

  /**
   * Computes the objective dimensions for a run from its own records and
   * stores them. Correctness and security are deliberately not touched.
   */
  computeObjective(runId) {
    const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!run) throw new InputError("Run not found", 404);
    const identity = "agent-space";
    const written = [];

    const completion =
      run.status === "completed"
        ? "pass"
        : ["failed", "cancelled"].includes(run.status)
          ? "fail"
          : "unknown";
    written.push(
      this.record({
        runId,
        dimension: "completion",
        verdict: completion,
        grader: { kind: "objective", identity },
        rubric: "the run reached status completed",
        evidence: { status: run.status, endedAt: run.ended_at ?? null },
      }),
    );

    const events = this.db
      .prepare(
        "SELECT kind, message, data FROM events WHERE run_id = ? ORDER BY sequence ASC",
      )
      .all(runId);
    const rateLimited = events.some(
      (event) =>
        RATE_LIMIT_PATTERN.test(event.message ?? "") ||
        RATE_LIMIT_PATTERN.test(parseJson(event.data, {}).class ?? ""),
    );
    const sawProvider = events.length > 0;
    const availability =
      run.status === "disconnected" || rateLimited
        ? "fail"
        : sawProvider
          ? "pass"
          : "unknown";
    written.push(
      this.record({
        runId,
        dimension: "availability",
        verdict: availability,
        grader: { kind: "objective", identity },
        rubric: "the provider stayed connected and was not rate limited",
        evidence: {
          status: run.status,
          rateLimited,
          recordedEvents: events.length,
        },
      }),
    );

    const task = run.task_id
      ? this.db
          .prepare("SELECT review FROM tasks WHERE id = ?")
          .get(run.task_id)
      : null;
    const review = parseJson(task?.review, {});
    if (
      review.runId === runId &&
      ["accepted", "rejected"].includes(review.status)
    )
      written.push(
        this.record({
          runId,
          dimension: "acceptance",
          verdict: review.status === "accepted" ? "pass" : "fail",
          grader: {
            kind: "human",
            identity: review.decidedBy ?? "local-user",
          },
          rubric: review.note ? "reviewer note recorded" : null,
          evidence: { reviewStatus: review.status, note: review.note ?? null },
        }),
      );
    return written;
  }

  /** The latest verdict per dimension for one run. */
  summary(runId) {
    const run = this.db
      .prepare("SELECT id, status FROM runs WHERE id = ?")
      .get(runId);
    if (!run) throw new InputError("Run not found", 404);
    const rows = this.list({ runId, limit: 1000 });
    const dimensions = {};
    for (const dimension of DIMENSIONS) {
      const latest = rows.find((row) => row.dimension === dimension);
      dimensions[dimension] = latest ?? {
        dimension,
        verdict: "unknown",
        grader: null,
        rubric: null,
        evidence: {},
        claim: false,
        reason: NEVER_ASSERTED.includes(dimension)
          ? "Agent Space never asserts this; no human or model verdict has been recorded"
          : "not evaluated yet",
      };
    }
    return {
      runId,
      dimensions,
      neverAssertedByUs: [...NEVER_ASSERTED],
      note: "Dimensions are separate on purpose: a completed run is not a correct run, and a model verdict is a claim by that model.",
    };
  }

  /** Verdict counts per dimension across a workspace. */
  byDimension({ workspaceId = null, since = 0 } = {}) {
    if (workspaceId && !this.services.hub.has(workspaceId))
      throw new InputError("Workspace not found", 404);
    const from = Number(since) || 0;
    const clauses = ["e.created_at >= ?"];
    const params = [from];
    if (workspaceId) {
      clauses.push("r.workspace_id = ?");
      params.push(workspaceId);
    }
    const rows = this.db
      .prepare(
        `SELECT e.dimension, e.verdict, e.grader FROM evaluations e
         LEFT JOIN runs r ON r.id = e.run_id
         WHERE ${clauses.join(" AND ")}`,
      )
      .all(...params);
    const out = {};
    for (const dimension of DIMENSIONS)
      out[dimension] = {
        dimension,
        pass: 0,
        fail: 0,
        unknown: 0,
        byGrader: { objective: 0, human: 0, model: 0 },
        assertedByUs: OBJECTIVE_DIMENSIONS.includes(dimension),
      };
    for (const row of rows) {
      const bucket = out[row.dimension];
      if (!bucket) continue;
      bucket[row.verdict] = (bucket[row.verdict] ?? 0) + 1;
      const kind = parseJson(row.grader, {}).kind;
      if (kind && bucket.byGrader[kind] !== undefined) bucket.byGrader[kind]++;
    }
    return {
      scope: { workspaceId, since: from },
      dimensions: Object.values(out),
      note: "Correctness and security counts come entirely from human or model graders.",
    };
  }

  // ------------------------------------------------------------ benchmarks

  #benchmarkRow(row) {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id ?? null,
      createdAt: row.created_at,
      definition: parseJson(row.definition, {}),
    };
  }

  #caseRow(row) {
    return {
      id: row.id,
      benchmarkId: row.benchmark_id,
      key: row.key,
      inputs: parseJson(row.inputs, {}),
      expectations: parseJson(row.expectations, {}),
      frozenAt: row.frozen_at,
    };
  }

  /**
   * Defines a regression dataset. Case inputs are frozen as content hashes;
   * expectations are output properties, not expected texts to diff against.
   */
  define({ name, workspaceId = null, cases = [], description = "" } = {}) {
    const title = String(name ?? "").trim();
    if (!title) throw new InputError("A benchmark needs a name");
    if (!Array.isArray(cases) || !cases.length)
      throw new InputError("A benchmark needs at least one case");
    if (workspaceId && !this.services.hub.has(workspaceId))
      throw new InputError("Workspace not found", 404);
    const now = this.now();
    const id = randomUUID();
    const keys = new Set();
    const frozen = cases.map((entry) => {
      const key = String(entry?.key ?? "").trim();
      if (!key) throw new InputError("Every benchmark case needs a key");
      if (keys.has(key))
        throw new InputError(`Duplicate benchmark case key: ${key}`);
      keys.add(key);
      return {
        id: randomUUID(),
        key,
        inputs: freezeInputs(entry.inputs),
        expectations:
          entry.expectations && typeof entry.expectations === "object"
            ? entry.expectations
            : {},
      };
    });
    this.db
      .prepare(
        "INSERT INTO benchmarks (id, name, workspace_id, created_at, definition) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        title,
        workspaceId,
        now,
        JSON.stringify({
          description: String(description ?? ""),
          caseCount: frozen.length,
          frozenAt: now,
        }),
      );
    const insert = this.db.prepare(
      `INSERT INTO benchmark_cases (id, benchmark_id, key, inputs, expectations, frozen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of frozen)
      insert.run(
        entry.id,
        id,
        entry.key,
        JSON.stringify(entry.inputs),
        JSON.stringify(entry.expectations),
        now,
      );
    return this.benchmark(id);
  }

  benchmarks({ workspaceId = null } = {}) {
    const rows = workspaceId
      ? this.db
          .prepare(
            "SELECT * FROM benchmarks WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY created_at DESC",
          )
          .all(workspaceId)
      : this.db
          .prepare("SELECT * FROM benchmarks ORDER BY created_at DESC")
          .all();
    return rows.map((row) => this.#benchmarkRow(row));
  }

  benchmark(id) {
    const row = this.db
      .prepare("SELECT * FROM benchmarks WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Benchmark not found", 404);
    const cases = this.db
      .prepare(
        "SELECT * FROM benchmark_cases WHERE benchmark_id = ? ORDER BY key",
      )
      .all(id)
      .map((caseRow) => this.#caseRow(caseRow));
    const links = this.db
      .prepare(
        "SELECT * FROM benchmark_runs WHERE benchmark_id = ? ORDER BY started_at",
      )
      .all(id)
      .map((linkRow) => this.#linkRow(linkRow));
    return { ...this.#benchmarkRow(row), cases, runs: links };
  }

  #linkRow(row) {
    return {
      id: row.id,
      benchmarkId: row.benchmark_id,
      caseId: row.case_id ?? null,
      runId: row.run_id ?? null,
      variant: row.variant,
      startedAt: row.started_at ?? null,
      endedAt: row.ended_at ?? null,
      result: parseJson(row.result, {}),
      scores: parseJson(row.scores, {}),
    };
  }

  /** Links a real run to one benchmark case under a named variant. */
  runCase({ benchmarkId, caseKey, variant = "baseline", runId } = {}) {
    const benchmark = this.db
      .prepare("SELECT id FROM benchmarks WHERE id = ?")
      .get(benchmarkId);
    if (!benchmark) throw new InputError("Benchmark not found", 404);
    const row = this.db
      .prepare(
        "SELECT * FROM benchmark_cases WHERE benchmark_id = ? AND key = ?",
      )
      .get(benchmarkId, caseKey);
    if (!row) throw new InputError("Benchmark case not found", 404);
    const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!run) throw new InputError("Run not found", 404);
    const label = String(variant ?? "baseline").trim() || "baseline";
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (id, benchmark_id, case_id, run_id, variant, started_at, ended_at, result, scores)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        benchmarkId,
        row.id,
        runId,
        label,
        run.started_at,
        run.ended_at ?? null,
        JSON.stringify({ status: run.status, provider: run.provider }),
        JSON.stringify({}),
      );
    return this.#linkRow(
      this.db.prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id),
    );
  }

  /** The objective outcome of one linked run: completion + acceptance. */
  #outcome(runId) {
    if (!runId) return { verdict: "unknown", reason: "no run linked" };
    const run = this.db
      .prepare("SELECT id, status FROM runs WHERE id = ?")
      .get(runId);
    if (!run) return { verdict: "unknown", reason: "run not found" };
    const rows = this.list({ runId, limit: 1000 });
    const completion =
      rows.find((row) => row.dimension === "completion")?.verdict ??
      (run.status === "completed"
        ? "pass"
        : ["failed", "cancelled"].includes(run.status)
          ? "fail"
          : "unknown");
    const acceptance = rows.find(
      (row) => row.dimension === "acceptance",
    )?.verdict;
    return {
      runId,
      status: run.status,
      completion,
      acceptance: acceptance ?? "unknown",
      verdict:
        acceptance === "fail" || completion === "fail"
          ? "fail"
          : completion === "pass"
            ? "pass"
            : "unknown",
      basis: "objective signals only: recorded run status and human acceptance",
    };
  }

  /**
   * Compares variants on the same frozen cases. Declares no winner when the
   * objective signals tie — a tie is a tie, not a preference.
   */
  compare({ benchmarkId, variants = null } = {}) {
    const benchmark = this.benchmark(benchmarkId);
    const links = this.db
      .prepare("SELECT * FROM benchmark_runs WHERE benchmark_id = ?")
      .all(benchmarkId)
      .map((row) => this.#linkRow(row))
      .filter((link) => link.caseId);
    const names = variants?.length
      ? variants.map(String)
      : [...new Set(links.map((link) => link.variant))].sort();
    const totals = new Map(
      names.map((name) => [
        name,
        { variant: name, pass: 0, fail: 0, unknown: 0 },
      ]),
    );
    const cases = [];
    for (const entry of benchmark.cases) {
      const perVariant = {};
      for (const name of names) {
        const link = links.find(
          (candidate) =>
            candidate.caseId === entry.id && candidate.variant === name,
        );
        const outcome = link
          ? this.#outcome(link.runId)
          : { verdict: "unknown", reason: "no run linked for this variant" };
        perVariant[name] = outcome;
        const bucket = totals.get(name);
        if (bucket)
          bucket[outcome.verdict] = (bucket[outcome.verdict] ?? 0) + 1;
      }
      cases.push({
        caseId: entry.id,
        key: entry.key,
        inputsHash: entry.inputs?.hash ?? null,
        expectations: entry.expectations,
        variants: perVariant,
      });
    }
    const scored = [...totals.values()];
    const best = Math.max(...scored.map((row) => row.pass), 0);
    const leaders = scored.filter((row) => row.pass === best);
    const winner =
      scored.length > 1 && leaders.length === 1 && best > 0
        ? leaders[0].variant
        : null;
    return {
      benchmarkId,
      name: benchmark.name,
      caseCount: benchmark.cases.length,
      variants: names,
      cases,
      totals: scored,
      winner,
      verdict: winner
        ? `${winner} passed more objective cases`
        : "no winner: the objective signals tie",
      basis:
        "objective signals only (run status and human acceptance). Speed and token usage are never used to rank quality.",
    };
  }

  // ---------------------------------------------------- shadow experiments

  /**
   * Starts a shadow experiment. Refuses without an explicit token budget or
   * without isolation, so a shadow run can never write to the production
   * target or spend an unbounded amount.
   */
  startShadow({
    benchmarkId,
    variant = "shadow",
    budgetTokens = null,
    isolation = null,
    outputDir = null,
    caseKey = null,
    note = "",
  } = {}) {
    const benchmark = this.db
      .prepare("SELECT * FROM benchmarks WHERE id = ?")
      .get(benchmarkId);
    if (!benchmark) throw new InputError("Benchmark not found", 404);
    if (
      typeof budgetTokens !== "number" ||
      !Number.isFinite(budgetTokens) ||
      budgetTokens <= 0
    )
      throw new InputError(
        "A shadow experiment needs its own explicit token budget (budgetTokens > 0); it never draws on the production budget",
      );
    const scoped = typeof outputDir === "string" && outputDir.trim().length > 0;
    if (isolation !== "worktree" && !scoped)
      throw new InputError(
        'A shadow experiment must be isolated: pass isolation "worktree" or a scoped outputDir, so it can never apply a duplicate side effect to the production target',
      );
    let caseId = null;
    if (caseKey) {
      const row = this.db
        .prepare(
          "SELECT id FROM benchmark_cases WHERE benchmark_id = ? AND key = ?",
        )
        .get(benchmarkId, caseKey);
      if (!row) throw new InputError("Benchmark case not found", 404);
      caseId = row.id;
    }
    const id = randomUUID();
    const now = this.now();
    const result = {
      shadow: true,
      status: "pending",
      budgetTokens,
      isolation: isolation === "worktree" ? "worktree" : "scoped-output-folder",
      outputDir: scoped ? outputDir.trim() : null,
      note: String(note ?? "").slice(0, 500),
      guard:
        "shadow runs write only inside their isolation target; production files are never touched by this experiment",
    };
    this.db
      .prepare(
        `INSERT INTO benchmark_runs (id, benchmark_id, case_id, run_id, variant, started_at, ended_at, result, scores)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '{}')`,
      )
      .run(
        id,
        benchmarkId,
        caseId,
        String(variant ?? "shadow").trim() || "shadow",
        now,
        JSON.stringify(result),
      );
    this.services.audit?.record?.({
      actor: "local-user",
      action: "benchmark.shadow.started",
      target: benchmarkId,
      workspaceId: benchmark.workspace_id ?? null,
      details: { id, budgetTokens, isolation: result.isolation },
    });
    return this.#linkRow(
      this.db.prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id),
    );
  }

  /** Attaches a real run to a pending shadow experiment. */
  attachShadowRun(shadowId, runId) {
    const row = this.db
      .prepare("SELECT * FROM benchmark_runs WHERE id = ?")
      .get(shadowId);
    if (!row) throw new InputError("Shadow experiment not found", 404);
    const run = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    if (!run) throw new InputError("Run not found", 404);
    const result = { ...parseJson(row.result, {}), status: "running" };
    this.db
      .prepare("UPDATE benchmark_runs SET run_id = ?, result = ? WHERE id = ?")
      .run(runId, JSON.stringify(result), shadowId);
    return this.#linkRow(
      this.db
        .prepare("SELECT * FROM benchmark_runs WHERE id = ?")
        .get(shadowId),
    );
  }
}

export function createEvaluation(services) {
  return new Evaluation(services);
}
