import { basename, dirname, sep } from "node:path";
import { normalizePath } from "./ContextManifest.js";

/**
 * Deterministic relevance ranking for context candidates (roadmap §12).
 *
 * No model is called and nothing is guessed: a candidate is scored from
 * facts we already hold — where it sits relative to the task target folder,
 * how many of its path tokens appear in the task title/deliverable, how
 * recently it was modified, and whether it appears in the run's git diff.
 *
 * Every returned item carries the score breakdown and a "why is this here"
 * sentence, so a person can see exactly why a file was offered to a provider.
 * Token counts are always labelled an estimate; we never claim a provider's
 * tokenizer.
 */

export const WEIGHTS = Object.freeze({
  proximity: 0.3,
  overlap: 0.3,
  diff: 0.25,
  recency: 0.15,
});

const RECENCY_BUCKETS = Object.freeze([
  { withinMs: 60 * 60 * 1000, score: 1, label: "modified in the last hour" },
  { withinMs: 24 * 60 * 60 * 1000, score: 0.6, label: "modified today" },
  {
    withinMs: 7 * 24 * 60 * 60 * 1000,
    score: 0.3,
    label: "modified this week",
  },
]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "add",
  "fix",
  "update",
  "make",
  "src",
  "js",
  "jsx",
  "ts",
  "tsx",
  "json",
  "md",
  "test",
  "tests",
]);

function tokenize(text) {
  return String(text ?? "")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((word) =>
      word
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/\s+/)
        .filter(Boolean),
    )
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function pathKey(p) {
  return process.platform === "win32" ? String(p).toLowerCase() : String(p);
}

function segments(p) {
  return normalizePath(p)
    .split(/[\\/]+/)
    .filter(Boolean);
}

/** 1 same folder, 0.7 inside the target folder, otherwise shared-prefix ratio. */
function proximity(path, folder) {
  if (!folder) return { score: 0, label: "no task target folder" };
  const file = segments(path);
  const target = segments(folder);
  if (!target.length) return { score: 0, label: "no task target folder" };
  const parent = segments(dirname(normalizePath(path)));
  if (pathKey(parent.join(sep)) === pathKey(target.join(sep)))
    return { score: 1, label: "in the task target folder" };
  let shared = 0;
  while (
    shared < target.length &&
    shared < file.length &&
    pathKey(file[shared]) === pathKey(target[shared])
  )
    shared += 1;
  if (shared === target.length)
    return { score: 0.7, label: "below the task target folder" };
  const ratio = target.length ? shared / target.length : 0;
  return {
    score: Math.round(ratio * 0.5 * 1000) / 1000,
    label: shared
      ? `shares ${shared} folder level${shared === 1 ? "" : "s"} with the target`
      : "outside the task target folder",
  };
}

function overlap(path, wanted) {
  if (!wanted.size) return { score: 0, matched: [], label: "no task words" };
  const tokens = new Set([
    ...tokenize(basename(String(path))),
    ...tokenize(
      String(path)
        .split(/[\\/]+/)
        .slice(-3)
        .join(" "),
    ),
  ]);
  const matched = [...tokens].filter((token) => wanted.has(token)).sort();
  const score = tokens.size
    ? Math.min(1, matched.length / Math.min(4, Math.max(1, wanted.size)))
    : 0;
  return {
    score: Math.round(score * 1000) / 1000,
    matched,
    label: matched.length
      ? `name matches ${matched.join(", ")}`
      : "name does not match the task words",
  };
}

function recency(mtimeMs, now) {
  if (!Number.isFinite(mtimeMs))
    return { score: 0, label: "modification time unknown" };
  const age = Math.max(0, now - mtimeMs);
  for (const bucket of RECENCY_BUCKETS)
    if (age <= bucket.withinMs)
      return { score: bucket.score, label: bucket.label };
  return { score: 0.1, label: "not modified this week" };
}

function candidatePath(candidate) {
  return typeof candidate === "string" ? candidate : (candidate?.path ?? "");
}

/**
 * rank({ candidates, task, agent, memories, diffFiles, include, exclude,
 *        maxItems, maxBytes, now })
 *
 * Returns `{ items, included, excluded, budgets, controls, estimatedTokens,
 * estimateLabel, estimateBasis, deterministic: true }`. `items` is ordered by
 * score (ties broken by path) and each entry carries `breakdown`, `reason`
 * and `why`.
 */
