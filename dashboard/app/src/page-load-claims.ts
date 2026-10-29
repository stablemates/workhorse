/** One page load: its place in the sequence of loads, and the page it reads. */
export interface PageLoadClaim {
  readonly id: number;
  readonly key: string;
}

/**
 * Which page load may still write to the page area.
 *
 * Each load, and each navigation that a cached answer serves at once, takes a claim. Only the
 * newest claim can write, and only while the location still asks for its page. A slow answer for
 * the page the operator left then cannot replace the page that the operator opened.
 */
export function createPageLoadClaims() {
  let latest = 0;
  return {
    claim(key: string): PageLoadClaim {
      latest += 1;
      return { id: latest, key };
    },
    /** True if `claim` is the newest claim and `shownKey` names the page that it reads. */
    holds(claim: PageLoadClaim, shownKey: string): boolean {
      return claim.id === latest && claim.key === shownKey;
    },
  };
}
