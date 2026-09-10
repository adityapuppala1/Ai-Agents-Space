import opsRoutes from "./ops.js";
import scheduleRoutes from "./schedules.js";
import flagRoutes from "./flags.js";
import viewRoutes from "./views.js";
import webhookRoutes from "./webhooks.js";
import searchRoutes from "./search.js";
import connectorRoutes from "./connectors.js";
import collabRoutes from "./collab.js";
import evaluationRoutes from "./evaluation.js";
import extensionRoutes from "./extensions.js";
import connectionRoutes from "./connections.js";
import sessionRoutes from "./sessions.js";
import runRoutes from "./runs.js";
import approvalRoutes from "./approvals.js";
import policyRoutes from "./policy.js";
import hookRoutes from "./hooks.js";
import settingsRoutes from "./settings.js";
import auditRoutes from "./audit.js";
import workflowRoutes from "./workflows.js";
import analyticsRoutes from "./analytics.js";
import contextRoutes from "./context.js";
import exportRoutes from "./export.js";
import visualPresetRoutes from "./visualPresets.js";
import workspaceRoutes from "./workspaces.js";

/**
 * Ordered route handlers. Each receives the request context and returns true
 * when it handled the request, false to let the next one try.
 *
 * Every module-specific handler is registered BEFORE workspaceRoutes: that
 * one owns the generic /api/workspaces/:id prefix and the legacy unscoped
 * paths, and answers 404-by-fallthrough for unknown workspace-scoped paths.
 * Handlers that claim /api/workspaces/:id/... sub-paths (runs, policy,
 * workflows, context, export) therefore must come first, and they return
 * false for any path that is not theirs so workspaceRoutes still gets it.
 *
 * Wave 2 additions (ops, webhooks, search) claim their own /api prefixes and
 * are listed first so a missing service surfaces as a 503 from the owning
 * module rather than a 404 from the catch-all.
 *
 * collab, evaluation and extensions landed in wave 2 and are registered
 * before runRoutes/workflowRoutes because they claim sub-paths under prefixes
 * those modules own (/api/runs/:id/decisions, /api/runs/:id/evaluate/*,
 * /api/templates/:id/export). Each returns false for anything that is not
 * theirs, so the owning module still sees every other path.
 */
export const routes = [
  opsRoutes, // /api/ops*
  scheduleRoutes, // /api/schedules*, /api/workspaces/:id/schedules, /api/scheduler/status
  flagRoutes, // /api/flags*
  viewRoutes, // /api/views*, /api/workspaces/:id/views
  webhookRoutes, // /api/webhooks*
  searchRoutes, // /api/search*
  connectorRoutes, // /api/connectors*, /api/workspaces/:id/checks
  collabRoutes, // /api/handover*, /api/decisions, /api/workspaces|runs/:id/{handover,decisions}
  evaluationRoutes, // /api/evaluations*, /api/benchmarks*, /api/runs/:id/evaluate/*
  extensionRoutes, // /api/extensions*, /api/templates/:id/export, /api/templates/import-preview
  connectionRoutes, // /api/providers, /api/connections*
  sessionRoutes, // /api/sessions*, /api/observation*
  runRoutes, // /api/workspaces/:id/tasks/:taskId/run, /api/runs/:id*
  approvalRoutes, // /api/approvals*, /api/inbox
  policyRoutes, // /api/policy/presets, /api/workspaces/:id/policy*
  hookRoutes, // /api/hooks/claude-code*
  settingsRoutes, // /api/settings
  auditRoutes, // /api/audit
  workflowRoutes, // /api/templates*, /api/workflows/:id*, /api/workspaces/:id/{workflows,graph,tasks/ready,tasks/:id/dependencies}
  analyticsRoutes, // /api/analytics*
  contextRoutes, // /api/workspaces/:id/context/*
  visualPresetRoutes, // /api/workspaces/:id/visual-preset*
  exportRoutes, // /api/workspaces/:id/export, /api/workspaces/import
  workspaceRoutes, // everything else under /api (must stay last)
];
