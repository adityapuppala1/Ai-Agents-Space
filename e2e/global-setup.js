/**
 * Playwright global setup for Agent Space.
 *
 * Every provider home the server may read during e2e (Claude Code, Codex,
 * Copilot, Cursor, Gemini) is redirected to an empty folder under
 * test-results/homes so observation never touches the real machine. The
 * folders are also created from playwright.config.js at load time (the web
 * server starts before global setup runs); this file is the documented
 * owner of the layout and re-creates anything missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const HOMES_ROOT = path.join(root, "test-results", "homes");

/** Absolute folders passed to the server as provider homes and data dirs. */
export const HOMES = Object.freeze({
  claude: path.join(HOMES_ROOT, "claude"),
  codex: path.join(HOMES_ROOT, "codex"),
  copilot: path.join(HOMES_ROOT, "copilot"),
  cursor: path.join(HOMES_ROOT, "cursor"),
  gemini: path.join(HOMES_ROOT, "gemini"),
  /** Project folders created by tests (workspace root paths, fake cwds). */
  projects: path.join(HOMES_ROOT, "projects"),
  /** AGENT_SPACE_DATA_DIR for the e2e server (worktrees, artifacts). */
  data: path.join(root, "test-results", "data"),
});

export function ensureHomes({ clean = false } = {}) {
  if (clean) {
    fs.rmSync(HOMES_ROOT, { recursive: true, force: true });
    fs.rmSync(HOMES.data, { recursive: true, force: true });
  }
  for (const dir of Object.values(HOMES))
    fs.mkdirSync(dir, { recursive: true });
  // Marker so anyone inspecting test-results knows these are throwaway homes.
  fs.writeFileSync(
    path.join(HOMES_ROOT, "README.txt"),
    "Throwaway provider homes for Playwright e2e. Safe to delete.\n",
  );
  return HOMES;
}

export default async function globalSetup() {
  ensureHomes();
}
