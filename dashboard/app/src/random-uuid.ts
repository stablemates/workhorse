/**
 * A random version 4 UUID for request IDs, idempotency keys, and element keys.
 *
 * `crypto.randomUUID()` exists only in a secure context, so a dashboard served over plain HTTP
 * cannot call it. `crypto.getRandomValues()` exists in every context, and the fallback builds the
 * same RFC 9562 version 4 layout from it.
 */
export function randomUuid(source: Pick<Crypto, "getRandomValues"> & Partial<Crypto> = crypto) {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
