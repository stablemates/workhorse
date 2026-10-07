import { isIP } from "node:net";
import { ipv6Groups } from "./authentication.js";

/** Decides whether one transport peer address is a proxy the operator named. */
type TrustedProxyCheck = (address: string) => boolean;

/**
 * The 4 or 16 bytes of an IPv4 or IPv6 address, or undefined for anything else.
 *
 * An IPv4-mapped IPv6 address yields its IPv4 bytes, because a dual-stack socket reports an IPv4
 * peer in that form. An IPv6 address with a zone identifier is refused: a zone names a local
 * interface, which no forwarded hop or configured range can meaningfully carry.
 */
function addressBytes(address: string): number[] | undefined {
  const family = isIP(address);
  if (family === 4) return address.split(".").map(Number);
  if (family !== 6 || address.includes("%")) return undefined;
  const bytes = ipv6Groups(address).flatMap((group) => [group >> 8, group & 0xff]);
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
}

function bitAt(bytes: readonly number[], index: number): number {
  return ((bytes[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
}

/**
 * Parse the operator's trusted proxies into one check, or undefined when the list is empty.
 *
 * Each entry is one IPv4 or IPv6 address, or a CIDR range such as `10.0.0.0/8`. Parsing is strict
 * so a typo stops the listener instead of silently trusting the wrong peers: a range must not set
 * bits beyond its prefix, its prefix must be at least 1 because `/0` would trust every client, and
 * an IPv4-mapped IPv6 entry must be written as its IPv4 address.
 */
export function trustedProxyCheck(entries: readonly string[]): TrustedProxyCheck | undefined {
  const ranges = entries.map((entry) => {
    const invalid = (reason: string): TypeError =>
      new TypeError(`Invalid dashboard trusted proxy "${entry}": ${reason}`);
    const [address = "", prefix, ...rest] = entry.split("/");
    if (rest.length > 0) throw invalid("expected one address or CIDR range");
    const bytes = addressBytes(address);
    if (!bytes) throw invalid("expected an IPv4 or IPv6 address");
    if (isIP(address) === 6 && bytes.length === 4) {
      throw invalid("write an IPv4-mapped IPv6 address as its IPv4 address");
    }
    const width = bytes.length * 8;
    if (prefix !== undefined && !/^[1-9]\d{0,2}$/.test(prefix)) {
      throw invalid(`expected a prefix length between 1 and ${String(width)}`);
    }
    const prefixLength = prefix === undefined ? width : Number(prefix);
    if (prefixLength > width) {
      throw invalid(`expected a prefix length between 1 and ${String(width)}`);
    }
    for (let index = prefixLength; index < width; index += 1) {
      if (bitAt(bytes, index)) throw invalid("the address sets bits beyond its prefix length");
    }
    return { bytes, prefixLength };
  });
  if (ranges.length === 0) return undefined;
  return (address) => {
    const bytes = addressBytes(address);
    if (!bytes) return false;
    return ranges.some((range) => {
      if (range.bytes.length !== bytes.length) return false;
      for (let index = 0; index < range.prefixLength; index += 1) {
        if (bitAt(range.bytes, index) !== bitAt(bytes, index)) return false;
      }
      return true;
    });
  };
}

/** The bare address of one forwarded hop, with an optional port removed, or undefined. */
function hopAddress(text: string): string | undefined {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  const address = bracketed?.[1] ?? withPort?.[1] ?? text;
  if (bracketed && isIP(address) !== 6) return undefined;
  return addressBytes(address) ? address : undefined;
}

/**
 * Split text on a separator outside RFC 7230 quoted strings, or undefined when a quote never closes.
 *
 * A backslash inside a quoted string escapes the next character. The pieces keep their quotes.
 */
function splitOutsideQuotes(text: string, separator: string): string[] | undefined {
  const pieces: string[] = [];
  let piece = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted && character === "\\") {
      piece += character + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === separator) {
      pieces.push(piece);
      piece = "";
      continue;
    }
    piece += character;
  }
  if (quoted) return undefined;
  pieces.push(piece);
  return pieces;
}

/** The address in one `Forwarded` element's single `for` parameter, or undefined. */
function forwardedForHop(element: string): string | undefined {
  const values = (splitOutsideQuotes(element, ";") ?? [])
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter.slice(0, 4).toLowerCase() === "for=")
    .map((parameter) => parameter.slice(4));
  if (values.length !== 1) return undefined;
  const value = values[0] ?? "";
  if (!value.startsWith('"')) return hopAddress(value);
  if (value.length < 2 || !value.endsWith('"')) return undefined;
  return hopAddress(value.slice(1, -1).replace(/\\(.)/g, "$1"));
}

/**
 * The client address of one request, read through the proxies the operator trusts.
 *
 * Without a trusted proxy check, or when the transport peer is not trusted, the answer is the peer
 * itself and no header is read. A trusted peer's request must carry exactly one of
 * `X-Forwarded-For` and `Forwarded`. When it carries both, one of them came from the client and
 * nothing says which, so the answer stays the peer. A `Forwarded` header whose quoted string never
 * closes also keeps the peer, because that quote would otherwise hide the hops appended after it.
 *
 * Each proxy appends the address it observed, so the list is walked from its right end. Every hop
 * written by a trusted proxy is honest. The first hop that is not itself trusted is the client.
 * An unparseable hop, such as `unknown` or an obfuscated `Forwarded` identifier, ends the walk at
 * the trusted proxy that wrote it. When every hop is trusted, the leftmost one is the client.
 */
export function forwardedClientAddress(
  peer: string | undefined,
  headers: Headers,
  trusts: TrustedProxyCheck | undefined,
): string | undefined {
  if (!trusts || peer === undefined || !trusts(peer)) return peer;
  const forwardedFor = headers.get("x-forwarded-for");
  const forwarded = headers.get("forwarded");
  if ((forwardedFor === null) === (forwarded === null)) return peer;
  const elements =
    forwardedFor === null ? splitOutsideQuotes(forwarded ?? "", ",") : forwardedFor.split(",");
  if (!elements) return peer;
  const hops = elements.map((element) =>
    forwardedFor === null ? forwardedForHop(element) : hopAddress(element.trim()),
  );
  let client = peer;
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    if (hop === undefined) return client;
    if (!trusts(hop)) return hop;
    client = hop;
  }
  return client;
}
