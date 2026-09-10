import { InputError } from "../../../core/src/TaskStore.js";
import { rank } from "../../../core/src/context/relevance.js";
import { MemoryService } from "../../../core/src/context/memory.js";

/**
 * Context, memory and knowledge routes.
 *
 *   POST   /api/workspaces/:id/context/preview {taskId?, agentId?, runId?, files[],
 *                                               documents[], instructions[],
 *                                               maxFileBytes?, memory?, knowledge?,
 *                                               relevance?}
 *   POST   /api/workspaces/:id/context/stale   {manifest}
 *   POST   /api/workspaces/:id/context/rank    {candidates[], taskId?, agentId?,
 *                                               include[], exclude[], maxItems,
 *                                               maxBytes, diffFiles[]}
 *   GET    /api/workspaces/:id/memory          ?kind=
 *   POST   /api/workspaces/:id/memory          {key, value, kind?, source?, expiresAt?}
 *   DELETE /api/workspaces/:id/memory          ?key=  (omit key to forget the scope)
 *   GET    /api/memory/user
 *   POST   /api/memory/user                    {key, value, kind?, source?}
 *   DELETE /api/memory/user                    ?key=
 *   GET    /api/runs/:id/memory                run notes for one run
 *   POST   /api/runs/:id/memory                {key, value}
 *   DELETE /api/runs/:id/memory                ?key=  (omit key to drop every note)
 *
 *   GET    /api/workspaces/:id/knowledge
 *   POST   /api/workspaces/:id/knowledge                    {name, description?, access?}
 *   GET    /api/workspaces/:id/knowledge/:cid
 *   PATCH  /api/workspaces/:id/knowledge/:cid               {name?, description?, access?}
 *   DELETE /api/workspaces/:id/knowledge/:cid
 *   POST   /api/workspaces/:id/knowledge/:cid/items         {title, source?, sourceUrl?, content?}
 *   PATCH  /api/workspaces/:id/knowledge/:cid/items/:itemId
 *   DELETE /api/workspaces/:id/knowledge/:cid/items/:itemId ?purge=1 for the hard delete
 *   POST   /api/workspaces/:id/knowledge/:cid/refresh
 *
 *   POST   /api/workspaces/:id/context/adopt              {path, contentHash?, reason?}
 *   GET    /api/workspaces/:id/context/adopted            ?includeRevoked=1
 *   DELETE /api/workspaces/:id/context/adopted/:adoptionId
 *
 *   GET    /api/runs/:id/transfers      which provider/host received which inputs
 *   POST   /api/runs/:id/context/gate   {manifest?}  staleness gate before applying
 *
 * Register BEFORE routes/workspaces.js. Requires services.context; the memory
 * and knowledge routes attach a MemoryService on first use when the container
 * did not compose one.
 */