export function rank({
  candidates = [],
  task = null,
  agent = null,
  memories = [],
  diffFiles = [],
  include = [],
  exclude = [],
  maxItems = 40,
  maxBytes = 200_000,
  now = Date.now(),
} = {}) {
  const target = task?.target ?? {};
  const folder = target.folder ?? null;
  const wanted = new Set([
    ...tokenize(task?.title),
    ...tokenize(task?.deliverable),
    ...tokenize(task?.description),
    ...tokenize(agent?.role),
    ...(Array.isArray(agent?.skills) ? agent.skills.flatMap(tokenize) : []),
    ...(Array.isArray(memories)
      ? memories.flatMap((memory) =>
          tokenize(
            typeof memory === "string"
              ? memory
              : `${memory?.key ?? ""} ${memory?.value ?? ""}`,
          ),
        )
      : []),
  ]);
  const forced = new Set(include.map((p) => pathKey(normalizePath(p))));
  const banned = new Set(exclude.map((p) => pathKey(normalizePath(p))));
  const diff = new Set(diffFiles.map((p) => pathKey(normalizePath(p))));

  const scored = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const raw = candidatePath(candidate);
    if (!raw) continue;
    const path = normalizePath(raw);
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes =
      typeof candidate === "object" && Number.isFinite(candidate?.bytes)
        ? candidate.bytes
        : 0;
    const mtimeMs =
      typeof candidate === "object" && Number.isFinite(candidate?.mtimeMs)
        ? candidate.mtimeMs
        : null;
    const prox = proximity(path, folder);
    const over = overlap(path, wanted);
    const rec = recency(mtimeMs, now);
    const inDiff = diff.has(key);
    const breakdown = {
      proximity: { ...prox, weight: WEIGHTS.proximity },
      overlap: { ...over, weight: WEIGHTS.overlap },
      diff: {
        score: inDiff ? 1 : 0,
        weight: WEIGHTS.diff,
        label: inDiff ? "changed in this run's diff" : "not in this run's diff",
      },
      recency: { ...rec, weight: WEIGHTS.recency },
    };
    const score =
      Math.round(
        (prox.score * WEIGHTS.proximity +
          over.score * WEIGHTS.overlap +
          (inDiff ? WEIGHTS.diff : 0) +
          rec.score * WEIGHTS.recency) *
          10000,
      ) / 10000;
    scored.push({
      path,
      bytes,
      score,
      breakdown,
      forced: forced.has(key),
      banned: banned.has(key),
    });
  }

  scored.sort(
    (a, b) =>
      Number(b.forced) - Number(a.forced) ||
      b.score - a.score ||
      (pathKey(a.path) < pathKey(b.path) ? -1 : 1),
  );

  const items = [];
  let usedBytes = 0;
  let usedItems = 0;
  for (const entry of scored) {
    const parts = Object.entries(entry.breakdown)
      .filter(([, part]) => part.score > 0)
      .sort((a, b) => b[1].score * b[1].weight - a[1].score * a[1].weight)
      .map(([, part]) => part.label);
    const why = entry.forced
      ? "Included because you asked for it"
      : parts.length
        ? `Included because: ${parts.join("; ")}`
        : "Offered only because it was a candidate: nothing links it to this task";
    let included = true;
    let reason = entry.forced ? "included by request" : "ranked by relevance";
    if (entry.banned) {
      included = false;
      reason = "excluded by request";
    } else if (!entry.forced && usedItems >= maxItems) {
      included = false;
      reason = `budget: more than maxItems (${maxItems})`;
    } else if (!entry.forced && usedBytes + entry.bytes > maxBytes) {
      included = false;
      reason = `budget: would exceed maxBytes (${maxBytes})`;
    }
    if (included) {
      usedItems += 1;
      usedBytes += entry.bytes;
    }
    items.push({
      path: entry.path,
      bytes: entry.bytes,
      score: entry.score,
      included,
      reason,
      why: included ? why : `Left out: ${reason}. ${why}`,
      breakdown: entry.breakdown,
    });
  }

  return {
    items,
    included: items.filter((item) => item.included),
    excluded: items.filter((item) => !item.included),
    controls: {
      include: [...forced],
      exclude: [...banned],
      maxItems,
      maxBytes,
    },
    budgets: {
      maxItems,
      maxBytes,
      usedItems,
      usedBytes,
      itemsOverBudget: items.filter((item) => item.reason.startsWith("budget:"))
        .length,
    },
    estimatedTokens: Math.ceil(usedBytes / 4),
    estimateLabel: "estimate",
    estimateBasis: "bytes / 4; provider tokenizers differ",
    deterministic: true,
    weights: WEIGHTS,
    taskWords: [...wanted].sort(),
  };
}

/** services.js optional-module factory. */
export function createRelevance(services) {
  services.relevance ??= { rank, WEIGHTS };
  return services.relevance;
}

export default rank;
