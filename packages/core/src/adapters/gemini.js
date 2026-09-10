import { randomUUID } from "node:crypto";
import {
  defineAdapter,
  tolerantParse,
  tolerantFinalize,
  event,
  clip,
  permissionsFor,
} from "./base.js";
import { GEMINI_AUTH_FIX } from "../providers/detect.js";

const PROVIDER = "gemini";

/**
 * Gemini CLI adapter (gemini 0.59.0).
 *
 * The command line below is VERIFIED: every flag was read from the CLI's own
 * `gemini --help` on this machine on 2026-09-09.
 *
 *   gemini -p "<prompt>" -o stream-json
 *          --approval-mode plan | auto_edit | yolo      (autonomy preset)
 *          [-m <model>] [--include-directories a,b]
 *          [--session-id <uuid>]        new run, so events can be correlated
 *          [-r <id|latest>]             resume
 *
 * `--skip-trust` is never passed automatically: skipping the folder-trust
 * prompt is a security decision that belongs to the user.
 *
 * What is NOT verified: an authenticated run. The CLI on this machine has no
 * auth method configured and every invocation exits 41 printing a JSON error
 * envelope on stderr, so the stream vocabulary, usage, and model reporting
 * stay `unknown` and the parser stays tolerant.
 */

export const AUTONOMY_APPROVAL_MODE = {
  propose: "plan",
  scoped: "auto_edit",
  sandbox: "yolo",
};

/** Exit code the CLI uses for "no auth method configured". */
export const AUTH_EXIT_CODE = 41;

export const AUTH_FIX = GEMINI_AUTH_FIX;

/**
 * Recognizes the JSON error envelope the CLI prints (on stderr) when it
 * cannot run: `{"session_id":"…","error":{"type","message","code"}}`.
 * Returns `{ sessionId, code, message, category }` or null.
 */
export function parseErrorEnvelope(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || !record.error) return null;
  const error = record.error;
  const message =
    typeof error === "string" ? error : (error.message ?? "Gemini failed");
  const code = typeof error === "object" ? (error.code ?? null) : null;
  const authenticationProblem =
    code === AUTH_EXIT_CODE || /set an auth method/i.test(String(message));
  return {
    sessionId: record.session_id ?? record.sessionId ?? null,
    code,
    message: String(message),
    category: authenticationProblem ? "not-logged-in" : "unknown",
  };
}

export const geminiAdapter = defineAdapter({
  id: PROVIDER,
  provider: PROVIDER,
  name: "Gemini",
  capabilities: {
    // Flags verified from `gemini --help`; no authenticated run observed.
    launch: "experimental",
    stream: "unknown",
    interrupt: "unknown",
    resume: "unknown",
    approve: "unknown",
    reportModel: "unknown",
    reportUsage: "unknown",
    // "unknown", not "verified": no Gemini run has ever completed on this
    // machine, so no artifact has been produced by one. providers/registry.js
    // is the single source capabilityMatrix() uses and it keeps every Gemini
    // capability unknown apart from launch/observe.
    artifacts: "unknown",
    attach: "unsupported",
    fork: "unknown",
    delegate: "unknown",
  },
  supportsResume: false,
  launchNote:
    "Gemini launch flags are verified from the CLI's own --help (0.59.0). No completed run has been observed on this machine: the CLI is not authenticated and exits 41.",

  build({
    prompt,
    binary,
    cwd,
    model,
    policy,
    extraDirs = [],
    resumeSessionId = null,
    sessionId = null,
  }) {
    const args = [...(binary.args ?? [])];
    args.push("-p", prompt, "-o", "stream-json");
    const perms = permissionsFor(policy);
    args.push(
      "--approval-mode",
      AUTONOMY_APPROVAL_MODE[perms.autonomy] ?? "plan",
    );
    if (model) args.push("-m", String(model));
    if (extraDirs.length)
      args.push("--include-directories", extraDirs.join(","));
    if (resumeSessionId) args.push("-r", String(resumeSessionId));
    else args.push("--session-id", sessionId ?? randomUUID());
    return { command: binary.command, args, cwd, stdin: "ignore" };
  },

  parse(line, state) {
    const envelope = parseErrorEnvelope(line);
    if (envelope) {
      if (envelope.sessionId) state.sessionId = envelope.sessionId;
      state.errorCategory = envelope.category;
      state.error =
        envelope.category === "not-logged-in"
          ? `Gemini is not signed in (exit ${envelope.code ?? AUTH_EXIT_CODE}). ${AUTH_FIX}`
          : envelope.message;
      return [
        event(PROVIDER, {
          providerEventId: envelope.sessionId
            ? `${PROVIDER}:${envelope.sessionId}:error`
            : null,
          sessionId: state.sessionId ?? null,
          kind: "error",
          summary: clip(
            envelope.category === "not-logged-in"
              ? "Gemini is not signed in; no work was done"
              : envelope.message,
            200,
          ),
          data: {
            errorCategory: envelope.category,
            code: envelope.code,
            message: envelope.message.slice(0, 1000),
            fix: envelope.category === "not-logged-in" ? AUTH_FIX : null,
          },
        }),
      ];
    }
    return tolerantParse(PROVIDER, line, state);
  },

  finalize(state, exitCode) {
    if (state.errorCategory === "not-logged-in" || exitCode === AUTH_EXIT_CODE)
      return {
        status: "failed",
        errorCategory: "not-logged-in",
        error:
          state.error ??
          `Gemini is not signed in (exit ${AUTH_EXIT_CODE}). ${AUTH_FIX}`,
        fix: AUTH_FIX,
        usage: state.usage ?? null,
        cost: null,
        sessionId: state.sessionId ?? null,
        model: state.model ?? null,
        finalText: null,
      };
    const final = tolerantFinalize(PROVIDER, state, exitCode);
    if (state.errorCategory) final.errorCategory = state.errorCategory;
    return final;
  },
});

export default geminiAdapter;
