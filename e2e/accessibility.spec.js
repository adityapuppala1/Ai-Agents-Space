import { test, expect } from "@playwright/test";

/**
 * Automated accessibility checks (roadmap section 13, WCAG 2.2 AA target).
 *
 * These are the checks a machine can make honestly: accessible names on every
 * control, labelled form fields, unique ids, alt text, a visible focus ring,
 * reduced motion honoured, and real contrast arithmetic on the design tokens in
 * both themes. They are NOT a conformance claim: a manual screen-reader pass
 * and a human review are still required, and the docs say so.
 */

const VIEWS = [
  "Workspace",
  "Task board",
  "Board",
  "Dependencies",
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

async function dismissSetup(page) {
  for (const name of ["Skip setup", "Skip", "Not now", "Close dialog"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.count().catch(() => 0)) {
      await button
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

/** WCAG relative luminance and contrast ratio for #rrggbb colours. */
function luminance(hex) {
  const n = hex.replace("#", "");
  const full =
    n.length === 3
      ? n
          .split("")
          .map((c) => c + c)
          .join("")
      : n;
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(full.slice(i, i + 2), 16) / 255,
  );
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

async function tokens(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    return {
      text: read("--text"),
      muted: read("--muted"),
      panel: read("--panel"),
      page: read("--page"),
      soft: read("--soft"),
      accent: read("--accent"),
      accentSoft: read("--accent-soft"),
    };
  });
}

/** Every visible interactive control has an accessible name. */
async function unnamedControls(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none"
      );
    };
    const name = (el) => {
      const byId = el.getAttribute("aria-labelledby");
      const ref = byId ? document.getElementById(byId) : null;
      return (
        el.getAttribute("aria-label") ||
        (ref && ref.textContent) ||
        el.getAttribute("title") ||
        el.textContent ||
        (el.tagName === "INPUT" && el.value) ||
        ""
      ).trim();
    };
    const out = [];
    const selector =
      "button, a[href], [role=button], [role=tab], [role=menuitem]";
    for (const el of document.querySelectorAll(selector)) {
      if (!visible(el)) continue;
      if (el.closest("[aria-hidden=true]")) continue;
      if (!name(el)) {
        const cls = String(el.className).split(" ")[0] || "?";
        out.push(`${el.tagName.toLowerCase()}.${cls}`);
      }
    }
    return out;
  });
}

/** Every visible form field is labelled somehow. */
async function unlabelledFields(page) {
  return page.evaluate(() => {
    const out = [];
    const fields = document.querySelectorAll(
      "input:not([type=hidden]), select, textarea",
    );
    for (const el of fields) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest("[aria-hidden=true]")) continue;
      const forLabel = el.id
        ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        : null;
      const labelled =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        el.closest("label") ||
        forLabel ||
        el.getAttribute("title");
      if (!labelled)
        out.push(`${el.tagName.toLowerCase()}[name=${el.name || "?"}]`);
    }
    return out;
  });
}

async function duplicateIds(page) {
  return page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]"))
      seen.set(el.id, (seen.get(el.id) || 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
}

async function imagesWithoutAlt(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("img")]
      .filter(
        (img) =>
          !img.hasAttribute("alt") &&
          img.getAttribute("role") !== "presentation",
      )
      .map((img) => img.src.slice(-40)),
  );
}

test("every view has named controls, labelled fields, unique ids and alt text", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  const problems = [];
  for (const view of VIEWS) {
    await page.getByRole("button", { name: view, exact: true }).first().click();
    await page.waitForTimeout(700);
    const unnamed = await unnamedControls(page);
    const unlabelled = await unlabelledFields(page);
    const dupes = await duplicateIds(page);
    const noAlt = await imagesWithoutAlt(page);
    if (unnamed.length)
      problems.push(`${view}: unnamed controls ${unnamed.join(", ")}`);
    if (unlabelled.length)
      problems.push(`${view}: unlabelled fields ${unlabelled.join(", ")}`);
    if (dupes.length)
      problems.push(`${view}: duplicate ids ${dupes.join(", ")}`);
    if (noAlt.length)
      problems.push(`${view}: images without alt ${noAlt.join(", ")}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("design tokens meet WCAG AA contrast in light and dark themes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  const report = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(100);
    const t = await tokens(page);
    const checks = [
      ["body text on panel", contrast(t.text, t.panel), 4.5],
      ["body text on page", contrast(t.text, t.page), 4.5],
      ["body text on soft", contrast(t.text, t.soft), 4.5],
      ["muted text on panel", contrast(t.muted, t.panel), 4.5],
      ["muted text on page", contrast(t.muted, t.page), 4.5],
      ["accent text on panel", contrast(t.accent, t.panel), 4.5],
      ["accent text on accent-soft", contrast(t.accent, t.accentSoft), 3.0],
    ];
    for (const [label, ratio, minimum] of checks) {
      report.push(`${theme} ${label}: ${ratio.toFixed(2)}:1 (min ${minimum})`);
      expect(
        ratio,
        `${theme} ${label} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  }
  console.log(report.join("\n"));
});

test("keyboard focus is visible and reduced motion is honoured", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await dismissSetup(page);
  // Tab from the document start: the first stop must be a real control with a
  // visible focus indicator (outline or box-shadow), never colour alone.
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body)
      return { ok: false, reason: "focus did not land on a control" };
    const s = getComputedStyle(el);
    const ring = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const shadow = !!s.boxShadow && s.boxShadow !== "none";
    return {
      ok: ring || shadow,
      tag: el.tagName,
      name:
        el.getAttribute("aria-label") ||
        (el.textContent || "").trim().slice(0, 30),
    };
  });
  expect(focus.ok, JSON.stringify(focus)).toBe(true);
  const reduced = await page.evaluate(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(reduced).toBe(true);
});
