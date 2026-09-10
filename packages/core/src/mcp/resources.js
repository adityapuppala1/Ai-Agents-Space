/**
 * MCP resources exposed by Agent Space.
 *
 * Resources are contextual documents an MCP client can read: the workspace
 * list, one workspace snapshot, one run, the decision inbox, and the two
 * documents that describe this project honestly (the architecture brief and
 * the roadmap status). Live records come from the HTTP API; the two documents
 * are read from the repository's own docs/ directory.
 *
 * Honesty rules that shape this module:
 *  - A resource returns exactly what the API or the file holds. Nothing is
 *    summarized into a claim the source does not make.
 *  - Documents are read from disk read-only, and only the two files named
 *    here; there is no path parameter, so a resource read can never be
 *    steered at another file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const RESOURCE_SCHEME = "agent-space";

/** Repository docs/ directory (packages/core/src/mcp → repo root). */
export const DEFAULT_DOCS_DIR = fileURLToPath(
  new URL("../../../../docs/", import.meta.url),
);

/** The two documents served as resources, by uri suffix. */
export const DOCUMENTS = Object.freeze({
  architecture: {
    file: "ARCHITECTURE.md",
    name: "Agent Space architecture brief",
    description:
      "The binding contract: rules, schema, verified provider facts, module map, event pipeline, UI vocabulary.",
  },
  "roadmap-status": {
    file: "ROADMAP_STATUS.md",
    name: "Roadmap status",
    description:
      "Every roadmap item with Done / Partial / Deferred and the evidence for it.",
  },
});

/** Static resources, always listed. */
export const RESOURCES = [
  {
    uri: "agent-space://workspaces",
    name: "Workspaces",
    description: "Every workspace with folder root, theme and attention count.",
    mimeType: "application/json",
  },
  {
    uri: "agent-space://inbox",
    name: "Decision inbox",
    description:
      "Pending approvals, failed/stale/disconnected runs, reviews and provider questions.",
    mimeType: "application/json",
  },
  {
    uri: "agent-space://docs/architecture",
    name: DOCUMENTS.architecture.name,
    description: DOCUMENTS.architecture.description,
    mimeType: "text/markdown",
  },
  {
    uri: "agent-space://docs/roadmap-status",
    name: DOCUMENTS["roadmap-status"].name,
    description: DOCUMENTS["roadmap-status"].description,
    mimeType: "text/markdown",
  },
];

/** Parameterized resources, advertised through resources/templates/list. */
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "agent-space://workspace/{id}/snapshot",
    name: "Workspace snapshot",
    description:
      "One workspace with its agents, tasks, runs and recent events, exactly as the UI receives it.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "agent-space://run/{id}",
    name: "Run",
    description:
      "One run with its events, artifacts, approvals and context manifest.",
    mimeType: "application/json",
  },
];

function textContent(uri, mimeType, text) {
  return { uri, mimeType, text };
}

function jsonContent(uri, value) {
  return textContent(uri, "application/json", JSON.stringify(value, null, 2));
}

/**
 * Reads one resource. `client` is the HTTP bridge to a running Agent Space;
 * `docsDir` is the repository docs directory (overridable in tests).
 * Returns { uri, mimeType, text } or throws a plain-language Error.
 */
export async function readResource(
  uri,
  { client, docsDir = DEFAULT_DOCS_DIR },
) {
  const raw = String(uri ?? "");
  if (!raw.startsWith(`${RESOURCE_SCHEME}://`))
    throw new Error(
      `Unknown resource “${raw}”. Every Agent Space resource starts with ${RESOURCE_SCHEME}://`,
    );
  const rest = raw.slice(`${RESOURCE_SCHEME}://`.length);

  if (rest === "workspaces")
    return jsonContent(raw, await client.get("/api/workspaces"));
  if (rest === "inbox") return jsonContent(raw, await client.get("/api/inbox"));

  const doc = rest.match(/^docs\/([a-z-]+)$/);
  if (doc) {
    const entry = DOCUMENTS[doc[1]];
    if (!entry)
      throw new Error(
        `Unknown document “${doc[1]}”. Available: ${Object.keys(DOCUMENTS).join(", ")}.`,
      );
    let text;
    try {
      text = readFileSync(join(docsDir, entry.file), "utf8");
    } catch (error) {
      throw new Error(
        `${entry.file} could not be read from ${docsDir}: ${error.message}`,
      );
    }
    return textContent(raw, "text/markdown", text);
  }

  const snapshot = rest.match(/^workspace\/([^/]+)\/snapshot$/);
  if (snapshot)
    return jsonContent(
      raw,
      await client.get(
        `/api/workspace?workspace=${encodeURIComponent(decodeURIComponent(snapshot[1]))}`,
      ),
    );

  const run = rest.match(/^run\/([^/]+)$/);
  if (run)
    return jsonContent(
      raw,
      await client.get(
        `/api/runs/${encodeURIComponent(decodeURIComponent(run[1]))}`,
      ),
    );

  throw new Error(
    `Unknown resource “${raw}”. Known resources: ${RESOURCES.map((r) => r.uri).join(", ")}, plus the templates ${RESOURCE_TEMPLATES.map((r) => r.uriTemplate).join(", ")}.`,
  );
}
