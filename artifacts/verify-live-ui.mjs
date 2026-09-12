import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const mobile =
  process.env.VIEWPORT === "mobile" || process.argv.includes("--mobile");
const auditRoutes =
  process.env.AUDIT === "routes" || process.argv.includes("--routes");
const theme = process.env.THEME === "dark" ? "dark" : "light";
const page = await browser.newPage({
  viewport: mobile
    ? { width: 390, height: 844 }
    : { width: 1440, height: 1000 },
  colorScheme: theme,
});
await page.addInitScript(
  ({ requestedTheme }) => {
    localStorage.setItem("agent-space-workspace", "ai-agents-view");
    localStorage.setItem("agent-space-theme", requestedTheme);
  },
  { requestedTheme: theme },
);
const errors = [];
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
const routeAudit = [];
if (auditRoutes) {
  const routes = [
    "Workspace",
    "Campus",
    "Task board",
    "Board",
    "Dependencies",
    "Workflow editor",
    "Activity",
    "Timeline",
    "Live sessions",
    "Day in review",
    "Analytics",
    "Inbox",
    "Your agents",
    "Connections",
    "Operations",
    "Knowledge",
  ];
  for (const route of routes) {
    await page
      .getByRole("button", { name: route, exact: true })
      .first()
      .click();
    await page.waitForTimeout(250);
    await page
      .waitForFunction(
        () =>
          !Array.from(
            document.querySelectorAll("main p, main .panel-loading"),
          ).some((node) =>
            /^Loading(?:\s|…|\.\.\.)/i.test(node.textContent?.trim() ?? ""),
          ),
        null,
        { timeout: 2500 },
      )
      .catch(() => {});
    routeAudit.push({
      route,
      overflow: await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      loading: await page
        .locator("main p, main .panel-loading")
        .filter({ hasText: /^Loading(?:\s|…|\.\.\.)/i })
        .count(),
      alerts: await page.locator("main [role='alert']").count(),
      heading: await page
        .locator("main h1, main h2, main h3")
        .first()
        .textContent()
        .catch(() => null),
    });
  }
}
await page.screenshot({
  path: auditRoutes
    ? mobile
      ? `artifacts/route-audit-mobile-${theme}.png`
      : `artifacts/route-audit-desktop-${theme}.png`
    : mobile
      ? `artifacts/choreography-mobile-${theme}.png`
      : `artifacts/choreography-live-${theme}.png`,
  fullPage: true,
});
const actualTheme = await page.locator("html").getAttribute("data-theme");
const office = await page.locator(".office-wrap").count();
const cues = await page.locator(".office-choreography button").count();
const cameraDirector = await page
  .getByRole("button", { name: "Live camera director" })
  .count();
const workspace = await page
  .locator("[aria-label^='Workspace:']")
  .getAttribute("aria-label");
const agentTitles = await page
  .locator(".scene-label")
  .evaluateAll((items) => items.map((item) => item.title));
let templateRecommendation = null;
let settingsNavigation = null;
let campus = null;
const verifyTemplates = process.env.VERIFY_TEMPLATES !== "false";
if (verifyTemplates) {
  await page.getByRole("button", { name: "Campus", exact: true }).click();
  await page.locator(".campus-scene canvas").waitFor();
  campus = {
    canvas: await page.locator(".campus-scene canvas").count(),
    buildings: await page
      .getByRole("list", { name: "Campus buildings" })
      .getByRole("listitem")
      .count(),
    overflow: await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  };
  await page
    .getByRole("list", { name: "Campus buildings" })
    .getByRole("button")
    .first()
    .click();
  const campusDialog = page.getByRole("dialog");
  await campusDialog.getByRole("button", { name: "Enter workspace" }).waitFor();
  await campusDialog
    .getByText("Loading recorded rooms…", { exact: true })
    .waitFor({ state: "hidden" })
    .catch(() => {});
  campus.detail = {
    enterAction: await campusDialog
      .getByRole("button", { name: "Enter workspace" })
      .count(),
    taskCounts: await campusDialog
      .getByLabel("Workspace task counts")
      .locator(":scope > span")
      .count(),
    rooms: await campusDialog
      .getByLabel("Workspace rooms")
      .locator(".campus-room")
      .count(),
  };
  await campusDialog.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Task board", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Use a template" }).click();
  await page.getByText("Data Lab ready", { exact: true }).first().waitFor();
  await page
    .getByRole("button", { name: "Use template Data analytics" })
    .click();
  const environmentChoice = page.getByText("Open this workflow in Data Lab", {
    exact: true,
  });
  templateRecommendation = {
    badges: await page.getByText("Data Lab ready", { exact: true }).count(),
    choiceVisible: await environmentChoice.isVisible(),
    enabled: await environmentChoice
      .locator("xpath=ancestor::label")
      .locator("input[type='checkbox']")
      .isChecked(),
  };
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Workspace settings" }).click();
  const settingsDialog = page.getByRole("dialog", {
    name: "Workspace settings",
  });
  const sectionNav = settingsDialog.getByRole("navigation", {
    name: "Settings sections",
  });
  await sectionNav.getByRole("button", { name: /Environment/ }).click();
  settingsNavigation = {
    tabs: await sectionNav.getByRole("button").count(),
    environmentHeading: await settingsDialog
      .getByRole("heading", { name: "Compose the working environment" })
      .isVisible(),
    environments: await settingsDialog
      .getByLabel("Office theme")
      .getByRole("button")
      .count(),
    wideElements: await settingsDialog.evaluate((dialog) =>
      [dialog, ...dialog.querySelectorAll("*")]
        .filter((node) => node.scrollWidth > node.clientWidth + 2)
        .slice(0, 8)
        .map((node) => ({
          element: `${node.tagName.toLowerCase()}.${node.className || ""}`,
          overflow: node.scrollWidth - node.clientWidth,
        })),
    ),
    overflow: await settingsDialog.evaluate(
      // The dialog itself has a vertical scrollbar on mobile, so compare its
      // descendants rather than misclassifying scrollbar width as horizontal
      // overflow.
      (dialog) =>
        [dialog, ...dialog.querySelectorAll("*")]
          .slice(1)
          .filter((node) => node.scrollWidth > node.clientWidth + 2).length,
    ),
  };
}
console.log(
  JSON.stringify({
    title: await page.title(),
    theme: actualTheme,
    bodyText: (await page.locator("body").innerText()).slice(0, 160),
    office,
    cues,
    cameraDirector,
    horizontalOverflow: await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
    workspace,
    agentTitles,
    routeAudit,
    templateRecommendation,
    settingsNavigation,
    campus,
    errors,
  }),
);
await browser.close();

if (
  errors.length ||
  actualTheme !== theme ||
  (verifyTemplates &&
    (!templateRecommendation?.choiceVisible ||
      !templateRecommendation?.enabled ||
      templateRecommendation?.badges < 2 ||
      settingsNavigation?.tabs !== 3 ||
      !settingsNavigation?.environmentHeading ||
      settingsNavigation?.environments !== 8 ||
      settingsNavigation?.overflow > 0 ||
      campus?.canvas !== 1 ||
      campus?.buildings < 1 ||
      campus?.detail?.enterAction !== 1 ||
      campus?.detail?.taskCounts !== 4 ||
      campus?.overflow > 0)) ||
  routeAudit.some((route) => route.overflow > 0 || route.loading > 0)
) {
  process.exitCode = 1;
}
