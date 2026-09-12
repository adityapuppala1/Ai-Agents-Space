import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  assertDeliverable,
  categorize,
  guardedLookup,
  privateTargetsAllowed,
  refusalFor,
} from "../packages/core/src/webhooks/target.js";
import { defaultSend } from "../packages/core/src/webhooks/WebhookService.js";

/**
 * An outbound webhook is the one place where a caller names an address and the
 * *server* connects to it. On a server bound to the network, that is a way to
 * reach whatever the server can reach and the caller cannot — the host's own
 * loopback interface, the LAN, and the cloud metadata service (CWE-918).
 *
 * The rule has to hold in both directions: refuse the pivot, and keep working
 * for the person running this on their own machine, where delivering to
 * localhost is the ordinary thing to do.
 */

test("addresses are classified by what they can reach", () => {
  assert.equal(categorize("127.0.0.1"), "loopback");
  assert.equal(categorize("127.1.2.3"), "loopback");
  assert.equal(categorize("10.0.0.5"), "private");
  assert.equal(categorize("172.16.0.1"), "private");
  assert.equal(categorize("172.32.0.1"), "public"); // just outside 172.16/12
  assert.equal(categorize("192.168.1.1"), "private");
  assert.equal(categorize("169.254.169.254"), "link-local");
  assert.equal(categorize("0.0.0.0"), "unspecified");
  assert.equal(categorize("203.0.113.7"), "public");
  assert.equal(categorize("example.com"), "name");
});

test("an IPv6 spelling of a blocked address is still blocked", () => {
  // Writing the same address a different way is the oldest way past a filter.
  assert.equal(categorize("[::1]"), "loopback");
  assert.equal(categorize("::1"), "loopback");
  assert.equal(categorize("[::]"), "unspecified");
  assert.equal(categorize("[fe80::1]"), "link-local");
  assert.equal(categorize("[fd00::1]"), "private"); // unique local
  // IPv4 wearing an IPv6 coat, in both the dotted and the hex spelling.
  assert.equal(categorize("[::ffff:127.0.0.1]"), "loopback");
  assert.equal(categorize("[::ffff:7f00:1]"), "loopback");
  assert.equal(categorize("[::ffff:169.254.169.254]"), "link-local");
  assert.equal(categorize("[::ffff:a9fe:a9fe]"), "link-local");
  assert.equal(categorize("[2606:4700::1111]"), "public");
});

test("the WHATWG parser normalises the numeric spellings of an address", () => {
  // http://2130706433/ is 127.0.0.1 written as one decimal, and 0177.0.0.1 is
  // the octal form. Both are classic filter bypasses; both are normalised by
  // the URL parser before anything here sees them, which is why the check is
  // made against url.hostname rather than the raw string.
  assert.equal(categorize(new URL("http://2130706433/").hostname), "loopback");
  assert.equal(categorize(new URL("http://0177.0.0.1/").hostname), "loopback");
  assert.equal(categorize(new URL("http://0x7f.0.0.1/").hostname), "loopback");
});

test("link-local is refused however the server is bound", () => {
  // Cloud metadata lives on 169.254.169.254 and hands out credentials to
  // anything that asks. Nothing legitimate delivers a webhook there, so this
  // one is not subject to the local-install exception.
  for (const allowPrivate of [true, false]) {
    assert.match(
      refusalFor("link-local", { allowPrivate }) ?? "",
      /link-local/,
      `link-local was permitted with allowPrivate=${allowPrivate}`,
    );
    assert.throws(
      () =>
        assertDeliverable("http://169.254.169.254/latest/meta-data/", {
          allowPrivate,
        }),
      /link-local/,
    );
  }
});

