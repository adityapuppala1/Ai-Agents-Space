import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What `npx agentspace` depends on being true.
 *
 * None of this is visible when running from a git clone, which is where it is
 * always developed — so every rule here is one that would only break for
 * somebody installing the published package, i.e. everybody except us.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("every advertised command exists", () => {
  assert.ok(pkg.bin, "the package declares no bin, so npx has nothing to run");
  for (const [name, target] of Object.entries(pkg.bin))
    assert.ok(
      existsSync(new URL(`../${target}`, import.meta.url)),
      `bin "${name}" points at ${target}, which is not in the repository`,
    );
});

test("the built interface is packed, or npx serves an empty page", () => {
  assert.ok(Array.isArray(pkg.files), "no files list: the tarball would be a guess");
  assert.ok(
    pkg.files.some((entry) => entry.replace(/\\/g, "/").startsWith("apps/web/dist")),
    "apps/web/dist is not packed — and it is gitignored, so it would simply be missing",
  );
  // The server reads dist from disk, so it has to be built before packing.
  assert.equal(
    pkg.scripts.prepack,
    "npm run build",
    "nothing rebuilds the interface before packing, so a stale dist could ship",
  );
});

test("only what the server actually needs at runtime is a dependency", () => {
  // React, three and lucide are bundled into dist by Vite. Shipping them as
  // runtime dependencies would make every npx install download megabytes it
  // never loads.
  assert.deepEqual(
    Object.keys(pkg.dependencies).sort(),
    ["ws"],
    "the runtime dependency list has drifted from what the server imports",
  );
  for (const buildOnly of ["react", "react-dom", "three", "lucide-react", "vite"])
    assert.ok(
      buildOnly in pkg.devDependencies,
      `${buildOnly} should be a devDependency: it is bundled, not loaded at runtime`,
    );
});

test("the launcher refuses the same Node the package refuses", () => {
  const launcher = readFileSync(new URL("../bin/agentspace.js", import.meta.url), "utf8");
  const declared = pkg.engines?.node ?? "";
  const floor = declared.match(/(\d+)\.(\d+)/);
  assert.ok(floor, `engines.node is "${declared}", which states no floor`);
  const [, major, minor] = floor;
  // engines is advisory — npm warns and installs anyway — so the launcher has
  // to check for itself, and say the same number.
  assert.ok(
    launcher.includes(`major < ${major}`) &&
      launcher.includes(`minor < ${minor}`),
    `bin/agentspace.js does not enforce the ${major}.${minor} floor that engines.node declares`,
  );
  assert.match(
    launcher,
    /node:sqlite/,
    "the version message should say why the floor exists",
  );
});

test("the launcher keeps a user's data out of the installed package", () => {
  const launcher = readFileSync(new URL("../bin/agentspace.js", import.meta.url), "utf8");
  // Under npx the package lives in a cache directory that the next run
  // replaces; a database written there would be lost without warning.
  for (const marker of ["LOCALAPPDATA", "Application Support", "XDG_DATA_HOME"])
    assert.ok(
      launcher.includes(marker),
      `the launcher has no per-user data location for ${marker}`,
    );
  assert.match(
    launcher,
    /AGENT_SPACE_DB/,
    "the launcher never points the database anywhere",
  );
});

test("the launcher imports the server as a URL, which is all Windows accepts", () => {
  const launcher = readFileSync(new URL("../bin/agentspace.js", import.meta.url), "utf8");
  // `import("C:\\...")` throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows.
  // This broke the first packaged build, so it is pinned.
  assert.match(
    launcher,
    /await import\(\s*new URL\(/,
    "the launcher must import the server by file:// URL, not by path",
  );
  assert.ok(
    !/await import\(\s*fileURLToPath/.test(launcher),
    "importing a converted path breaks on Windows",
  );
});

test("the package names itself something npx can fetch", () => {
  assert.equal(pkg.name, "agentspace");
  assert.ok(!pkg.private, "a private package cannot be published, so npx cannot fetch it");
  assert.ok(pkg.license, "npm wants a license field, even if it is UNLICENSED");
  if (pkg.license !== "UNLICENSED")
    assert.ok(
      existsSync(new URL("../LICENSE", import.meta.url)),
      `package.json claims the ${pkg.license} licence but there is no LICENSE file`,
    );
  assert.ok(root.length > 0);
});

test("the licence a distribution claims is the one it carries", () => {
  if (pkg.license === "UNLICENSED") return;
  const licence = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
  if (pkg.license === "Apache-2.0") {
    assert.match(licence, /Apache License\s+Version 2\.0/, "LICENSE is not Apache-2.0");
    // Apache-2.0 section 4(d): a NOTICE file, if there is one, must travel
    // with every distribution.
    assert.ok(
      existsSync(new URL("../NOTICE", import.meta.url)),
      "Apache-2.0 expects a NOTICE file naming the copyright holder",
    );
    for (const file of ["LICENSE", "NOTICE"])
      assert.ok(pkg.files.includes(file), `${file} is not packed into the tarball`);
  }
});

test("bundled third-party code is still attributed after minification", () => {
  // React, three and lucide are compiled into apps/web/dist and shipped. The
  // bundler strips their licence comments, and MIT and ISC both require the
  // notice to travel with the copy — so it travels in a file instead.
  const notices = new URL("../THIRD-PARTY-NOTICES.md", import.meta.url);
  assert.ok(
    existsSync(notices),
    "the tarball ships bundled MIT/ISC code with no notices anywhere",
  );
  const text = readFileSync(notices, "utf8");
  for (const name of ["react", "react-dom", "three", "lucide-react", "ws"])
    assert.ok(
      new RegExp(`^## ${name} `, "m").test(text),
      `${name} is distributed but not listed in THIRD-PARTY-NOTICES.md`,
    );
  // Reproduced in full, not merely named.
  assert.ok(
    (text.match(/Permission is hereby granted/g) ?? []).length >= 4,
    "the notices name the packages without reproducing their licences",
  );
  assert.ok(
    pkg.files.includes("THIRD-PARTY-NOTICES.md"),
    "the notices are not packed into the tarball",
  );
});
