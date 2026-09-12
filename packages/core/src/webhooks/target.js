import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { InputError } from "../TaskStore.js";

/**
 * Where an outbound webhook is allowed to be delivered.
 *
 * A webhook URL is attacker-controlled in the sense that matters: whoever can
 * call `POST /api/webhooks/endpoints` picks an address that the *server* then
 * connects to, from wherever the server sits. That is CWE-918, and the
 * valuable targets are never on the public internet — they are the cloud
 * metadata service on 169.254.169.254, the host's own loopback interface, and
 * whatever else shares the server's network.
 *
 * The awkward part is that this is a local-first product, so delivering to
 * `http://localhost:3000/hook` or to a box on the home network is not an
 * attack — it is the ordinary use. Blocking that outright would break working
 * setups in order to defend a boundary that does not exist on a single-user
 * install.
 *
 * So the rule follows the trust boundary the server already draws:
 *
 *  - Link-local (169.254.0.0/16, fe80::/10) is refused always. Cloud metadata
 *    lives there and nothing legitimate delivers there.
 *  - Loopback and private ranges are allowed on a loopback-bound server — the
 *    default, where the only caller is the person at the keyboard.
 *  - On a remote-bound server (HOST is not loopback, so a token is the only
 *    thing between the network and the API) they are refused: there the caller
 *    is not necessarily the host's owner, and the server's position inside the
 *    network is not theirs to borrow. `AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE=true`
 *    turns them back on for somebody who means it.
 *
 * Node's HTTP client does not follow redirects, so a 302 to a refused address
 * is not a way round this: the next hop would have to be requested explicitly.
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

/** Whether loopback and private addresses may be delivered to. */
export function privateTargetsAllowed(env = process.env) {
  const explicit = String(env.AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  const host = env.HOST;
  return host === undefined || LOOPBACK_HOSTS.includes(host);
}

function ipv4Category(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return "invalid";
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return "invalid";
  const [a, b] = octets;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // carrier-grade NAT
  if (a >= 224) return "special"; // multicast, reserved, 255.255.255.255
  return "public";
}

/** Expands any IPv6 spelling to its eight numeric groups, or null. */
function expandIpv6(address) {
  let text = address;
  // A trailing dotted quad (::ffff:127.0.0.1) is two hex groups written long.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return null;
    text =
      text.slice(0, -dotted[1].length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${(
        (octets[2] << 8) |
        octets[3]
      ).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right =
    halves[1] === undefined ? [] : halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const gap = 8 - left.length - right.length;
    if (gap < 0) return null;
    groups = [...left, ...Array(gap).fill("0"), ...right];
  }
  const numbers = groups.map((group) => parseInt(group || "0", 16));
  return numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)
    ? null
    : numbers;
}

function ipv6Category(address) {
  const g = expandIpv6(address.toLowerCase());
  if (!g) return "invalid";
  if (g.every((group) => group === 0)) return "unspecified";
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1)
    return "loopback";
  // ::ffff:a.b.c.d and ::a.b.c.d carry an IPv4 address, and are the standard
  // way past a checker that only understands dotted quads. Judge the address
  // they actually carry.
  if (
    g.slice(0, 5).every((group) => group === 0) &&
    (g[5] === 0xffff || g[5] === 0)
  )
    return ipv4Category(
      `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`,
    );
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // unique local, fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return "special"; // multicast
  return "public";
}

/**
 * Classifies a hostname. A DNS name returns "name": nothing can be decided
 * about it until it resolves, which is what `guardedLookup` is for.
 */
export function categorize(host) {
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const version = isIP(bare);
  if (version === 4) return ipv4Category(bare);
  if (version === 6) return ipv6Category(bare);
  return "name";
}

/** The reason a category may not be delivered to, or null if it may. */
export function refusalFor(category, { allowPrivate = false } = {}) {
  if (category === "link-local")
    return "That address is link-local (169.254.0.0/16 or fe80::/10), which is where cloud metadata services live. Agent Space never delivers there. Use a routable address for the receiver.";
  if (category === "special")
    return "That is a multicast or reserved address, which cannot receive a webhook. Use the receiver's own address.";
  if (category === "unspecified")
    return "That is the unspecified address (0.0.0.0 or ::), which routes back to this machine rather than to a receiver. Name the receiver's address.";
  if (category === "invalid") return "That is not an address a webhook can reach.";
  if ((category === "loopback" || category === "private") && !allowPrivate)
    return `This server accepts connections from the network, so it will not deliver to ${
      category === "loopback" ? "its own loopback interface" : "a private network address"
    } — that would let anyone holding the token reach machines only this server can see. Deliver to a routable address, or set AGENT_SPACE_WEBHOOK_ALLOW_PRIVATE=true if that is genuinely what you want.`;
  return null;
}

/**
 * Validates a webhook URL and returns it parsed. Throws InputError with a
 * reason the interface can show.
 */
export function assertDeliverable(url, { allowPrivate = undefined } = {}) {
  const permitted = allowPrivate ?? privateTargetsAllowed();
  let target;
  try {
    target = new URL(String(url));
  } catch {
    throw new InputError("An outbound endpoint needs an http(s) url");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:")
    throw new InputError("An outbound endpoint needs an http(s) url");
  if (target.username || target.password)
    throw new InputError(
      "Put the credential in a secret rather than in the url — a username or password written into a webhook url is sent to the target and recorded on the way.",
    );
  const reason = refusalFor(categorize(target.hostname), {
    allowPrivate: permitted,
  });
  if (reason) throw new InputError(reason);
  return target;
}

/**
 * A `lookup` for http.request that refuses a name resolving to an address the
 * rule above blocks — `evil.example` with an A record of 169.254.169.254 is
 * otherwise a straight bypass of the literal check.
 *
 * The socket connects to exactly the address handed back here, so there is no
 * window between the check and the connection for a second DNS answer to be
 * used instead (DNS rebinding).
 */
export function guardedLookup({ allowPrivate = false } = {}) {
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const asked = typeof options === "function" ? {} : (options ?? {});
    dnsLookup(hostname, { ...asked, all: true }, (error, addresses) => {
      if (error) {
        done(error);
        return;
      }
      const found = Array.isArray(addresses) ? addresses : [addresses];
      const allowed = found.filter(
        (entry) => !refusalFor(categorize(entry.address), { allowPrivate }),
      );
      if (!allowed.length) {
        const reason =
          refusalFor(categorize(found[0]?.address ?? ""), { allowPrivate }) ??
          "resolved to no address a webhook can reach.";
        done(new Error(`${hostname} resolves to ${found[0]?.address}. ${reason}`));
        return;
      }
      if (asked.all) done(null, allowed);
      else done(null, allowed[0].address, allowed[0].family);
    });
  };
}
