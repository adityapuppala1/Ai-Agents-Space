import { test, expect } from "@playwright/test";

/**
 * The path an assistive technology takes through the app: landmarks, headings,
 * named regions, announcements, and a text equivalent for the 3D office. These
 * are the structural checks a machine can make. They are NOT a screen-reader
 * pass: no automated check hears what NVDA or VoiceOver actually says, and the
 * docs say so.
 */

const VIEWS = [
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

async function dismissSetup(page) {
  for (const name of ["Skip setup", "Skip", "Not now", "Close dialog"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.count().catch(() => 0)) {
      await button
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

/** Landmarks, heading order and unnamed regions, as an AT would read them. */
async function structure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.hidden
      );
    };
    const named = (el) => {
      const by = el.getAttribute("aria-labelledby");
      const ref = by ? document.getElementById(by) : null;
      return (
        el.getAttribute("aria-label") ||
        (ref && ref.textContent.trim()) ||
        ""
      ).trim();
    };
    const landmarks = {
      banner: document.querySelectorAll("header[role=banner], body > header")
        .length,
      navigation: [...document.querySelectorAll("nav, [role=navigation]")].filter(
        visible,
      ).length,
      main: [...document.querySelectorAll("main, [role=main]")].filter(visible)
        .length,
    };
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter(visible)
      .filter((el) => !el.closest("[aria-hidden=true]"))
      .map((el) => ({
        level: Number(el.tagName[1]),
        text: el.textContent.trim().slice(0, 40),
      }));
    const skips = [];
    let previous = 0;
    for (const heading of headings) {
      if (previous && heading.level > previous + 1)
        skips.push(`h${previous} → h${heading.level} "${heading.text}"`);
      previous = heading.level;
    }
    // Several regions of the same role must be told apart by name.
    const unnamedRegions = [];
    for (const el of document.querySelectorAll(
      "section[aria-label], section[aria-labelledby], [role=region], nav, [role=navigation], aside, [role=complementary]",
    )) {
      if (!visible(el)) continue;
      if (el.tagName === "SECTION" || el.getAttribute("role") === "region") {
        if (!named(el))
          unnamedRegions.push(
            `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`,
          );
        continue;
      }
      if (!named(el))
        unnamedRegions.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`,
        );
    }
    const liveRegions = [
      ...document.querySelectorAll("[role=status], [role=alert], [aria-live]"),
    ].length;
    return {
      landmarks,
      h1: headings.filter((h) => h.level === 1).map((h) => h.text),
      skips,
      unnamedRegions,
      liveRegions,
      headings: headings.length,
    };
  });
}

test("every view keeps the landmarks, one page heading and an ordered outline", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  // Both states matter: a workspace with records, and an empty one, where
  // every panel falls back to its own empty-state heading.
  const created = await request.post("/api/workspaces", {
    data: { name: "Outline" },
  });
  const empty = (await created.json()).id;
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    empty,
  );
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  const problems = [];
  for (const workspace of [empty, "demo"]) {
    await page
      .getByLabel("Switch workspace", { exact: true })
      .selectOption(workspace);
    await page.waitForTimeout(600);
    const where = workspace === "demo" ? "demo" : "empty";
    for (const view of VIEWS) {
      await page
        .getByRole("button", { name: view, exact: true })
        .first()
        .click();
      await page.waitForTimeout(500);
      const report = await structure(page);
      const say = `${view} (${where})`;
      if (report.landmarks.main !== 1)
        problems.push(`${say}: ${report.landmarks.main} main landmarks`);
      if (report.landmarks.navigation < 1)
        problems.push(`${say}: no navigation landmark`);
      if (report.h1.length !== 1)
        problems.push(`${say}: ${report.h1.length} level-1 headings`);
      if (report.skips.length)
        problems.push(`${say}: heading level skipped ${report.skips.join(", ")}`);
      if (report.unnamedRegions.length)
        problems.push(`${say}: unnamed regions ${report.unnamedRegions.join(", ")}`);
      if (report.liveRegions < 1)
        problems.push(`${say}: no live region for announcements`);
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

/** Tabs until the focused control's accessible name matches, or gives up. */
async function tabTo(page, pattern, limit = 60) {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return "";
      const label = el.labels?.[0]?.textContent?.trim();
      return (
        el.getAttribute("aria-label") ||
        label ||
        (el.textContent || "").trim() ||
        el.getAttribute("title") ||
        ""
      ).slice(0, 60);
    });
    if (pattern.test(name)) return name;
  }
  throw new Error(`no focus stop matched ${pattern} within ${limit} tabs`);
}

test("the office is readable without the picture: names, states and spoken changes", async ({
  page,
  request,
}) => {
  // A team of its own, at work: what the office says is then this test's
  // doing, not the demo simulation's clock.
  const created = await request.post("/api/workspaces", {
    data: { name: "Spoken" },
  });
  const workspaceId = (await created.json()).id;
  for (let i = 0; i < 4; i += 1) {
    const agent = await (
      await request.post(`/api/workspaces/${workspaceId}/agents`, {
        data: { name: `Reader ${i + 1}`, role: "Reader", color: "#4a7dd0" },
      })
    ).json();
    const task = await (
      await request.post(`/api/workspaces/${workspaceId}/tasks`, {
        data: { title: `Reader work ${i + 1}` },
      })
    ).json();
    await request.post(
      `/api/workspaces/${workspaceId}/tasks/${task.id}/assign`,
      { data: { agentId: agent.id } },
    );
  }
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  const scene = page.getByRole("group", { name: /^Office scene/ });
  await expect(scene).toBeVisible();
  // Every agent standing in the scene is also a named control, so the canvas
  // is never the only place a fact appears.
  const labels = page.locator(".scene-label");
  await expect(labels.first()).toBeAttached({ timeout: 30000 });
  const names = await labels.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(name).toMatch(/^Inspect \S/);
  // The roster repeats the floor as an ordinary list, with each agent's state.
  const roster = page.getByRole("region", { name: /^Agents \d/ });
  await expect(roster).toBeVisible();
  const first = names[0].replace("Inspect ", "");
  await expect(roster.getByRole("button", { name: new RegExp(first) })).toBeVisible();
  // What a sighted user sees happen is said out loud: this team walks into a
  // conference room, and back to its desks.
  const live = page.locator(".office-panel .sr-only[role=status]");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText("");
  await page
    .getByRole("button", { name: "Reader: meet in a conference room" })
    .click();
  await expect(live).toContainText(
    "Reader is meeting in a conference room: 4 at the table.",
    { timeout: 20000 },
  );
  await page.getByRole("button", { name: "Everyone back to desks" }).click();
  await expect(live).toContainText("Reader went back to their desks.");
});

test("keyboard focus is never hidden behind the fixed bars", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  const obscured = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    const report = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const x = Math.min(
        window.innerWidth - 2,
        Math.max(2, box.left + box.width / 2),
      );
      const y = Math.min(
        window.innerHeight - 2,
        Math.max(2, box.top + box.height / 2),
      );
      const hit = document.elementFromPoint(x, y);
      const covered = !(
        hit && (hit === el || el.contains(hit) || hit.contains(el))
      );
      return {
        covered,
        name: (
          el.getAttribute("aria-label") ||
          (el.textContent || "").trim()
        ).slice(0, 40),
        by: covered
          ? `${hit?.tagName}.${String(hit?.className).split(" ")[0]}`
          : "",
      };
    });
    if (report?.covered) obscured.push(`${report.name} covered by ${report.by}`);
  }
  expect(obscured, obscured.join("\n")).toEqual([]);
});

test("a task is created, assigned and completed with the keyboard alone", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workspaces", {
    data: { name: "Keyboard" },
  });
  const workspaceId = (await created.json()).id;
  await page.addInitScript(
    (id) => localStorage.setItem("agent-space-workspace", id),
    workspaceId,
  );
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("Home");

  await tabTo(page, /^New task$/);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.type("Write the release notes");
  await tabTo(page, /^Create task$/, 20);
  await page.keyboard.press("Enter");
  await expect(page.locator(".task-details h3")).toHaveText(
    "Write the release notes",
  );

  // Assign from the details pane: the select and the button are both stops.
  await tabTo(page, /Available agent|Choose an agent/, 60);
  await page.keyboard.press("ArrowDown");
  await tabTo(page, /^Assign task$/, 10);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Mark complete", exact: true }),
  ).toBeVisible();

  await tabTo(page, /^Mark complete$/, 60);
  await page.keyboard.press("Enter");
  await expect(page.locator(".completed-note")).toBeVisible();
  // The change was announced, not only drawn.
  await expect(page.locator("[role=status], [role=alert]").first()).toBeAttached();
});
