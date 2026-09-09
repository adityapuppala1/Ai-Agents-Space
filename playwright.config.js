import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
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
    env: { PORT: "5174", AGENT_SPACE_DB: ":memory:" },
    reuseExistingServer: false,
  },
});
