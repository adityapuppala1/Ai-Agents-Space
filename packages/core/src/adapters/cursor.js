import { defineAdapter, tolerantParse, tolerantFinalize } from "./base.js";
import { InputError } from "../TaskStore.js";

const PROVIDER = "cursor";

/**
 * Cursor adapter: detect-only.
 *
 * `cursor-agent` is genuinely not installed on this machine — only the Cursor
 * IDE launcher (`cursor.cmd` 3.14.27), which cannot run a headless task. The
 * documented headless command (`cursor-agent -p "<prompt>"
 * --output-format stream-json`) has therefore never been observed here, so
 * `build()` refuses instead of producing a command line that would launch the
 * IDE. Observation stays experimental (conversation summaries only).
 */

export const CURSOR_LAUNCH_REFUSAL =
  "cursor-agent is not installed; the Cursor IDE launcher cannot run headless tasks";

export const CURSOR_INSTALL_FIX = "https://docs.cursor.com/en/cli";

export const cursorAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Cursor",
  capabilities: {
    launch: "unsupported",
    stream: "unknown",
    interrupt: "unknown",
    resume: "unsupported",
    approve: "unknown",
    reportModel: "unknown",
    reportUsage: "unknown",
    artifacts: "unknown",
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },
  supportsResume: false,
  launchBinaries: ["cursor-agent"],
  missingBinaryHint: CURSOR_LAUNCH_REFUSAL,
  refusal: CURSOR_LAUNCH_REFUSAL,
  fix: CURSOR_INSTALL_FIX,

  /** Always refuses: there is no verified headless Cursor CLI here. */
  build() {
    const error = new InputError(CURSOR_LAUNCH_REFUSAL, 409);
    error.fix = CURSOR_INSTALL_FIX;
    error.provider = PROVIDER;
    throw error;
  },

  /**
   * Kept tolerant so a future `cursor-agent` stream can be inspected without
   * pretending we know its vocabulary.
   */
  parse(line, state) {
    return tolerantParse(PROVIDER, line, state);
  },

  finalize(state, exitCode) {
    return tolerantFinalize(PROVIDER, state, exitCode);
  },
});

export default cursorAdapter;