test("a local install may still deliver to its own machine", () => {
  // This is the case that must not regress: the product is local-first, and
  // posting to a service on localhost is the ordinary use, not an attack.
  assert.equal(refusalFor("loopback", { allowPrivate: true }), null);
  assert.equal(refusalFor("private", { allowPrivate: true }), null);
  const target = assertDeliverable("http://localhost:3000/hook", {
    allowPrivate: true,
  });
  assert.equal(target.hostname, "localhost");
  assert.equal(
    assertDeliverable("http://192.168.1.50/hook", { allowPrivate: true })
      .hostname,
    "192.168.1.50",
  );
});

test("a network-bound server will not lend out its position", () => {
  for (const url of [
    "http://127.0.0.1:5173/api/ops/stop-all",
    "http://[::1]:5173/api/workspaces",
    "http://10.0.0.1/admin",
    "http://192.168.0.1/",
  ])
    assert.throws(
      () => assertDeliverable(url, { allowPrivate: false }),
      /AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE/,
      `${url} was accepted by a network-bound server`,
    );
});

test("whether private targets are allowed follows how the server is bound", () => {
  // The default is the trust boundary the server already draws: loopback bind
  // means the only caller is the person at the keyboard.
  assert.equal(privateTargetsAllowed({}), true);
  assert.equal(privateTargetsAllowed({ HOST: "127.0.0.1" }), true);
  assert.equal(privateTargetsAllowed({ HOST: "localhost" }), true);
  assert.equal(privateTargetsAllowed({ HOST: "0.0.0.0" }), false);
  assert.equal(privateTargetsAllowed({ HOST: "192.168.1.20" }), false);
  // And it can be said explicitly either way.
  assert.equal(
    privateTargetsAllowed({ HOST: "0.0.0.0", AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE: "true" }),
    true,
  );
  assert.equal(
    privateTargetsAllowed({ AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE: "false" }),
    false,
  );
});

test("a url may not carry a credential", () => {
  // It would be sent to the target and written into the delivery record.
  assert.throws(
    () => assertDeliverable("http://user:pa55@example.com/hook", { allowPrivate: true }),
    /secret rather than in the url/,
  );
});

test("only http and https are delivered to", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com:70/_test",
  ])
    assert.throws(
      () => assertDeliverable(url, { allowPrivate: true }),
      /http\(s\) url/,
      `${url} was accepted`,
    );
});

test("a name resolving to a blocked address is refused", async () => {
  // The literal check cannot see this one: the hostname is a name, and only
  // what it resolves to is disqualifying. localhost is used because it comes
  // from the hosts file, so the test needs no network and cannot flake.
  const refuse = guardedLookup({ allowPrivate: false });
  const refused = await new Promise((resolve) =>
    refuse("localhost", {}, (error, address) => resolve({ error, address })),
  );
  assert.ok(refused.error, "localhost resolved to loopback and was allowed");
  assert.match(refused.error.message, /localhost resolves to/);

  const allow = guardedLookup({ allowPrivate: true });
  const allowed = await new Promise((resolve) =>
    allow("localhost", {}, (error, address, family) =>
      resolve({ error, address, family }),
    ),
  );
  assert.equal(allowed.error, null);
  assert.ok(
    ["127.0.0.1", "::1"].includes(allowed.address),
    `localhost resolved to ${allowed.address}`,
  );
  assert.ok([4, 6].includes(allowed.family));
});

test("a refused delivery never reaches the listener, and a permitted one does", async () => {
  // The point of the whole exercise, proven against a real socket rather than
  // by reading the code: a blocked target receives no bytes at all.
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    const refused = await defaultSend({
      url,
      headers: {},
      body: "{}",
      allowPrivate: false,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 0);
    assert.match(refused.error, /AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE/);
    assert.equal(hits, 0, "the refused delivery still reached the listener");

    const delivered = await defaultSend({
      url,
      headers: {},
      body: "{}",
      allowPrivate: true,
    });
    assert.equal(delivered.ok, true, `local delivery broke: ${delivered.error}`);
    assert.equal(delivered.status, 204);
    assert.equal(hits, 1, "the permitted delivery did not arrive");
  } finally {
    server.close();
    await once(server, "close");
  }
});
