import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCmdShim,
  assertShellSafe,
  spawnProvider,
  resolveBinary,
  needsShell,
} from "../packages/core/src/runs/process.js";

const WIN = process.platform === "win32";

/** npm's cmd-shim output, verbatim from %APPDATA%\npm\copilot.cmd. */
const SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*',
  "",
].join("\r\n");

/** A fake npm global folder: extension-less POSIX shim + .cmd shim + script. */
function fakeNpmDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-space-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "node_modules", "@github", "copilot");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "npm-loader.js"),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
  );
  writeFileSync(join(dir, "copilot.cmd"), SHIM);
  writeFileSync(
    join(dir, "copilot"),
    '#!/bin/sh\nexec node "$basedir/node_modules/@github/copilot/npm-loader.js" "$@"\n',
  );
  return {
    dir,
    shim: join(dir, "copilot.cmd"),
    script: join(pkg, "npm-loader.js"),
  };
}

test("resolveCmdShim maps an npm .cmd shim to node + the wrapped script", (t) => {
  const { dir, shim, script } = fakeNpmDir(t);
  const resolved = resolveCmdShim(shim);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [script]);
  assert.equal(resolveCmdShim(join(dir, "copilot")), null, "not a .cmd");
  assert.equal(resolveCmdShim(join(dir, "missing.cmd")), null);
  writeFileSync(join(dir, "other.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  assert.equal(resolveCmdShim(join(dir, "other.cmd")), null, "not a Node shim");
  writeFileSync(
    join(dir, "gone.cmd"),
    '@echo off\r\nnode "%dp0%\\node_modules\\gone\\cli.js" %*\r\n',
  );
  assert.equal(resolveCmdShim(join(dir, "gone.cmd")), null, "script missing");
});

test("assertShellSafe refuses text cmd.exe would rewrite or split", () => {
  assert.doesNotThrow(() => assertShellSafe(["-p", "plain prompt", "--json"]));
  for (const bad of [
    'Fix the " & echo INJECTED & echo " button',
    "hello %USERNAME%",
    "delayed !VAR!",
    "line1\nline2",
    "cr\rlf",
  ])
    assert.throws(
      () => assertShellSafe(["-p", bad]),
      (error) => error.status === 409 && /cmd\.exe/.test(error.message),
      bad,
    );
});

test(
  "spawnProvider runs a .cmd shim as node <script> so quotes, %VAR% and newlines reach the child intact",
  { skip: !WIN && "cmd.exe shims only exist on Windows" },
  async (t) => {
    const { shim } = fakeNpmDir(t);
    assert.equal(needsShell(shim), true);
    const prompt =
      'Fix the " & echo INJECTED_COMMAND_RAN & echo " button\nsecond line %USERNAME% !x!';
    const lines = [];
    const exit = await new Promise((resolve) => {
      spawnProvider({
        command: shim,
        args: ["-p", prompt, "--output-format", "json"],
        cwd: tmpdir(),
        onLine: (line) => lines.push(line),
        onExit: (code, signal, error) => resolve({ code, signal, error }),
      });
    });
    assert.equal(exit.error, null);
    assert.equal(exit.code, 0);
    assert.deepEqual(JSON.parse(lines[0]), [
      "-p",
      prompt,
      "--output-format",
      "json",
    ]);
    // Exactly the argv echo: cmd.exe never ran the injected `echo`.
    assert.equal(lines.length, 1);
  },
);

test(
  "spawnProvider refuses a .bat it cannot resolve when an argument is unsafe for cmd.exe",
  { skip: !WIN && "cmd.exe shims only exist on Windows" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "agent-space-bat-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bat = join(dir, "tool.bat");
    writeFileSync(bat, "@echo off\r\necho %*\r\n");
    assert.throws(
      () =>
        spawnProvider({
          command: bat,
          args: ["-p", 'a " & echo pwned'],
          cwd: dir,
        }),
      /cmd\.exe/,
    );
    // Plain arguments still work through the shell path.
    const lines = [];
    await new Promise((resolve) => {
      spawnProvider({
        command: bat,
        args: ["-p", "plain words"],
        cwd: dir,
        onLine: (line) => lines.push(line),
        onExit: resolve,
      });
    });
    assert.match(lines.join("\n"), /-p "plain words"/);
  },
);

test(
  "resolveBinary picks the PATHEXT executable over the extension-less npm shim",
  { skip: !WIN && "`where` and PATHEXT are Windows-only" },
  (t) => {
    const { dir, shim } = fakeNpmDir(t);
    const key = Object.keys(process.env).find(
      (k) => k.toLowerCase() === "path",
    );
    const previous = process.env[key];
    process.env[key] = `${dir};${previous}`;
    t.after(() => {
      process.env[key] = previous;
    });
    const env = { ...process.env };
    delete env.AGENT_SPACE_BIN_COPILOT;
    const found = resolveBinary("copilot", env, { noCache: true });
    assert.equal(found.resolved, true);
    assert.equal(found.command.toLowerCase(), shim.toLowerCase());
  },
);
