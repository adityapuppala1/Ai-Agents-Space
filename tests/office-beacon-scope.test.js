import test from "node:test";
import assert from "node:assert/strict";
import {
  liveBeaconSurfaces,
  surfacesForWorkspace,
} from "../apps/web/src/office/presence.js";

/**
 * The office draws a beacon for an assistant with live work, labelled with its
 * live session count. That count came from observation's machine-wide
 * surfaces, so a Claude Code session belonging to one workspace put a glowing
 * "Claude Code · 1 live session" beacon on the floor of every other workspace
 * — including one where nothing was running at all. Seen 2026-09-15.
 *
 * A floor shows the work in its own workspace.
 */

const surfaces = [
  {
    id: "claude-code",
    provider: "claude-code",
    detected: true,
    liveSessions: 1,
  },
  { id: "codex", provider: "codex", detected: true, liveSessions: 0 },
];

test("a live session in another workspace draws no beacon here", () => {
  const sessions = [{ provider: "claude-code", workspaceId: "ai-agents-view" }];
  const here = surfacesForWorkspace(surfaces, sessions, "text-kit");
  assert.equal(here.find((s) => s.provider === "claude-code").liveSessions, 0);
  assert.deepEqual(liveBeaconSurfaces(here, []), []);

  const there = surfacesForWorkspace(surfaces, sessions, "ai-agents-view");
  assert.equal(there.find((s) => s.provider === "claude-code").liveSessions, 1);
  assert.deepEqual(
    liveBeaconSurfaces(there, []).map((s) => s.provider),
    ["claude-code"],
  );
});

test("sessions are counted per provider and per workspace", () => {
  const sessions = [
    { provider: "claude-code", workspaceId: "text-kit" },
    { providerId: "claude-code", workspaceId: "text-kit" },
    { provider: "codex", workspaceId: "text-kit" },
    { provider: "codex", workspaceId: "elsewhere" },
  ];
  const here = surfacesForWorkspace(surfaces, sessions, "text-kit");
  assert.deepEqual(
    here.map((s) => [s.provider, s.liveSessions]),
    [
      ["claude-code", 2],
      ["codex", 1],
    ],
  );
});

test("an active run on this floor still draws its beacon, as a managed run", () => {
  const here = surfacesForWorkspace(surfaces, [], "text-kit");
  const beacons = liveBeaconSurfaces(here, [
    { provider: "claude-code", activeProviderRun: true },
  ]);
  assert.deepEqual(
    beacons.map((s) => s.provider),
    ["claude-code"],
  );
  // The label then reads "managed run", not a session count it does not have.
  assert.equal(beacons[0].liveSessions, 0);
});

test("without a workspace the surfaces pass through unchanged", () => {
  assert.deepEqual(surfacesForWorkspace(surfaces, [], null), surfaces);
});

test("the surfaces it is given are not modified", () => {
  const before = JSON.stringify(surfaces);
  surfacesForWorkspace(
    surfaces,
    [{ provider: "codex", workspaceId: "text-kit" }],
    "text-kit",
  );
  assert.equal(JSON.stringify(surfaces), before);
});
