import { describe, expect, it } from "vitest";
import { forwardedClientAddress, trustedProxyCheck } from "../src/server/trusted-proxy.js";

function resolve(
  peer: string | undefined,
  headers: Record<string, string>,
  trusted: readonly string[] = ["10.0.0.0/8", "2001:db8:ff::/48"],
): string | undefined {
  return forwardedClientAddress(peer, new Headers(headers), trustedProxyCheck(trusted));
}

describe("dashboard trusted proxies", () => {
  it("parses addresses and CIDR ranges strictly", () => {
    expect(trustedProxyCheck([])).toBeUndefined();
    const trusts = trustedProxyCheck(["192.0.2.10", "10.0.0.0/8", "2001:db8::/32", "::1"]);
    expect(trusts?.("192.0.2.10")).toBe(true);
    expect(trusts?.("192.0.2.11")).toBe(false);
    expect(trusts?.("10.255.0.1")).toBe(true);
    expect(trusts?.("::ffff:10.1.2.3")).toBe(true);
    expect(trusts?.("2001:db8:ffff::1")).toBe(true);
    expect(trusts?.("2001:db9::1")).toBe(false);
    expect(trusts?.("::1")).toBe(true);
    expect(trusts?.("not an address")).toBe(false);
  });

  it.each([
    "",
    " 10.0.0.1",
    "10.0.0.1 ",
    "localhost",
    "10.0.0.0/",
    "10.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.0.0.0/08",
    "10.0.0.0/+8",
    "10.0.0.0/8/8",
    "10.0.0.1/8",
    "2001:db8::1/64",
    "010.0.0.1",
    "10.0.0",
    "[::1]",
    "fe80::1%eth0",
    "::ffff:10.0.0.1",
    "10.0.0.0/8,192.0.2.1",
  ])("refuses the malformed entry %j", (entry) => {
    expect(() => trustedProxyCheck([entry])).toThrow(/Invalid dashboard trusted proxy/);
  });

  it("never reads forwarding headers without a trusted peer", () => {
    expect(
      forwardedClientAddress(
        "198.51.100.9",
        new Headers({ "x-forwarded-for": "203.0.113.1" }),
        undefined,
      ),
    ).toBe("198.51.100.9");
    expect(resolve("198.51.100.9", { "x-forwarded-for": "203.0.113.1" })).toBe("198.51.100.9");
    expect(resolve("198.51.100.9", { forwarded: "for=203.0.113.1" })).toBe("198.51.100.9");
    expect(resolve(undefined, { "x-forwarded-for": "203.0.113.1" })).toBeUndefined();
  });

  it("takes the rightmost hop that is not a trusted proxy", () => {
    // The client wrote 192.0.2.66 itself. The first proxy appended the client's real address.
    expect(resolve("10.0.0.2", { "x-forwarded-for": "192.0.2.66, 203.0.113.7, 10.0.0.1" })).toBe(
      "203.0.113.7",
    );
    expect(resolve("::ffff:10.0.0.2", { "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    expect(resolve("10.0.0.2", { "x-forwarded-for": "203.0.113.7:51234" })).toBe("203.0.113.7");
    expect(resolve("10.0.0.2", { "x-forwarded-for": "[2001:db8:1::5]:443" })).toBe("2001:db8:1::5");
    expect(resolve("10.0.0.2", { "x-forwarded-for": "2001:db8:1::5,2001:db8:ff::1" })).toBe(
      "2001:db8:1::5",
    );
    // Every hop is a trusted proxy, so the leftmost one is the client.
    expect(resolve("10.0.0.2", { "x-forwarded-for": "10.0.0.9, 10.0.0.1" })).toBe("10.0.0.9");
  });

  it("reads the for parameter of Forwarded", () => {
    expect(
      resolve("10.0.0.2", {
        forwarded: 'for=192.0.2.66, For="[2001:db8:1::5]:4711";proto=https, for=10.0.0.1',
      }),
    ).toBe("2001:db8:1::5");
    expect(
      resolve("10.0.0.2", { forwarded: "by=10.0.0.2;for=203.0.113.7;host=example.test" }),
    ).toBe("203.0.113.7");
  });

  it("honors quoted strings in Forwarded", () => {
    expect(resolve("10.0.0.2", { forwarded: 'for=203.0.113.7;host="a,b;c", for=10.0.0.1' })).toBe(
      "203.0.113.7",
    );
    expect(
      resolve("10.0.0.2", { forwarded: 'for=192.0.2.66;ext="x\\",y", for="203.0.113.7"' }),
    ).toBe("203.0.113.7");
    expect(resolve("10.0.0.2", { forwarded: 'for="\\203.0.113.7"' })).toBe("203.0.113.7");
    // A client's unterminated quote would swallow the hop its proxy appends, so the peer stays.
    expect(resolve("10.0.0.2", { forwarded: 'for=192.0.2.66;ext="x, for=203.0.113.7' })).toBe(
      "10.0.0.2",
    );
  });

  it("stops at the trusted proxy that wrote an unparseable hop", () => {
    expect(resolve("10.0.0.2", { "x-forwarded-for": "203.0.113.7, unknown, 10.0.0.1" })).toBe(
      "10.0.0.1",
    );
    expect(resolve("10.0.0.2", { "x-forwarded-for": "203.0.113.7, " })).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", { forwarded: "for=203.0.113.7, for=_hidden" })).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", { forwarded: 'for="203.0.113.7' })).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", { forwarded: "for=203.0.113.7;for=192.0.2.1" })).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", { "x-forwarded-for": "fe80::1%eth0" })).toBe("10.0.0.2");
  });

  it("keeps the peer when a trusted proxy sent both forwarding headers or neither", () => {
    expect(
      resolve("10.0.0.2", { "x-forwarded-for": "203.0.113.7", forwarded: "for=192.0.2.66" }),
    ).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", {})).toBe("10.0.0.2");
  });
});
