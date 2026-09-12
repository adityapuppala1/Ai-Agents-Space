import test from "node:test";
import assert from "node:assert/strict";
import { isOnFloor } from "../apps/web/src/office/choreography.js";
import { liveBeaconSurfaces } from "../apps/web/src/office/presence.js";

test("the 3D floor contains current work rather than the saved roster", () => {
  assert.equal(isOnFloor({ activity: "IDLE" }), false);
  assert.equal(isOnFloor({ activity: "STALE" }), false);
  assert.equal(isOnFloor({ activity: "CODING" }), true);
  assert.equal(isOnFloor({ activity: "BLOCKED" }), true);
  assert.equal(isOnFloor({ activity: "IDLE", activeProviderRun: true }), true);
});

test("provider beacons appear only for providers with live work", () => {
  const surfaces = [
    { provider: "claude-code", detected: true, liveSessions: 1 },
    { provider: "codex", detected: true, liveSessions: 0 },
    { provider: "cursor", detected: true, liveSessions: 0 },
    {
      provider: "antigravity",
      id: "antigravity-ide",
      detected: true,
      liveSessions: 0,
    },
    { provider: "gemini", detected: false, liveSessions: 0 },
  ];
  // Installed but idle products draw nothing; a live session or an active run
  // on the floor draws one beacon per provider.
  assert.deepEqual(
    liveBeaconSurfaces(surfaces, [
      { provider: "codex", activeProviderRun: true },
    ])
      .map((b) => b.provider)
      .sort(),
    ["claude-code", "codex"],
  );
  assert.deepEqual(
    liveBeaconSurfaces(surfaces, []).map((b) => b.provider),
    ["claude-code"],
  );
  assert.deepEqual(liveBeaconSurfaces([], []), []);
  // A managed run whose provider has no observed surface still gets a beacon.
  assert.deepEqual(
    liveBeaconSurfaces(
      [],
      [{ provider: "copilot", activeProviderRun: true }],
    ).map((b) => b.provider),
    ["copilot"],
  );
});
