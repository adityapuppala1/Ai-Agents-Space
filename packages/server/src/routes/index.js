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
 */
export const routes = [
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
  exportRoutes, // /api/workspaces/:id/export, /api/workspaces/import
  workspaceRoutes, // everything else under /api (must stay last)
];
