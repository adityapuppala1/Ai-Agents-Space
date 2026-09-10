import { InputError } from "../../../core/src/TaskStore.js";
import { parseRange } from "../../../core/src/analytics/Analytics.js";
import {
  Evaluation,
  DIMENSIONS,
  NEVER_ASSERTED,
} from "../../../core/src/analytics/evaluation.js";

/**
 * Evaluation, regression benchmarks, variant comparison, and shadow
 * experiments. MUST be registered BEFORE routes/workspaces.js in
 * routes/index.js, which owns the catch-all /api prefix.
 *
 *   GET  /api/evaluations?run=&workspace=&dimension=
 *   POST /api/evaluations                { runId, dimension, verdict, score?,
 *                                          grader:{kind,identity}, rubric?, evidence? }
 *   GET  /api/evaluations/dimensions      the vocabulary and what we refuse to assert
 *   GET  /api/evaluations/summary?run=
 *   GET  /api/evaluations/by-dimension?workspace=&since=
 *   POST /api/runs/:id/evaluate/objective  compute completion/availability/acceptance
 *   GET  /api/benchmarks?workspace=
 *   POST /api/benchmarks                  { name, workspaceId?, cases:[{key,inputs,expectations}] }
 *   GET  /api/benchmarks/:id
 *   POST /api/benchmarks/:id/cases/:key/runs { variant, runId }
 *   GET  /api/benchmarks/:id/compare?variants=a,b
 *   POST /api/benchmarks/:id/shadow       { variant, budgetTokens, isolation|outputDir }
 *   POST /api/benchmarks/shadow/:id/attach { runId }
 *
 * Correctness and security are never asserted by Agent Space: POSTing them
 * with an objective grader is refused with a 400 that says why.
 */
export default async function evaluationRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;
  const owns =
    path.startsWith("/api/evaluations") ||
    path.startsWith("/api/benchmarks") ||
    /^\/api\/runs\/[^/]+\/evaluate\//.test(path);
  if (!owns) return false;
  const evaluation = (services.evaluation ??= new Evaluation(services));

  if (method === "GET" && path === "/api/evaluations/dimensions") {
    send(200, {
      dimensions: DIMENSIONS,
      neverAssertedByUs: NEVER_ASSERTED,
      graderKinds: ["objective", "human", "model"],
      note: "Correctness and security stay unknown until a human or a model grader supplies a verdict; a model verdict is stored with its identity and rubric and displayed as a claim.",
    });
    return true;
  }

  if (method === "GET" && path === "/api/evaluations/summary") {
    const runId = query.get("run");
    if (!runId) throw new InputError("run is required");
    send(200, evaluation.summary(runId));
    return true;
  }

  if (method === "GET" && path === "/api/evaluations/by-dimension") {
    send(
      200,
      evaluation.byDimension({
        workspaceId: query.get("workspace") || null,
        since: parseRange(query.get("since")),
      }),
    );
    return true;
  }

  if (path === "/api/evaluations") {
    if (method === "GET") {
      send(200, {
        evaluations: evaluation.list({
          runId: query.get("run") || null,
          workspaceId: query.get("workspace") || null,
          dimension: query.get("dimension") || null,
          limit: Number(query.get("limit")) || 200,
        }),
      });
      return true;
    }
    if (method === "POST") {
      const input = (await body()) ?? {};
      const grader = input.grader ?? {};
      send(
        201,
        evaluation.record({
          ...input,
          grader: {
            ...grader,
            identity:
              grader.identity ?? (grader.kind === "human" ? actor : null),
          },
        }),
      );
      return true;
    }
  }

  const objective = /^\/api\/runs\/([^/]+)\/evaluate\/objective$/.exec(path);
  if (objective && method === "POST") {
    send(200, {
      recorded: evaluation.computeObjective(decodeURIComponent(objective[1])),
      note: "Only completion, availability, and recorded human acceptance are computed here.",
    });
    return true;
  }

  if (path === "/api/benchmarks") {
    if (method === "GET") {
      send(200, {
        benchmarks: evaluation.benchmarks({
          workspaceId: query.get("workspace") || null,
        }),
      });
      return true;
    }
    if (method === "POST") {
      send(201, evaluation.define((await body()) ?? {}));
      return true;
    }
  }

  const shadowAttach = /^\/api\/benchmarks\/shadow\/([^/]+)\/attach$/.exec(
    path,
  );
  if (shadowAttach && method === "POST") {
    const input = (await body()) ?? {};
    send(
      200,
      evaluation.attachShadowRun(
        decodeURIComponent(shadowAttach[1]),
        input.runId,
      ),
    );
    return true;
  }

  const caseRun = /^\/api\/benchmarks\/([^/]+)\/cases\/([^/]+)\/runs$/.exec(
    path,
  );
  if (caseRun && method === "POST") {
    const input = (await body()) ?? {};
    send(
      201,
      evaluation.runCase({
        benchmarkId: decodeURIComponent(caseRun[1]),
        caseKey: decodeURIComponent(caseRun[2]),
        variant: input.variant,
        runId: input.runId,
      }),
    );
    return true;
  }

  const compare = /^\/api\/benchmarks\/([^/]+)\/compare$/.exec(path);
  if (compare && method === "GET") {
    const variants = (query.get("variants") || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    send(
      200,
      evaluation.compare({
        benchmarkId: decodeURIComponent(compare[1]),
        variants: variants.length ? variants : null,
      }),
    );
    return true;
  }

  const shadow = /^\/api\/benchmarks\/([^/]+)\/shadow$/.exec(path);
  if (shadow && method === "POST") {
    const input = (await body()) ?? {};
    send(
      201,
      evaluation.startShadow({
        ...input,
        benchmarkId: decodeURIComponent(shadow[1]),
      }),
    );
    return true;
  }

  const benchmark = /^\/api\/benchmarks\/([^/]+)$/.exec(path);
  if (benchmark && method === "GET") {
    send(200, evaluation.benchmark(decodeURIComponent(benchmark[1])));
    return true;
  }

  return false;
}
