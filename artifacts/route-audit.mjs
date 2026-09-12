// Route audit: every page, at every viewport, in both themes.
//
// Committed on purpose. It has been a throwaway script twice, and both times
// the findings had to be rediscovered — the rem type-scale regression was
// caught by counting text under 12px, not by anyone's eye. Keeping it here
// means the sweep is repeatable and the numbers are comparable run to run.
//
//   node artifacts/route-audit.mjs [--out <dir>] [--fast]
//
// It starts its own server on 5174 with an in-memory database and throwaway
// provider homes. It never touches the real database or the server on 5173.
//
// Four checks, chosen because each one fails loudly and never guesses:
//   overflow  the page scrolls sideways at that width
//   errors    a page or console error was raised while rendering
//   unnamed   an interactive control with no accessible name
//   tiny      text rendered below the 12px floor the design system sets

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outDir = path.resolve(
  args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(root, "test-results", "route-audit"),
);
const fast = args.includes("--fast");
fs.mkdirSync(outDir, { recursive: true });

/** The rail's own routes, by the button that opens each. */
const ROUTES = [
  "Workspace",
  "Task board",
  "Inbox",
  "Agents",
  "Live sessions",
  "Activity",
  "Timeline",
  "Day in review",
  "Analytics",
  "Workflow editor",
  "Dependencies",
  "Schedules",
  "Campus",
  "Connections",
  "Operations",
  "Knowledge",
];

/** Widths people actually use, narrowest first. */
const VIEWPORTS = [
  { name: "phone-360", width: 360, height: 740 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "tablet-1024", width: 1024, height: 768 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "wide-1920", width: 1920, height: 1080 },
];

const THEMES = ["light", "dark"];

/** The design system's floor. Anything smaller was a mistake, not a choice. */
const MIN_FONT_PX = 12;

const q = (v) => `"${v}"`;
const fake = (n) => path.join(root, "tests", "fixtures", "fake-cli", n);
const homes = path.join(root, "test-results", "audit-homes");
for (const sub of ["claude", "codex", "copilot", "cursor", "gemini", "data", "projects"])
  fs.mkdirSync(path.join(homes, sub), { recursive: true });

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

/**
 * Runs inside the page. Returns the three DOM findings; page errors are
 * collected outside, from the browser's own events.
 */
