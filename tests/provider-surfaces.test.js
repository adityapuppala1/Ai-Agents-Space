import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPassiveSurfaces } from "../packages/core/src/providers/surfaces.js";

test("passive discovery finds a POSIX CLI without claiming event access", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-space-surfaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "opencode"), "fixture");
  const result = detectPassiveSurfaces({
    env: { PATH: root },
    platform: "linux",
    home: join(root, "home"),
  }).find((surface) => surface.id === "opencode-cli");
  assert.equal(result.detected, true);
  assert.equal(result.binaryDetected, true);
  assert.equal(result.observable, false);
  assert.equal(result.liveSessions, 0);
});

test("passive discovery handles Windows PATHEXT and data-only IDEs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-space-surfaces-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  writeFileSync(join(bin, "agy.cmd"), "fixture");
  const results = detectPassiveSurfaces({
    env: { PATH: bin, PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    home,
  });
  assert.equal(
    results.find((item) => item.id === "antigravity-cli").binaryDetected,
    true,
  );
  assert.equal(
    results.find((item) => item.id === "antigravity-ide").dataDetected,
    true,
  );
});
