import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Detection-only assistant surfaces. These are deliberately separate from
 * executable provider adapters: finding a binary or config directory never
 * grants Agent Space permission to launch it or claim access to its events.
 */
export const PASSIVE_SURFACES = Object.freeze([
  {
    id: "antigravity-cli",
    provider: "antigravity",
    label: "Google Antigravity CLI",
    kind: "cli",
    binaries: ["agy"],
    homes: [],
  },
  {
    id: "antigravity-ide",
    provider: "antigravity",
    label: "Google Antigravity IDE",
    kind: "ide",
    binaries: ["agy-ide"],
    homes: [".gemini/antigravity"],
  },
  {
    id: "opencode-cli",
    provider: "opencode",
    label: "OpenCode",
    kind: "cli",
    binaries: ["opencode"],
    homes: [".config/opencode", ".opencode"],
  },
  {
    id: "aider-cli",
    provider: "aider",
    label: "Aider",
    kind: "cli",
    binaries: ["aider"],
    homes: [".aider"],
  },
  {
    id: "windsurf-ide",
    provider: "windsurf",
    label: "Windsurf",
    kind: "ide",
    binaries: ["windsurf"],
    homes: [".codeium/windsurf"],
  },
]);

function executableNames(name, platform, env) {
  if (platform !== "win32") return [name];
  const extensions = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function findBinary(names, { env, platform }) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  for (const folder of String(pathValue).split(separator).filter(Boolean)) {
    for (const name of names) {
      for (const candidate of executableNames(name, platform, env)) {
        const file = join(folder.replace(/^"|"$/g, ""), candidate);
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}

export function detectPassiveSurfaces({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  return PASSIVE_SURFACES.map((surface) => {
    const binaryPath = findBinary(surface.binaries, { env, platform });
    const homePath = surface.homes
      .map((relative) => join(home, ...relative.split("/")))
      .find((candidate) => existsSync(candidate));
    return {
      ...surface,
      detected: Boolean(binaryPath || homePath),
      binaryDetected: Boolean(binaryPath),
      dataDetected: Boolean(homePath),
      observable: false,
      fidelity: "installation-detection",
      liveSessions: 0,
      note: binaryPath
        ? `${surface.label} command detected. No verified event adapter is installed.`
        : homePath
          ? `${surface.label} data directory detected. No verified event adapter is installed.`
          : `${surface.label} was not detected on this host.`,
    };
  });
}
