import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The fixtures are genuine recorded provider sessions, and that is the point:
 * a parser tested against invented input is tested against the author's
 * assumptions rather than the vendor's actual format. The cost is that a
 * recording carries whatever was on the machine that made it, and this
 * repository is public.
 *
 * These rules describe the SHAPE of a leak rather than listing the values that
 * leaked once. Naming them would re-introduce them into the repository, and
 * would only ever catch the mistake already made — not the next one, recorded
 * on a different machine by a different person.
 *
 * Adding a name to an allowlist here is meant to be a deliberate act. If a
 * test below fails, sanitise the recording; do not widen the list to make the
 * red go away.
 */

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Account names a fixture may claim to have been recorded under. */
const SYNTHETIC_IDENTITIES = new Set([
  "dev",
  "me",
  "user",
  "test",
  "example",
  "example-org",
  "agent",
  "runner",
  "ci",
  "Public",
  "All Users",
  "Default",
]);

/** Hosts a fixture may mention. Anything else is a deliberate addition. */
const KNOWN_HOSTS = new Set([
  "dev.azure.com",
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
  "example.com",
  "example.invalid",
]);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

function readable(file) {
  try {
    const text = readFileSync(file, "utf8");
    // Skip anything that is actually binary.
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

const ALL = files(fixtures)
  .map((file) => ({ file, text: readable(file) }))
  .filter((entry) => entry.text !== null);

test("the fixtures exist and are being read", () => {
  // A hygiene suite that silently scans nothing is worse than no suite: it
  // reports success forever.
  assert.ok(ALL.length > 10, `only ${ALL.length} fixture files were read`);
  assert.ok(
    ALL.some((entry) => entry.file.endsWith(".jsonl")),
    "no .jsonl recordings were found, so the provider fixtures were not scanned",
  );
});

test("no fixture names a real account's home directory", () => {
  // Matches C:\Users\<name>, C:/Users/<name>, /home/<name> and /Users/<name>,
  // through JSON's doubled backslashes and through a slugified path.
  const patterns = [
    /(?:[A-Za-z]:)?[\\/]{1,4}Users[\\/]{1,4}([A-Za-z0-9 ._-]{1,40})/g,
    /(?:^|[^A-Za-z])\/home\/([A-Za-z0-9._-]{1,40})/g,
    /[Cc]--[Uu]sers-([A-Za-z0-9_]{1,40})-/g,
  ];
  const found = [];
  for (const { file, text } of ALL)
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        if (!SYNTHETIC_IDENTITIES.has(name))
          found.push(`${path.relative(fixtures, file)} → ${name}`);
      }
  assert.deepEqual(
    [...new Set(found)],
    [],
    "A fixture names a home directory that is not one of the synthetic identities. Recordings must be sanitised before they are committed — see tests/fixtures/providers/README.md",
  );
});

test("no fixture carries a url with a name in front of the host", () => {
  // https://<something>@host is how an organisation's name reached this
  // repository once, and it is also the shape a credential in a url takes.
  const found = [];
  for (const { file, text } of ALL)
    for (const match of text.matchAll(
      /https?:\/\/([A-Za-z0-9._%+-]{1,60})@([A-Za-z0-9.-]+)/g,
    ))
      if (!SYNTHETIC_IDENTITIES.has(match[1]))
        found.push(
          `${path.relative(fixtures, file)} → ${match[1]}@${match[2]}`,
        );
  assert.deepEqual(
    [...new Set(found)],
    [],
    "A fixture contains a url with something before the @. That is how a private organisation name (or a credential) travels — replace it with a synthetic one",
  );
});

test("no fixture reaches a host that has not been vouched for", () => {
  const found = [];
  for (const { file, text } of ALL)
    for (const match of text.matchAll(
      /https?:\/\/(?:[^/@\s"\\]*@)?([A-Za-z0-9.-]+)/g,
    )) {
      const host = match[1].replace(/\.$/, "");
      if (!KNOWN_HOSTS.has(host) && !host.endsWith(".example.com"))
        found.push(`${path.relative(fixtures, file)} → ${host}`);
    }
  assert.deepEqual(
    [...new Set(found)],
    [],
    "A fixture mentions a host not in KNOWN_HOSTS. Check it names nothing private, then add it here deliberately",
  );
});

test("no fixture carries something shaped like a credential", () => {
  // Not exhaustive, and not meant to be — these are the shapes that would be
  // catastrophic rather than merely embarrassing.
  const patterns = [
    [/\bsk-[A-Za-z0-9]{20,}/g, "an OpenAI-style key"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "a GitHub token"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "an AWS access key id"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "a private key"],
  ];
  const found = [];
  for (const { file, text } of ALL)
    for (const [pattern, what] of patterns)
      // `text.match` rather than `pattern.test`: a /g regex carries lastIndex
      // between calls, so testing one file after another skips past the start
      // of the next one and reports a clean result it never looked for.
      if (text.match(pattern))
        found.push(`${path.relative(fixtures, file)} → ${what}`);
  assert.deepEqual([...new Set(found)], [], "A fixture contains a credential");
});
