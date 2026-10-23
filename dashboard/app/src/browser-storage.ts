/**
 * The only module that touches `localStorage`. A browser can throw on any storage access, for
 * example when a policy blocks site data. Preferences are a convenience, so a failed read gives
 * the default and a failed write keeps the change for the current session only.
 */

/** Values whose last write failed. A read prefers them, so a stale stored value cannot return. */
const sessionValues = new Map<string, string>();

export function readStoredValue(key: string): string | null {
  const sessionValue = sessionValues.get(key);
  if (sessionValue !== undefined) return sessionValue;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    sessionValues.delete(key);
  } catch {
    sessionValues.set(key, value);
  }
}