function inspect(minFont) {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    )
      return false;
    // A closed <details> keeps its contents in the DOM and out of the page.
    // They are not on screen, so they are not this audit's business.
    const details = el.closest("details");
    return !details || details.open;
  };

  // A control nobody can name is a control a screen reader cannot offer.
  //
  // Named from *contents*, which is what the accessible-name algorithm uses.
  // An earlier version read innerText and produced thirty false positives:
  // innerText is layout-dependent and empty for anything inside a closed
  // <details>, so buttons plainly reading "Save view" were reported unnamed.
  const named = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return true;
    const by = el.getAttribute("aria-labelledby");
    if (by && by.split(/\s+/).some((id) => document.getElementById(id))) return true;
    if (el.getAttribute("title")?.trim()) return true;
    if ((el.textContent ?? "").trim()) return true;
    if (el.getAttribute("alt")?.trim()) return true;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
      return true;
    if (el.closest("label")) return true;
    // An image-only button is named by its image's alt text.
    return [...el.querySelectorAll("img[alt]")].some((img) =>
      img.getAttribute("alt")?.trim(),
    );
  };

  const unnamed = [];
  for (const el of document.querySelectorAll(
    "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]",
  )) {
    if (!visible(el)) continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (named(el)) continue;
    unnamed.push(
      `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ""}`,
    );
  }

  const tiny = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue; // leaves only: the node holding the text
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    if (!visible(el)) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (Number.isFinite(size) && size < minFont)
      tiny.push(
        `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/)[0]}` : ""} ${size}px`,
      );
  }

  const doc = document.documentElement;
  return {
    overflow: Math.max(
      0,
      Math.round(doc.scrollWidth - doc.clientWidth),
    ),
    unnamed: [...new Set(unnamed)],
    tiny: [...new Set(tiny)],
  };
}

async function main() {
  for (let i = 0; i < 90; i += 1) {
    try {
      if ((await fetch("http://127.0.0.1:5174/api/health")).ok) break;
    } catch {}
    await wait(500);
  }

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const viewports = fast ? VIEWPORTS.filter((v) => v.width <= 430 || v.width >= 1440) : VIEWPORTS;
  const findings = [];
  let checks = 0;

  for (const theme of THEMES) {
    for (const viewport of viewports) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: theme,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      await page.addInitScript((t) => {
        localStorage.setItem("agent-space-workspace", "demo");
        localStorage.setItem("agent-space-theme", t);
        localStorage.setItem(
          "agent-space-onboarding",
          JSON.stringify({ step: 0, done: [], dismissed: true }),
        );
      }, theme);
      await page.goto("http://127.0.0.1:5174/", { waitUntil: "networkidle" });
      await wait(2500);

      for (const route of ROUTES) {
        errors.length = 0;
        // Narrow layouts move the rail into a "More" sheet.
        const rail = page.locator("aside").getByRole("button", {
          name: route,
          exact: true,
        });
        try {
          if (await rail.count()) await rail.first().click({ timeout: 5000 });
          else {
            const more = page.getByRole("button", { name: /^More/ });
            if (await more.count()) {
              await more.first().click({ timeout: 5000 });
              await wait(300);
              await page
                .getByRole("button", { name: route, exact: true })
                .first()
                .click({ timeout: 5000 });
            } else continue;
          }
        } catch {
          findings.push({ theme, viewport: viewport.name, route, kind: "unreachable", detail: "the rail never offered this route" });
          continue;
        }
        await wait(fast ? 700 : 1200);
        checks += 1;

        let result;
        try {
          result = await page.evaluate(inspect, MIN_FONT_PX);
        } catch (error) {
          findings.push({ theme, viewport: viewport.name, route, kind: "errors", detail: error.message });
          continue;
        }

        const where = { theme, viewport: viewport.name, route };
        if (result.overflow > 1)
          findings.push({ ...where, kind: "overflow", detail: `${result.overflow}px sideways` });
        if (result.unnamed.length)
          findings.push({ ...where, kind: "unnamed", detail: result.unnamed.join(", ") });
        if (result.tiny.length)
          findings.push({ ...where, kind: "tiny", detail: result.tiny.join(", ") });
        if (errors.length)
          findings.push({ ...where, kind: "errors", detail: [...new Set(errors)].join(" | ") });

        // A picture only where something is wrong: a folder of 256 correct
        // screenshots is not evidence anyone reads.
        if (findings.some((f) => f.route === route && f.viewport === viewport.name && f.theme === theme))
          await page
            .screenshot({
              path: path.join(outDir, `${theme}-${viewport.name}-${route.replace(/\W+/g, "-")}.png`),
              fullPage: false,
            })
            .catch(() => {});
      }
      await page.close();
    }
  }

  await browser.close();

  const byKind = {};
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  const report = {
    ranAt: new Date().toISOString(),
    routes: ROUTES.length,
    viewports: viewports.length,
    themes: THEMES.length,
    checks,
    findings,
    byKind,
  };
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log(
    `${checks} route renders checked (${ROUTES.length} routes x ${viewports.length} viewports x ${THEMES.length} themes)`,
  );
  if (!findings.length) {
    console.log("no findings");
    return;
  }
  console.log(
    Object.entries(byKind)
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(", "),
  );
  for (const finding of findings.slice(0, 60))
    console.log(
      `  [${finding.kind}] ${finding.theme}/${finding.viewport}/${finding.route}: ${finding.detail.slice(0, 160)}`,
    );
  if (findings.length > 60)
    console.log(`  … and ${findings.length - 60} more, in report.json`);
}

try {
  await main();
} finally {
  server.kill();
}
