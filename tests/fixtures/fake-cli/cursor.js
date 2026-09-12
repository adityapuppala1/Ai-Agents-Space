#!/usr/bin/env node
/**
 * Fake Cursor Agent CLI for tests. It answers `--version` only, so detection
 * in browser tests never runs the real `cursor` launcher that the Cursor IDE
 * puts on PATH. Managed Cursor runs are experimental and no test launches one;
 * any other invocation fails loudly instead of pretending to work.
 */
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2025.09.04 [fake cursor-agent]");
  process.exit(0);
}
process.stderr.write(
  "fake cursor-agent: only --version is implemented; no test launches Cursor.\n",
);
process.exit(1);
