/**
 * Extension manifests (roadmap §16, "Extension model").
 *
 * WHAT THIS BUILD DOES AND DOES NOT DO
 * ------------------------------------
 * This module describes and validates extensions. It NEVER loads or executes
 * one. There is no plugin loader in Agent Space: `registry.js` records what an
 * extension claims, what permissions it would need, and whether a workspace
 * opted in. Executable extensions are deferred until isolation exists.
 *
 * A signature and a checksum establish WHO published the bytes and that the
 * bytes did not change in transit. They are not evidence that the code is
 * safe, correct, or does what the manifest says. Nothing in this file, and
 * nothing in the UI, may present a valid signature as a safety verdict.
 *
 * Manifest shape (version 1):
 *
 *   {
 *     id, name,
 *     kind: "provider-adapter" | "workflow-adapter" | "tool-connector"
 *         | "role-pack" | "visual-theme",
 *     version: "<semver>",
 *     publisher: { name, contact, url },
 *     license: "<SPDX-ish string>",
 *     compatibility: { agentSpace: "<semver range>", os: ["win32", ...] },
 *     capabilities: [string],
 *     permissions: {
 *       filesystem: "none" | "read" | "write",
 *       network: [destination],        // host names, or "*" for anywhere
 *       shell: boolean,
 *       providers: [provider id]
 *     },
 *     configurationSchema: <JSON Schema subset> | null,
 *     updateChannel: "stable" | "beta",
 *     checksum: "sha256:<hex>" | null,
 *     signature: { publisher, algorithm, keyId, value } | null
 *   }
 */

import { createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { PROVIDERS } from "../contracts.js";
import { validateSchemaDocument } from "../workflows/contracts.js";

/** The manifest format version this build reads and writes. */
export const MANIFEST_VERSION = 1;

/**
 * Extension kinds, each with its own trust model. `executable` marks the kinds
 * that would run code in the Agent Space process: those are refused for
 * install-and-load in this build and recorded as declaration only.
 */
export const EXTENSION_KINDS = Object.freeze({
  "provider-adapter": {
    executable: true,
    detail:
      "Launches a provider CLI and parses its stream. Highest trust: it spawns processes and sees every prompt and file path.",
    reviewNeeded: "process spawn, argument construction, secret handling",
  },
  "workflow-adapter": {
    executable: true,
    detail:
      "Imports status and artifacts from an external workflow engine. The external engine stays authoritative.",
    reviewNeeded:
      "network destinations, credential handling, duplicate dispatch",
  },
  "tool-connector": {
    executable: true,
    detail:
      "Reads or writes an external system (issues, storage, CI, database).",
    reviewNeeded: "network destinations, write scope, OAuth scopes",
  },
  "role-pack": {
    executable: false,
    detail:
      "Data only: role definitions and workflow templates. Validated by workflows/templates/index.js, never executed.",
    reviewNeeded: "no secrets, no private paths, objective acceptance criteria",
  },
  "visual-theme": {
    executable: false,
    detail:
      "Data only: colours, geometry presets, and labels for the office scene.",
    reviewNeeded: "no remote asset URLs",
  },
});

export const KIND_NAMES = Object.freeze(Object.keys(EXTENSION_KINDS));

export const UPDATE_CHANNELS = Object.freeze(["stable", "beta"]);
export const FILESYSTEM_LEVELS = Object.freeze(["none", "read", "write"]);
/** Ordered least → most privileged, for permission comparison. */
const FS_RANK = { none: 0, read: 1, write: 2 };

export const SUPPORTED_OS = Object.freeze(["win32", "linux", "darwin"]);

export const DEFAULT_PERMISSIONS = Object.freeze({
  filesystem: "none",
  network: [],
  shell: false,
  providers: [],
});

/* -------------------------------------------------------------- semver -- */

/** Parses "1.2.3" / "1.2.3-beta.1" → { major, minor, patch, pre } or null. */
export function parseSemver(value) {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(value ?? "").trim(),
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

/** -1, 0, 1. A prerelease sorts before its release (1.0.0-beta < 1.0.0). */
export function compareSemver(a, b) {
  const left = typeof a === "string" ? parseSemver(a) : a;
  const right = typeof b === "string" ? parseSemver(b) : b;
  if (!left || !right)
    throw new InputError(`Not a semantic version: ${!left ? a : b}`);
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field])
      return left[field] < right[field] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function upperBoundFor(operator, version) {
  const parsed = parseSemver(version);
  if (!parsed) return null;
  if (operator === "^")
    return parsed.major > 0
      ? { major: parsed.major + 1, minor: 0, patch: 0, pre: null }
      : parsed.minor > 0
        ? { major: 0, minor: parsed.minor + 1, patch: 0, pre: null }
        : { major: 0, minor: 0, patch: parsed.patch + 1, pre: null };
  // "~1.2.3" → < 1.3.0
  return { major: parsed.major, minor: parsed.minor + 1, patch: 0, pre: null };
}

function satisfiesComparator(version, comparator) {
  const text = comparator.trim();
  if (!text || text === "*" || text === "x") return true;
  const caret = /^([\^~])(.+)$/.exec(text);
  if (caret) {
    const base = parseSemver(caret[2]);
    const upper = upperBoundFor(caret[1], caret[2]);
    if (!base || !upper)
      throw new InputError(`Unreadable version range "${comparator}"`);
    return (
      compareSemver(version, base) >= 0 && compareSemver(version, upper) < 0
    );
  }
  const wildcard = /^(\d+)\.(?:x|\*)(?:\.(?:x|\*))?$/.exec(text);
  if (wildcard) {
    const major = Number(wildcard[1]);
    return version.major === major;
  }
  const minorWildcard = /^(\d+)\.(\d+)\.(?:x|\*)$/.exec(text);
  if (minorWildcard)
    return (
      version.major === Number(minorWildcard[1]) &&
      version.minor === Number(minorWildcard[2])
    );
  const compare = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(text);
  const operator = compare[1] ?? "=";
  const target = parseSemver(compare[2]);
  if (!target) throw new InputError(`Unreadable version range "${comparator}"`);
  const result = compareSemver(version, target);
  switch (operator) {
    case ">=":
      return result >= 0;
    case "<=":
      return result <= 0;
    case ">":
      return result > 0;
    case "<":
      return result < 0;
    default:
      return result === 0;
  }
}

/**
 * Hand-written semver range check (no packages). Supports:
 *   "*", "1.2.3", ">=1.2.0", "<2.0.0", "^1.2.3", "~1.2.3", "1.x", "1.2.x",
 *   space-separated AND ("(>=1.2.0 <2.0.0"), and "||" for OR.
 */
export function satisfiesRange(version, range) {
  const parsed = parseSemver(version);
  if (!parsed) throw new InputError(`Not a semantic version: ${version}`);
  const text = String(range ?? "").trim();
  if (!text) throw new InputError("A compatibility range is required");
  return text.split("||").some((group) =>
    group
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => satisfiesComparator(parsed, comparator)),
  );
}

/* ------------------------------------------------------------ validation - */

function str(value, field, { max = 200, required = true } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new InputError(`manifest.${field} is required`);
    return null;
  }
  if (text.length > max)
    throw new InputError(`manifest.${field} is longer than ${max} characters`);
  return text;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const DESTINATION_PATTERN = /^(\*|[a-z0-9.*-]+(:\d{1,5})?(\/[^\s]*)?)$/i;

/** Validates permissions, filling in the deny-all defaults. */
export function validatePermissions(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new InputError("manifest.permissions must be an object");
  const filesystem = input.filesystem ?? DEFAULT_PERMISSIONS.filesystem;
  if (!FILESYSTEM_LEVELS.includes(filesystem))
    throw new InputError(
      `manifest.permissions.filesystem must be one of ${FILESYSTEM_LEVELS.join(", ")}`,
    );
  const network = input.network ?? [];
  if (!Array.isArray(network))
    throw new InputError(
      "manifest.permissions.network must be an array of destinations",
    );
  const destinations = network.map((entry) => {
    const text = String(entry ?? "").trim();
    if (!text || !DESTINATION_PATTERN.test(text))
      throw new InputError(
        `manifest.permissions.network entry ${JSON.stringify(entry)} is not a host, host:port, or "*"`,
      );
    return text.toLowerCase();
  });
  if (typeof (input.shell ?? false) !== "boolean")
    throw new InputError("manifest.permissions.shell must be true or false");
  const providers = input.providers ?? [];
  if (!Array.isArray(providers))
    throw new InputError("manifest.permissions.providers must be an array");
  for (const provider of providers)
    if (!PROVIDERS[provider])
      throw new InputError(
        `manifest.permissions.providers names unknown provider ${provider}`,
      );
  return {
    filesystem,
    network: [...new Set(destinations)],
    shell: input.shell === true,
    providers: [...new Set(providers)],
  };
}