export default async function contextRoutes(ctx) {
  const { method, path, query, send, body, services, actor } = ctx;

  const memoryRoute = path.match(
    /^\/api\/(workspaces\/([^/]+)\/memory|memory\/user|runs\/([^/]+)\/memory)$/,
  );
  if (memoryRoute) {
    const memory = requireMemory(services);
    let scope = "user";
    let scopeId = null;
    if (memoryRoute[2]) {
      scope = "workspace";
      scopeId = decodeURIComponent(memoryRoute[2]);
      services.hub.get(scopeId);
    } else if (memoryRoute[3]) {
      scope = "run";
      scopeId = decodeURIComponent(memoryRoute[3]);
    }
    if (method === "GET") {
      send(200, {
        scope,
        scopeId,
        entries: memory.list({
          scope,
          scopeId,
          kind: query.get("kind") || null,
        }),
      });
      return true;
    }
    if (method === "POST") {
      const input = (await body(65536)) ?? {};
      send(
        201,
        memory.set({
          scope,
          scopeId,
          key: input.key,
          value: input.value ?? "",
          kind: input.kind ?? "note",
          source: input.source ?? actor ?? "user",
          expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : null,
        }),
      );
      return true;
    }
    if (method === "DELETE") {
      const key = query.get("key");
      const removed = key
        ? memory.forget(scope, scopeId, key)
        : memory.forgetAll(scope, scopeId);
      send(200, {
        scope,
        scopeId,
        key: key ?? null,
        removed,
        hardDelete: true,
      });
      return true;
    }
    return false;
  }

  const knowledge = path.match(
    /^\/api\/workspaces\/([^/]+)\/knowledge(\/.*)?$/,
  );
  if (knowledge) {
    const memory = requireMemory(services);
    const workspaceId = decodeURIComponent(knowledge[1]);
    services.hub.get(workspaceId);
    const rest = knowledge[2] ?? "";
    if (rest === "" && method === "GET") {
      send(200, memory.listCollections(workspaceId));
      return true;
    }
    if (rest === "" && method === "POST") {
      const input = (await body(65536)) ?? {};
      send(
        201,
        memory.createCollection({
          workspaceId,
          name: input.name,
          description: input.description ?? "",
          access: input.access ?? "workspace",
        }),
      );
      return true;
    }
    const collection = rest.match(/^\/([^/]+)$/);
    if (collection) {
      const cid = decodeURIComponent(collection[1]);
      memory.getCollection(cid, { workspaceId }); // scope check
      if (method === "GET") {
        send(200, memory.getCollection(cid, { workspaceId }));
        return true;
      }
      if (method === "PATCH") {
        const input = (await body(65536)) ?? {};
        send(200, memory.updateCollection(cid, input));
        return true;
      }
      if (method === "DELETE") {
        send(200, memory.deleteCollection(cid));
        return true;
      }
      return false;
    }
    const items = rest.match(/^\/([^/]+)\/items$/);
    if (items && method === "POST") {
      const cid = decodeURIComponent(items[1]);
      memory.getCollection(cid, { workspaceId });
      const input = (await body(1048576)) ?? {};
      send(201, memory.addItem(cid, input));
      return true;
    }
    const item = rest.match(/^\/([^/]+)\/items\/([^/]+)$/);
    if (item) {
      const cid = decodeURIComponent(item[1]);
      const itemId = decodeURIComponent(item[2]);
      memory.getCollection(cid, { workspaceId });
      const existing = memory.getItem(itemId);
      if (existing.collectionId !== cid)
        throw new InputError("Knowledge item not found", 404);
      if (method === "PATCH") {
        const input = (await body(1048576)) ?? {};
        send(200, memory.updateItem(itemId, input));
        return true;
      }
      if (method === "DELETE") {
        send(
          200,
          query.get("purge") === "1"
            ? memory.purgeItem(itemId)
            : memory.deleteItem(itemId),
        );
        return true;
      }
      return false;
    }
    const refresh = rest.match(/^\/([^/]+)\/refresh$/);
    if (refresh && method === "POST") {
      const cid = decodeURIComponent(refresh[1]);
      memory.getCollection(cid, { workspaceId });
      send(200, memory.refreshCheck(cid));
      return true;
    }
    return false;
  }

  // Untrusted-content adoption: a person deliberately offers content that
  // the scanner flagged. Bound to a content hash; audited; revocable.
  const adoptRoute = path.match(
    /^\/api\/workspaces\/([^/]+)\/context\/(adopt|adopted)(?:\/([^/]+))?$/,
  );
  if (adoptRoute) {
    const context = requireContext(services);
    const workspaceId = decodeURIComponent(adoptRoute[1]);
    services.hub.get(workspaceId);
    if (typeof context.adopt !== "function")
      throw new InputError("Content adoption is not available", 503);
    if (adoptRoute[2] === "adopt" && !adoptRoute[3] && method === "POST") {
      const input = (await body(65536)) ?? {};
      send(
        201,
        context.adopt({
          workspaceId,
          path: input.path,
          contentHash: input.contentHash ?? null,
          reason: input.reason ?? "",
          actor: actor ?? "user",
        }),
      );
      return true;
    }
    if (adoptRoute[2] === "adopted" && !adoptRoute[3] && method === "GET") {
      send(200, {
        workspaceId,
        adopted: context.adopted(workspaceId, {
          includeRevoked: query.get("includeRevoked") === "1",
        }),
      });
      return true;
    }
    if (adoptRoute[2] === "adopted" && adoptRoute[3] && method === "DELETE") {
      send(
        200,
        context.revoke(decodeURIComponent(adoptRoute[3]), {
          workspaceId,
          actor: actor ?? "user",
        }),
      );
      return true;
    }
    return false;
  }

  const runScoped = path.match(
    /^\/api\/runs\/([^/]+)\/(transfers|context\/gate)$/,
  );
  if (runScoped) {
    const context = requireContext(services);
    const runId = decodeURIComponent(runScoped[1]);
    if (runScoped[2] === "transfers" && method === "GET") {
      send(200, { runId, transfers: context.transfersForRun(runId) });
      return true;
    }
    if (runScoped[2] === "context/gate" && method === "POST") {
      let input = {};
      try {
        input = (await body(1048576)) ?? {};
      } catch (error) {
        if (!(error instanceof InputError) || error.status !== 415) throw error;
      }
      send(200, context.gateApply({ runId, manifest: input.manifest ?? null }));
      return true;
    }
    return false;
  }

  const match = path.match(
    /^\/api\/workspaces\/([^/]+)\/context\/(preview|stale|rank)$/,
  );
  if (!match || method !== "POST") return false;
  const context = requireContext(services);
  const workspaceId = decodeURIComponent(match[1]);
  const input = (await body(262144)) ?? {};
  if (match[2] === "preview") {
    send(
      200,
      context.build({
        workspaceId,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        files: input.files ?? [],
        documents: input.documents ?? [],
        instructions: input.instructions ?? [],
        memory: input.memory !== false,
        knowledge: input.knowledge ?? null,
        relevance: input.relevance ?? null,
        maxFileBytes:
          Number.isFinite(input.maxFileBytes) && input.maxFileBytes > 0
            ? input.maxFileBytes
            : undefined,
      }),
    );
    return true;
  }
  if (match[2] === "rank") {
    const runtime = services.hub.get(workspaceId);
    const task = input.taskId
      ? services.db
          .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
          .get(input.taskId, workspaceId)
      : null;
    if (input.taskId && !task) throw new InputError("Task not found", 404);
    const agent = input.agentId ? runtime.profiles.get(input.agentId) : null;
    const memory = services.memory ?? null;
    send(
      200,
      rank({
        candidates: input.candidates ?? [],
        task: task
          ? {
              title: task.title,
              deliverable: task.deliverable,
              description: task.description,
              target: parseJson(task.target, {}),
            }
          : null,
        agent: agent ? { role: agent.role, skills: agent.skills ?? [] } : null,
        memories: memory
          ? memory.list({ scope: "workspace", scopeId: workspaceId })
          : [],
        diffFiles:
          input.diffFiles ??
          (input.runId ? context.diffFilesForRun(input.runId) : []),
        include: input.include ?? [],
        exclude: input.exclude ?? [],
        maxItems: Number.isFinite(input.maxItems) ? input.maxItems : 40,
        maxBytes: Number.isFinite(input.maxBytes) ? input.maxBytes : 200_000,
      }),
    );
    return true;
  }
  services.hub.get(workspaceId);
  send(200, context.detectStale(input.manifest, { workspaceId }));
  return true;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function requireContext(services) {
  if (!services.context)
    throw new InputError("Context manifests are not available", 503);
  return services.context;
}

function requireMemory(services) {
  services.memory ??= new MemoryService(services);
  return services.memory;
}
