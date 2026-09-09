import { defineAdapter, tolerantParse, tolerantFinalize } from "./base.js";

const PROVIDER = "cursor";

/**
 * Cursor adapter. `cursor-agent -p "<prompt>" --output-format stream-json`
 * follows Cursor's docs but the CLI is not installed here, so the adapter is
 * `experimental`: the command is built as documented and the parser accepts
 * any JSON line. When the binary is missing the worker refuses the launch
 * with "install cursor-agent for managed runs".
 */
export const cursorAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Cursor",
  capabilities: {
    launch: "experimental",
    stream: "experimental",
    interrupt: "experimental",
    resume: "unsupported",
    approve: "unknown",
    reportModel: "unknown",
    reportUsage: "unknown",
    artifacts: "verified",
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },
  supportsResume: false,
  launchBinaries: ["cursor-agent"],
  missingBinaryHint: "install cursor-agent for managed runs",

  build({ prompt, binary, cwd, model, policy }) {
    const args = [...(binary.args ?? [])];
    args.push("-p", prompt, "--output-format", "stream-json");
    if (model) args.push("--model", String(model));
    if (policy?.autonomy && policy.autonomy !== "propose") args.push("--force");
    return { command: binary.command, args, cwd, stdin: "ignore" };
  },

  parse(line, state) {
    return tolerantParse(PROVIDER, line, state);
  },

  finalize(state, exitCode) {
    return tolerantFinalize(PROVIDER, state, exitCode);
  },
});

export default cursorAdapter;