/** Validates and normalizes a manifest. Throws InputError with a plain reason. */
export function validateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("A manifest must be an object");
  const manifestVersion = input.manifestVersion ?? MANIFEST_VERSION;
  if (manifestVersion !== MANIFEST_VERSION)
    throw new InputError(
      `manifest.manifestVersion ${manifestVersion} is not supported; this build reads version ${MANIFEST_VERSION}`,
    );
  const id = str(input.id, "id", { max: 64 });
  if (!ID_PATTERN.test(id))
    throw new InputError(
      "manifest.id must be lower-case letters, digits, dots, or hyphens",
    );
  const kind = str(input.kind, "kind", { max: 40 });
  if (!KIND_NAMES.includes(kind))
    throw new InputError(
      `manifest.kind must be one of ${KIND_NAMES.join(", ")}`,
    );
  const version = str(input.version, "version", { max: 40 });
  if (!parseSemver(version))
    throw new InputError(
      `manifest.version "${version}" is not a semantic version`,
    );

  const publisherInput = input.publisher;
  if (
    !publisherInput ||
    typeof publisherInput !== "object" ||
    Array.isArray(publisherInput)
  )
    throw new InputError("manifest.publisher must be an object with a name");
  const publisher = {
    name: str(publisherInput.name, "publisher.name", { max: 120 }),
    contact: str(publisherInput.contact, "publisher.contact", {
      max: 200,
      required: false,
    }),
    url: str(publisherInput.url, "publisher.url", {
      max: 300,
      required: false,
    }),
  };

  const compatibilityInput = input.compatibility;
  if (
    !compatibilityInput ||
    typeof compatibilityInput !== "object" ||
    Array.isArray(compatibilityInput)
  )
    throw new InputError("manifest.compatibility must be an object");
  const agentSpace = str(
    compatibilityInput.agentSpace,
    "compatibility.agentSpace",
    { max: 80 },
  );
  // Parsed now so a broken range fails at install time, not at update time.
  satisfiesRange("0.0.0", agentSpace);
  const os = compatibilityInput.os ?? [...SUPPORTED_OS];
  if (!Array.isArray(os) || os.length === 0)
    throw new InputError("manifest.compatibility.os must be a non-empty array");
  for (const platform of os)
    if (!SUPPORTED_OS.includes(platform))
      throw new InputError(
        `manifest.compatibility.os names unknown platform ${platform}`,
      );

  const capabilities = input.capabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((entry) => typeof entry !== "string")
  )
    throw new InputError("manifest.capabilities must be an array of strings");

  const updateChannel = input.updateChannel ?? "stable";
  if (!UPDATE_CHANNELS.includes(updateChannel))
    throw new InputError(
      `manifest.updateChannel must be one of ${UPDATE_CHANNELS.join(", ")}`,
    );

  const checksum =
    input.checksum === undefined || input.checksum === null
      ? null
      : String(input.checksum).trim();
  if (checksum && !/^sha256:[a-f0-9]{64}$/i.test(checksum))
    throw new InputError(
      'manifest.checksum must look like "sha256:<64 hex characters>"',
    );

  let signature = null;
  if (input.signature !== undefined && input.signature !== null) {
    const raw = input.signature;
    if (typeof raw !== "object" || Array.isArray(raw))
      throw new InputError("manifest.signature must be an object or null");
    signature = {
      publisher: str(raw.publisher, "signature.publisher", { max: 120 }),
      algorithm: str(raw.algorithm, "signature.algorithm", { max: 40 }),
      keyId: str(raw.keyId, "signature.keyId", { max: 120, required: false }),
      value: str(raw.value, "signature.value", { max: 4096 }),
      // Stated on every signed record so nobody reads a signature as safety.
      means: "publisher and integrity only; not a safety review",
    };
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    id,
    name: str(input.name, "name", { max: 120 }),
    kind,
    version,
    publisher,
    license: str(input.license, "license", { max: 80 }),
    description:
      str(input.description, "description", { max: 500, required: false }) ??
      "",
    compatibility: { agentSpace, os: [...new Set(os)] },
    capabilities: [
      ...new Set(capabilities.map((entry) => entry.trim()).filter(Boolean)),
    ].slice(0, 64),
    permissions: validatePermissions(input.permissions ?? {}),
    configurationSchema: validateSchemaDocument(
      input.configurationSchema ?? null,
      "configurationSchema",
    ),
    updateChannel,
    checksum,
    signature,
    executable: EXTENSION_KINDS[kind].executable,
  };
}

