# Fake provider CLIs

Test doubles for the real provider binaries. They let the managed-runs module,
detection, and end-to-end tests exercise the exact stdout formats captured in
`tests/fixtures/providers/` without installing or invoking a real CLI.

Point detection and adapters at them with the binary override environment
variables (provider id upper-cased, `-` → `_`):

```
AGENT_SPACE_BIN_CLAUDE_CODE="node tests/fixtures/fake-cli/claude.js"
AGENT_SPACE_BIN_CODEX="node tests/fixtures/fake-cli/codex.js"
AGENT_SPACE_BIN_COPILOT="node tests/fixtures/fake-cli/copilot.js"
AGENT_SPACE_BIN_GEMINI="node tests/fixtures/fake-cli/gemini.js"
```

The override value is a command line (quotes honoured); relative paths resolve
against the server's working directory. Tests should use `process.execPath`
and an absolute script path to avoid depending on `node` being on PATH.

## Files (owned by the managed-runs module, E)

| File         | Replays                                               | Real command shape it imitates                                             |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `claude.js`  | `providers/claude-headless-stream.jsonl`              | `claude -p "<prompt>" --output-format stream-json --verbose [--resume id]` |
| `codex.js`   | `providers/codex-exec-stream-error.jsonl` (+ success) | `codex exec --json [-C cwd] [-s …] "<prompt>"` / `codex exec resume <id>`  |
| `copilot.js` | `providers/copilot-headless-stream.jsonl`             | `copilot -p "<prompt>" --output-format json --allow-all-tools [-C dir]`    |
| `gemini.js`  | a minimal documented `stream-json` sample             | `gemini -p "<prompt>" --output-format stream-json`                         |

## Contract every fake must honour

1. **`--version`** prints a single line containing a version token and exits 0,
   e.g. `2.1.266 (Claude Code)`, `codex-cli 0.152.1`, `1.0.80`, `0.9.0`.
   Detection (`packages/core/src/providers/detect.js`) parses the first
   version-looking token from stdout, so keep it on the first line.
2. **`-C <dir>` / `--cwd <dir>`** set the working directory the fake reports in
   its stream (Claude `system.init.cwd`, Codex `session_meta`/`turn_context.cwd`,
   Copilot `session.start.data.context.cwd`). When absent use `process.cwd()`.
   Windows paths must be passed through unchanged (backslashes, drive letter).
3. **Prompt** is the last positional argument or the value after `-p`. It must
   be echoed into the replayed `prompt`/`user.message` line so tests can assert
   the prompt reached the "provider".
4. **Stream replay** writes each fixture line to stdout as newline-delimited
   JSON, one line per `setTimeout` tick (a few ms apart) so line splitting and
   partial reads are exercised. Non-JSON noise may be written to **stderr**
   (Codex prints warnings there); never to stdout.
5. **Session id**: honour `--resume <id>` (Claude), `exec resume <id>` (Codex),
   `--resume <id>` / `--session-id <id>` (Copilot) by emitting that id in the
   session start line; otherwise emit the fixture's id.
6. **Exit codes**: `0` on success. `FAKE_CLI_FAIL=1` in the environment makes
   the fake emit the provider's error/`result` line with `is_error: true`
   (Claude), `turn.failed` (Codex), or `result` with non-zero `exitCode`
   (Copilot) and exit 1. `FAKE_CLI_HANG=1` keeps the process alive after the
   stream so cancellation and process-tree kills can be tested
   (`taskkill /pid <pid> /t /f` on win32).
7. **Stdin** must never be required; fakes run with `stdio: ["ignore","pipe","pipe"]`.
8. **No side effects**: fakes never write files outside `os.tmpdir()` and never
   read provider home directories.
9. **Auth**: fakes never emit or expect credentials. Detection's auth hint comes
   from the temp provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …), not from
   the fake.

Keep the fakes dependency-free (`node:` built-ins only) and ESM.
