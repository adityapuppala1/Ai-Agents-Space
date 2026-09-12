import { InputError } from "../../../core/src/TaskStore.js";
import {
  listTemplates,
  getTemplate,
} from "../../../core/src/workflows/templates/index.js";
import { createCheckpointService } from "../../../core/src/workflows/checkpoints.js";
import { createDryRun } from "../../../core/src/workflows/dryRun.js";
import { createSuggest } from "../../../core/src/workflows/suggest.js";

/**
 * Templates, workflows, workflow versions, task contracts, checkpoints,
 * dry runs, replay, team suggestions, validation, and the supervisor view.
 *
 * Validation: `GET /api/workspaces/:id/validate` checks the stored graph;
 * `POST /api/workspaces/:id/validate` with `{ taskId, dependsOn }` checks the
 * stored graph with that task's dependencies replaced, without writing.
 *
 * Register BEFORE routes/workspaces.js (uses /api/workspaces/:id/... paths).
 * Requires services.workflows (WorkflowService) whose `.graph` is a TaskGraph.
 * services.checkpoints / services.dryRun / services.suggest are created on
 * first use when the container did not wire them.
 */
export default async function workflowRoutes(ctx) {
  const { method, path, send, body, query, services, actor } = ctx;
  if (!path.startsWith("/api/")) return false;

  if (method === "GET" && path === "/api/templates") {
    send(200, listTemplates());
    return true;
  }
  const template = path.match(/^\/api\/templates\/([^/]+)$/);
  if (method === "GET" && template) {
    send(200, getTemplate(decodeURIComponent(template[1])));
    return true;
  }

  const workflows = services.workflows;
  const graph = workflows?.graph ?? services.graph;
  const checkpoints = () =>
    services.checkpoints ?? createCheckpointService(services);
  const dryRun = () => services.dryRun ?? createDryRun(services);
  const suggest = () => services.suggest ?? createSuggest(services);

  /* -------------------------------- runs -------------------------------- */

  const replay = path.match(/^\/api\/runs\/([^/]+)\/replay$/);
  if (method === "GET" && replay) {
    send(200, dryRun().replay({ runId: replay[1] }));
    return true;
  }
  const retryGuard = path.match(/^\/api\/runs\/([^/]+)\/orchestration$/);
  if (method === "GET" && retryGuard) {
    if (!graph) throw new InputError("Task graph is not available", 503);
    const run = services.db
      .prepare("SELECT task_id FROM runs WHERE id = ?")
      .get(retryGuard[1]);
    if (!run) throw new InputError("Run not found", 404);
    send(200, graph.ownershipFor(run.task_id));
    return true;
  }

  /* ----------------------------- checkpoints ---------------------------- */

  const checkpoint = path.match(/^\/api\/checkpoints\/([^/]+)(\/restore)?$/);
  if (checkpoint) {
    if (method === "GET" && !checkpoint[2]) {
      send(200, checkpoints().get(checkpoint[1]));
      return true;
    }
    if (method === "POST" && checkpoint[2]) {
      const input = (await body()) ?? {};
      send(
        200,
        checkpoints().restore(checkpoint[1], {
          dryRun: input.dryRun === true,
          actor,
        }),
      );
      return true;
    }
  }

  /* ------------------------------ workflows ----------------------------- */

  if (method === "POST" && path === "/api/workflows/import") {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    const input = (await body(262144)) ?? {};
    const document = input.document ?? input;
    send(
      201,
      workflows.importWorkflow(document, {
        workspaceId: input.workspaceId ?? null,
        actor,
      }),
    );
    return true;
  }

  const workflow = path.match(
    /^\/api\/workflows\/([^/]+)(?:\/(archive|export|versions|publish|rollback|adopt|validate-draft|validate|dry-run|checkpoints|definition|materialization))?$/,
  );
  if (workflow) {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    const id = workflow[1];
    const action = workflow[2] ?? null;
    if (method === "GET" && !action) {
      send(200, workflows.get(id));
      return true;
    }
    if (method === "POST" && action === "archive") {
      send(200, workflows.archive(id, { actor }));
      return true;
    }
    if (method === "GET" && action === "export") {
      const version = query?.get?.("version");
      send(
        200,
        workflows.exportWorkflow(id, {
          version: version ? Number(version) : null,
        }),
      );
      return true;
    }
    if (method === "GET" && action === "versions") {
      send(200, workflows.versions(id));
      return true;
    }
    if (method === "POST" && action === "publish") {
      const input = (await body()) ?? {};
      send(
        200,
        workflows.publish(
          id,
          input.version === undefined ? null : Number(input.version),
          { actor },
        ),
      );
      return true;
    }
    if (method === "POST" && action === "rollback") {
      const input = (await body()) ?? {};
      if (input.version === undefined)
        throw new InputError("version is required");
      send(
        200,
        workflows.rollback(id, Number(input.version), {
          actor,
          publish: input.publish !== false,
        }),
      );
      return true;
    }
    if (method === "POST" && action === "adopt") {
      const input = (await body()) ?? {};
      if (!input.owner) throw new InputError("owner is required");
      send(
        200,
        workflows.adopt({
          workflowId: id,
          owner: input.owner,
          externalId: input.externalId ?? null,
          actor,
        }),
      );
      return true;
    }
    if (method === "GET" && action === "validate") {
      send(200, workflows.validateGraph(id));
      return true;
    }
    if (method === "GET" && action === "definition") {
      send(200, workflows.definitionGraph(id));
      return true;
    }
    // 256 KB, the same cap as /api/workflows/import: a 13-step template
    // definition is about 10 KB.
    if (method === "PUT" && action === "definition") {
      const input = (await body(262144)) ?? {};
      send(
        200,
        workflows.saveDefinition(id, input.definition ?? input, {
          expectedHash: input.expectedHash ?? null,
          actor,
        }),
      );
      return true;
    }
    if (method === "POST" && action === "validate-draft") {
      const input = (await body(262144)) ?? {};
      send(200, workflows.validateDraft(id, input.definition ?? input));
      return true;
    }
    if (method === "GET" && action === "materialization") {
      send(200, workflows.materialization(id));
      return true;
    }
    if (method === "POST" && action === "dry-run") {
      const record = workflows.get(id);
      send(
        200,
        dryRun().plan({ workspaceId: record.workspaceId, workflowId: id }),
      );
      return true;
    }
    if (action === "checkpoints") {
      const record = workflows.get(id);
      if (method === "GET") {
        send(
          200,
          checkpoints().list({
            workspaceId: record.workspaceId,
            workflowId: id,
          }),
        );
        return true;
      }
      if (method === "POST") {
        const input = (await body()) ?? {};
        send(
          201,
          checkpoints().create({
            workspaceId: record.workspaceId,
            workflowId: id,
            kind: input.kind ?? "manual",
            label: input.label ?? null,
            actor,
          }),
        );
        return true;
      }
    }
  }

  /* --------------------------- workspace scoped -------------------------- */

  const scoped = path.match(
    /^\/api\/workspaces\/([^/]+)\/(workflows|teams|graph|validate|supervisor|inbox|dry-run|suggest|checkpoints|tasks\/([^/]+)\/(dependencies|contract|branch|review|compensation|inputs)|tasks\/ready)$/,
  );
  if (!scoped) return false;
  const workspaceId = scoped[1];
  const rest = scoped[2];
  const taskId = scoped[3] ?? null;
  const taskAction = scoped[4] ?? null;

  if (rest === "workflows") {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    if (method === "GET") {
      send(200, workflows.list(workspaceId));
      return true;
    }
    if (method === "POST") {
      const input = (await body(65536)) ?? {};
      if (!input.templateId) throw new InputError("templateId is required");
      send(
        201,
        workflows.instantiate(workspaceId, input.templateId, {
          inputs: input.inputs ?? {},
          provider: input.provider ?? null,
          agentByRole: input.agentByRole ?? {},
          contracts: input.contracts ?? {},
          actor,
        }),
      );
      return true;
    }
  }

  // POST /api/workspaces/:id/teams: deploy a team for a template — staff
  // every role (agentByRole / createAgents), choose each role's assistant
  // (providerByRole), and optionally start the steps that wait on nothing.
  if (rest === "teams" && method === "POST") {
    if (!workflows) throw new InputError("Workflows are not available", 503);
    const input = (await body(65536)) ?? {};
    if (!input.templateId) throw new InputError("templateId is required");
    send(
      201,
      await workflows.deploy(workspaceId, input.templateId, {
        inputs: input.inputs ?? {},
        provider: input.provider ?? null,
        agentByRole: input.agentByRole ?? {},
        providerByRole: input.providerByRole ?? {},
        // true: a profile for every unstaffed role; a list: only those roles.
        createAgents: Array.isArray(input.createAgents)
          ? input.createAgents.filter((key) => typeof key === "string")
          : input.createAgents === true,
        start: input.start === true,
        contracts: input.contracts ?? {},
        actor,
      }),
    );
    return true;
  }

  if (rest === "checkpoints") {
    if (method === "GET") {
      send(200, checkpoints().list({ workspaceId }));
      return true;
    }
    if (method === "POST") {
      const input = (await body()) ?? {};
      send(
        201,
        checkpoints().create({
          workspaceId,
          workflowId: input.workflowId ?? null,
          taskId: input.taskId ?? null,
          runId: input.runId ?? null,
          kind: input.kind ?? "manual",
          label: input.label ?? null,
          actor,
        }),
      );
      return true;
    }
  }

  if (method === "POST" && rest === "dry-run") {
    const input = (await body()) ?? {};
    send(
      200,
      dryRun().plan({
        workspaceId,
        workflowId: input.workflowId ?? null,
        taskIds: input.taskIds ?? null,
      }),
    );
    return true;
  }

  if (method === "POST" && rest === "suggest") {
    const input = (await body()) ?? {};
    send(
      200,
      suggest().suggestTeam({
        workspaceId,
        templateId: input.templateId ?? null,
        goal: input.goal ?? null,
      }),
    );
    return true;
  }

  if (!graph) throw new InputError("Task graph is not available", 503);

  if (method === "GET" && rest === "graph") {
    send(200, graph.graph(workspaceId));
    return true;
  }
  if (method === "GET" && rest === "validate") {
    services.hub.get(workspaceId);
    send(
      200,
      graph.validateWorkflow(workspaceId, {
        workflowId: query?.get?.("workflow") ?? null,
      }),
    );
    return true;
  }
  // A proposal checked before it is written: { taskId, dependsOn }.
  if (method === "POST" && rest === "validate") {
    const input = (await body()) ?? {};
    if (!input.taskId) throw new InputError("taskId is required");
    send(
      200,
      graph.validateProposedDependencies(
        workspaceId,
        String(input.taskId),
        input.dependsOn ?? [],
      ),
    );
    return true;
  }
  if (method === "GET" && rest === "supervisor") {
    const stalledAfterMs = Number(query?.get?.("stalledAfterMs"));
    send(
      200,
      graph.supervisorView(workspaceId, {
        stalledAfterMs:
          Number.isFinite(stalledAfterMs) && stalledAfterMs > 0
            ? stalledAfterMs
            : undefined,
      }),
    );
    return true;
  }
  if (method === "GET" && rest === "inbox") {
    send(200, graph.inbox(workspaceId));
    return true;
  }
  if (method === "GET" && rest === "tasks/ready") {
    services.hub.get(workspaceId);
    send(200, graph.ready(workspaceId));
    return true;
  }

  if (taskId) {
    if (method === "PATCH" && taskAction === "dependencies") {
      const input = (await body()) ?? {};
      send(
        200,
        graph.setDependencies(workspaceId, taskId, input.dependsOn ?? [], {
          actor,
        }),
      );
      return true;
    }
    if (taskAction === "contract") {
      if (method === "GET") {
        services.hub.get(workspaceId);
        send(200, graph.contract(taskId));
        return true;
      }
      if (method === "PUT") {
        const input = (await body(65536)) ?? {};
        send(
          200,
          graph.setContract(workspaceId, taskId, input.contract ?? input, {
            actor,
          }),
        );
        return true;
      }
      if (method === "POST") {
        // Check a recorded run's evidence against the contract.
        const input = (await body(262144)) ?? {};
        send(
          200,
          graph.recordResult(taskId, {
            runId: input.runId ?? null,
            artifacts: input.artifacts ?? [],
            finalMessage: input.finalMessage ?? null,
            events: input.events ?? [],
            actor,
          }),
        );
        return true;
      }
    }
    if (method === "PUT" && taskAction === "branch") {
      const input = (await body()) ?? {};
      send(
        200,
        graph.setBranchCondition(
          workspaceId,
          taskId,
          input.branchCondition ?? input.condition ?? null,
          { actor },
        ),
      );
      return true;
    }
    if (method === "GET" && taskAction === "inputs") {
      services.hub.get(workspaceId);
      send(200, graph.checkTaskInputs(taskId));
      return true;
    }
    if (method === "POST" && taskAction === "review") {
      const input = (await body()) ?? {};
      send(
        200,
        graph.resolveReview(taskId, {
          decision: input.decision,
          note: input.note ?? "",
          actor,
        }),
      );
      return true;
    }
    if (method === "POST" && taskAction === "compensation") {
      const input = (await body()) ?? {};
      services.hub.get(workspaceId);
      send(
        201,
        checkpoints().registerCompensation(taskId, {
          description: input.description,
          command: input.command ?? null,
          actor,
        }),
      );
      return true;
    }
  }
  return false;
}