/* ------------------------------------------------------------ permissions */

function listDiff(before, after) {
  const added = after.filter((entry) => !before.includes(entry));
  const removed = before.filter((entry) => !after.includes(entry));
  return { added, removed };
}

/**
 * Permission difference between two manifests, for a staged update.
 *
 * → { escalates, added: {...}, removed: {...}, summary: [plain lines] }
 *
 * `escalates` is true when the new manifest asks for anything the old one did
 * not. A staged update that escalates must be accepted by a human before it
 * replaces the pinned version.
 */
export function diffPermissions(oldManifest, newManifest) {
  const before = oldManifest?.permissions ?? DEFAULT_PERMISSIONS;
  const after = newManifest?.permissions ?? DEFAULT_PERMISSIONS;
  const summary = [];
  const added = { network: [], providers: [] };
  const removed = { network: [], providers: [] };
  let escalates = false;

  if (FS_RANK[after.filesystem] > FS_RANK[before.filesystem]) {
    escalates = true;
    added.filesystem = after.filesystem;
    summary.push(
      `Filesystem access widens from ${before.filesystem} to ${after.filesystem}`,
    );
  } else if (FS_RANK[after.filesystem] < FS_RANK[before.filesystem]) {
    removed.filesystem = before.filesystem;
    summary.push(
      `Filesystem access narrows from ${before.filesystem} to ${after.filesystem}`,
    );
  }

  const network = listDiff(before.network ?? [], after.network ?? []);
  added.network = network.added;
  removed.network = network.removed;
  if (network.added.length) {
    escalates = true;
    summary.push(`New network destinations: ${network.added.join(", ")}`);
  }
  if (network.removed.length)
    summary.push(`No longer contacts: ${network.removed.join(", ")}`);

  if (after.shell && !before.shell) {
    escalates = true;
    added.shell = true;
    summary.push("Now asks to run shell commands");
  } else if (!after.shell && before.shell) {
    removed.shell = true;
    summary.push("No longer asks to run shell commands");
  }

  const providers = listDiff(before.providers ?? [], after.providers ?? []);
  added.providers = providers.added;
  removed.providers = providers.removed;
  if (providers.added.length) {
    escalates = true;
    summary.push(`New provider access: ${providers.added.join(", ")}`);
  }
  if (providers.removed.length)
    summary.push(`No longer touches: ${providers.removed.join(", ")}`);

  if (!summary.length) summary.push("No permission change");
  return { escalates, added, removed, summary };
}

/** Plain-language summary of what a manifest would be allowed to do. */
export function describePermissions(manifest) {
  const permissions = manifest?.permissions ?? DEFAULT_PERMISSIONS;
  const lines = [
    `Filesystem: ${permissions.filesystem}`,
    permissions.network.length
      ? `Network: ${permissions.network.join(", ")}`
      : "Network: none requested",
    `Shell commands: ${permissions.shell ? "yes" : "no"}`,
    permissions.providers.length
      ? `Providers: ${permissions.providers.join(", ")}`
      : "Providers: none requested",
  ];
  return lines;
}

/** sha256 of bytes, formatted the way a manifest checksum is written. */
export function checksumOf(bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(String(bytes ?? ""), "utf8");
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}
