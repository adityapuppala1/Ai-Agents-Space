import { defineAdapter, tolerantParse, tolerantFinalize } from "./base.js";

const PROVIDER = "gemini";

/**
 * Gemini CLI adapter. The command follows the public docs
 * (`gemini -p "<prompt>" --output-format stream-json`) but was not verified on
 * this machine (the CLI is not installed), so every capability is `unknown`
 * and the parser is tolerant of any JSON shape.
 */
export const geminiAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Gemini",
  capabilities: {
    launch: "unknown",
    stream: "unknown",
    interrupt: "unknown",
    resume: "unsupported",
    approve: "unknown",
    reportModel: "unknown",
    reportUsage: "unknown",
    artifacts: "verified", // git diff after the run does not depend on the provider
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },
  supportsResume: false,

  build({ prompt, binary, cwd, model, policy, extraDirs = [] }) {
    const args = [...(binary.args ?? [])];
    args.push("-p", prompt, "--output-format", "stream-json");
    if (model) args.push("--model", String(model));
    if (policy?.autonomy && policy.autonomy !== "propose") args.push("--yolo");
    for (const dir of extraDirs) args.push("--include-directories", dir);
    return { command: binary.command, args, cwd, stdin: "ignore" };
  },

  parse(line, state) {
    return tolerantParse(PROVIDER, line, state);
  },

  finalize(state, exitCode) {
    return tolerantFinalize(PROVIDER, state, exitCode);
  },
});

export default geminiAdapter;
