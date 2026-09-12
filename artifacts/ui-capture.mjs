// Captures a few real screens as evidence, against the same isolated harness
// the route audit uses: its own port, an in-memory database, fake provider
// CLIs and throwaway provider homes. Never the database in daily use.
//
// The route audit deliberately screenshots only what FAILED — a folder of 256
// correct screenshots is not evidence anyone reads. This is the other job:
// a handful of deliberately chosen views, for a report a person will look at.
//
//   node artifacts/ui-capture.mjs
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "test-results", "ui-capture");
fs.mkdirSync(outDir, { recursive: true });

const q = (v) => `"${v}"`;
const fake = (n) => path.join(root, "tests", "fixtures", "fake-cli", n);
const homes = path.join(root, "test-results", "audit-homes");
for (const sub of [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "data",
  "projects",
])
  fs.mkdirSync(path.join(homes, sub), { recursive: true });

/** What to capture, and why each one is worth a reader's attention. */
const SHOTS = [
  {
    route: "Workspace",
    theme: "light",
    viewport: { name: "desktop-1440", width: 1440, height: 900 },
  },
  {
    route: "Workspace",
    theme: "dark",
    viewport: { name: "desktop-1440", width: 1440, height: 900 },
  },
  {
    route: "Workspace",
    theme: "light",
    viewport: { name: "phone-390", width: 390, height: 844 },
  },
  {
    route: "Connections",
    theme: "light",
    viewport: { name: "desktop-1440", width: 1440, height: 900 },
  },
  {
    route: "Task board",
    theme: "dark",
    viewport: { name: "desktop-1440", width: 1440, height: 900 },
  },
  {
    route: "Operations",
    theme: "light",
    viewport: { name: "desktop-1440", width: 1440, height: 900 },
  },
];

const server = spawn(process.execPath, ["packages/server/src/main.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: "5174",
    DEMO: "true",
    AGENT_SPACE_DB: ":memory:",
    AGENT_SPACE_BIN_CLAUDE_CODE: `${q(process.execPath)} ${q(fake("claude.js"))}`,
    AGENT_SPACE_BIN_COPILOT: `${q(process.execPath)} ${q(fake("copilot.js"))}`,
    AGENT_SPACE_BIN_CODEX: `${q(process.execPath)} ${q(fake("codex.js"))}`,
    AGENT_SPACE_BIN_GEMINI: `${q(process.execPath)} ${q(fake("gemini.js"))}`,
    AGENT_SPACE_BIN_CURSOR: `${q(process.execPath)} ${q(fake("cursor.js"))}`,
    CLAUDE_CONFIG_DIR: path.join(homes, "claude"),
    CODEX_HOME: path.join(homes, "codex"),
    COPILOT_HOME: path.join(homes, "copilot"),
    CURSOR_HOME: path.join(homes, "cursor"),
    GEMINI_HOME: path.join(homes, "gemini"),
    AGENT_SPACE_DATA_DIR: path.join(homes, "data"),
  },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let up = false;
  for (let i = 0; i < 90; i += 1) {
    try {
      if ((await fetch("http://127.0.0.1:5174/api/health")).ok) {
        up = true;
        break;
      }
    } catch {}
    await wait(500);
  }
  if (!up) throw new Error("the capture server never answered on 5174");

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    // The office is WebGL; without a software rasteriser it renders nothing
    // and the screenshot would quietly show an empty floor.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const written = [];
  for (const shot of SHOTS) {
    const page = await browser.newPage({
      viewport: { width: shot.viewport.width, height: shot.viewport.height },
      colorScheme: shot.theme,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await page.addInitScript((t) => {
      localStorage.setItem("agent-space-workspace", "demo");
      localStorage.setItem("agent-space-theme", t);
      localStorage.setItem(
        "agent-space-onboarding",
        JSON.stringify({ step: 0, done: [], dismissed: true }),
      );
    }, shot.theme);
    await page.goto("http://127.0.0.1:5174/", { waitUntil: "networkidle" });
    await wait(2500);

    const rail = page
      .locator("aside")
      .getByRole("button", { name: shot.route, exact: true });
    if (await rail.count()) await rail.first().click({ timeout: 5000 });
    else {
      // Narrow layouts move the rail into a "More" sheet.
      const more = page.getByRole("button", { name: /more/i });
      if (await more.count()) {
        await more.first().click();
        await page
          .getByRole("button", { name: shot.route, exact: true })
          .first()
          .click({ timeout: 5000 });
      }
    }
    // The office animates in; give it time to settle so the shot is of a
    // drawn floor rather than a half-built one.
    await wait(shot.route === "Workspace" ? 5000 : 2500);

    const name = `${shot.route.replace(/\W+/g, "-").toLowerCase()}-${shot.theme}-${shot.viewport.name}.png`;
    await page.screenshot({ path: path.join(outDir, name) });
    const bytes = fs.statSync(path.join(outDir, name)).size;
    written.push({ ...shot, file: name, bytes, errors: [...errors] });
    console.log(
      `${name}  ${(bytes / 1024).toFixed(0)} KB${errors.length ? `  ERRORS: ${errors.length}` : ""}`,
    );
    for (const error of errors) console.log(`    ${error}`);
    await page.close();
  }

  await browser.close();
  fs.writeFileSync(
    path.join(outDir, "captured.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), written }, null, 2),
  );
  const withErrors = written.filter((w) => w.errors.length).length;
  console.log(
    `\n${written.length} screenshots written to test-results/ui-capture` +
      (withErrors
        ? `, ${withErrors} with console errors`
        : ", none with console errors"),
  );
}

try {
  await main();
} finally {
  server.kill();
}
