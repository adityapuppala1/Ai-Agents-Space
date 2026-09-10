import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The 10/50/100-agent scenarios from the roadmap's performance section.
 *
 * The roadmap is explicit that these "are test scenarios, not promised
 * capacity", and this file is written to honour that. The browser here renders
 * through SwiftShader (software WebGL), so the absolute frame times describe
 * this harness and nothing else: they are NOT a claim about any user's machine,
 * and no agent count or frame rate is promised anywhere from them.
 *
 * What a machine can honestly assert is asserted:
 *   - every agent in the workspace is actually rendered, so the scene is not
 *     quietly dropping figures as the team grows;
 *   - the frame loop keeps producing frames at each size rather than stalling;
 *   - the WebGL context survives 100 agents instead of falling back to the 2D list.
 *
 * The timings are written to artifacts/perf-agents.json so a later run on real
 * hardware has a baseline to compare against.
 */

const SCENARIOS = [10, 50, 100];
const SAMPLE_MS = 2000;
/** A frame loop that has stalled produces almost nothing; this only catches that. */
const MIN_FRAMES = 8;

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

/** Samples inter-frame gaps in the page for `ms`, then returns them. */
function sampleFrames(page, ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const gaps = [];
        let last = performance.now();
        const started = last;
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - started < duration) requestAnimationFrame(tick);
          else resolve(gaps);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

test("the office renders every agent at 10, 50 and 100 without stalling", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);

  // A dedicated workspace: the load scenarios must not leave 100 agents behind
  // in the demo workspace that every other spec reads.
  const created = await request.post("/api/workspaces", {
    data: { name: "Load scenarios" },
  });
  expect(created.ok()).toBeTruthy();
  const workspace = await created.json();
  const workspaceId = workspace.id ?? workspace.workspaceId;

  await page.goto("/");
  await expect(
    page.getByText("Live connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Switch workspace", { exact: true })
    .selectOption(workspaceId);

  const report = [];
  for (const target of SCENARIOS) {
    const existing = await (
      await request.get(`/api/workspaces/${workspaceId}/agents`)
    ).json();
    for (let i = existing.length; i < target; i += 1) {
      const response = await request.post(
        `/api/workspaces/${workspaceId}/agents`,
        {
          data: {
            name: `Load ${String(i + 1).padStart(3, "0")}`,
            role: "Load scenario",
            color: "#4a7dd0",
          },
        },
      );
      expect(response.ok(), `creating agent ${i + 1}`).toBeTruthy();
    }

    await page.reload();
    await expect(
      page.getByText("Live connection", { exact: true }),
    ).toBeVisible();

    // Every agent is drawn. This is the assertion that matters: a scene that
    // silently thins its own cast would post excellent frame times and be wrong.
    await expect(page.locator(".scene-label")).toHaveCount(target, {
      timeout: 30000,
    });
    // WebGL survived; we are measuring the 3D path, not the 2D fallback.
    await expect(page.locator(".scene-fallback")).toHaveCount(0);

    const gaps = await sampleFrames(page, SAMPLE_MS);
    expect(
      gaps.length,
      `the frame loop stalled at ${target} agents (${gaps.length} frames in ${SAMPLE_MS}ms)`,
    ).toBeGreaterThanOrEqual(MIN_FRAMES);

    const sorted = [...gaps].sort((a, b) => a - b);
    report.push({
      agents: target,
      frames: gaps.length,
      medianFrameMs: Number(percentile(sorted, 0.5).toFixed(2)),
      p95FrameMs: Number(percentile(sorted, 0.95).toFixed(2)),
      worstFrameMs: Number(sorted[sorted.length - 1].toFixed(2)),
    });
  }

  const dir = fileURLToPath(new URL("../artifacts/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}perf-agents.json`,
    `${JSON.stringify(
      {
        note: "SwiftShader software rendering in the Playwright harness. Relative regression signal only; not a capability claim and not a promised agent count.",
        renderer: "swiftshader",
        scenarios: report,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    report
      .map(
        (r) =>
          `${r.agents} agents: ${r.frames} frames, median ${r.medianFrameMs}ms, p95 ${r.p95FrameMs}ms`,
      )
      .join("\n"),
  );
});
