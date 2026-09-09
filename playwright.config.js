import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOMES, ensureHomes } from "./e2e/global-setup.js";

const root = fileURLToPath(new URL("./", import.meta.url));
const fakeCli = (name) =>
  path.join(root, "tests", "fixtures", "fake-cli", name);
const q = (value) => `"${value}"`;

// The web server starts before globalSetup, so make sure the throwaway
// provider homes exist (and are clean) before it launches. Guarded by an env
// marker so worker processes that re-evaluate this config never wipe files
// written by running tests.
if (!process.env.AGENT_SPACE_E2E_HOMES_READY) {
  ensureHomes({ clean: true });
  process.env.AGENT_SPACE_E2E_HOMES_READY = "1";
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.js",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5174",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node packages/server/src/main.js",
    url: "http://127.0.0.1:5174/api/health",
    env: {
      PORT: "5174",
      AGENT_SPACE_DB: ":memory:",
      // Fake provider CLIs (absolute paths: managed runs spawn with the
      // workspace folder as cwd, so relative script paths would not resolve).
      AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fakeCli("claude.js"))}`,
      AGENT_SPACE_BIN_COPILOT: `${q(process.execPath)} ${q(fakeCli("copilot.js"))}`,
      AGENT_SPACE_BIN_CODEX: `${q(process.execPath)} ${q(fakeCli("codex.js"))}`,
      // Provider homes redirected to empty folders under test-results/homes so
      // observation never reads the real machine during e2e.
      CLAUDE_CONFIG_DIR: HOMES.claude,
      CODEX_HOME: HOMES.codex,
      COPILOT_HOME: HOMES.copilot,
      CURSOR_HOME: HOMES.cursor,
      GEMINI_HOME: HOMES.gemini,
      AGENT_SPACE_DATA_DIR: HOMES.data,
      AGENT_SPACE_OBSERVE_INTERVAL: "1000",
    },
    reuseExistingServer: false,
  },
});
