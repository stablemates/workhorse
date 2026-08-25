import { useEffect, useState } from "react";

/**
 * Display timezone preference. Timestamps are stored and transported as UTC ISO
 * strings; this only affects rendering. "system" means the browser's own zone.
 */
const timeZoneStorageKey = "workhorse-timezone";
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const createDateTimeFormatter = Intl.DateTimeFormat;
export let displayTimeZone: string | null = readStoredTimeZone();
const timeZoneListeners = new Set<() => void>();
export function getDateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new createDateTimeFormatter(undefined, options);
  dateTimeFormatters.set(key, formatter);
  return formatter;
}
function readStoredTimeZone(): string | null {
  const stored = localStorage.getItem(timeZoneStorageKey);
  if (!stored || stored === "system") return null;
  try {
    return getDateTimeFormatter({ timeZone: stored }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
export function setDisplayTimeZone(zone: string | null): void {
  displayTimeZone = zone;
  localStorage.setItem(timeZoneStorageKey, zone ?? "system");
  for (const listener of timeZoneListeners) listener();
}
export function subscribeTimeZone(listener: () => void): () => void {
  timeZoneListeners.add(listener);
  return () => timeZoneListeners.delete(listener);
}
export function currentTimeZoneValue(): string {
  return displayTimeZone ?? "system";
}
export function formatExact(value: string | null | undefined): string {
  if (!value) return "never";
  return getDateTimeFormatter({
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: displayTimeZone ?? undefined,
    timeZoneName: "short",
  }).format(new Date(value));
}
export function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const deltaMs = Date.now() - new Date(value).getTime();
  const future = deltaMs < 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1_000);
  const phrase =
    seconds < 5
      ? "now"
      : seconds < 60
        ? `${seconds}s`
        : seconds < 3_600
          ? `${Math.floor(seconds / 60)}m`
          : seconds < 86_400
            ? `${Math.floor(seconds / 3_600)}h`
            : `${Math.floor(seconds / 86_400)}d`;
  if (phrase === "now") return future ? "in a moment" : "just now";
  return future ? `in ${phrase}` : `${phrase} ago`;
}
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.round(milliseconds / 60_000)} min`;
}
/** Wall-clock time of day, used when a date alone would be too long for a table row. */
export function formatClock(value: string | null | undefined): string {
  if (!value) return "—";
  return getDateTimeFormatter({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: displayTimeZone ?? undefined,
  }).format(new Date(value));
}
/** Calendar day without a time, so a daily boundary reads plainly. */
export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  return getDateTimeFormatter({
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: displayTimeZone ?? undefined,
  }).format(new Date(value));
}
/**
 * Coarse span for retention ages, which run to days rather than the milliseconds and minutes
 * `formatDuration` targets. Rounds down so a reported span never overstates the real lag.
 */
export function formatSpan(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  if (milliseconds < 60_000) return "under a minute";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}
/** Relation size in the units an operator reads storage dashboards in. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/** Row counts come from PostgreSQL statistics, so they are estimates and read better abbreviated. */
export function formatRows(rows: number): string {
  if (rows < 1_000) return String(rows);
  if (rows < 1_000_000) return `${(rows / 1_000).toFixed(rows < 10_000 ? 1 : 0)}k`;
  return `${(rows / 1_000_000).toFixed(rows < 10_000_000 ? 1 : 0)}M`;
}
/**
 * Remaining time until a target, clamped at zero. A durable wait target that has
 * passed is not negative time; the task is simply eligible to be claimed again.
 */
export function formatCountdown(targetIso: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(targetIso).getTime() - nowMs);
  if (remainingMs < 1_000) return "0s";
  const totalSeconds = Math.floor(remainingMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
/** True once the target has passed; re-renders once at the target instead of ticking. */
export function useElapsed(targetIso: string | null): boolean {
  const [elapsed, setElapsed] = useState(
    () => targetIso !== null && new Date(targetIso).getTime() <= Date.now(),
  );
  useEffect(() => {
    if (targetIso === null) return;
    const remainingMs = new Date(targetIso).getTime() - Date.now();
    if (remainingMs <= 0) {
      setElapsed(true);
      return;
    }
    setElapsed(false);
    const timer = setTimeout(() => setElapsed(true), remainingMs);
    return () => clearTimeout(timer);
  }, [targetIso]);
  return elapsed;
}
/** Ticking clock for countdowns. Pass `false` to stop ticking when nothing counts down. */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
export function checkpointOutput(value: unknown): string {
  if (value && typeof value === "object" && "output" in value) {
    const output = (value as { output?: unknown }).output;
    if (typeof output === "string") return output;
  }
  return JSON.stringify(value);
}
/** SQL NULL and missing values both mean there is no inspectable JSON evidence. */
export function hasStoredValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}
const clipboardUnavailable =
  "Copying is not available in this browser. Open the task to select the text instead.";
/** Resolves to null on success, or to the sentence to show the operator when copying failed. */
export async function copyToClipboard(text: string): Promise<string | null> {
  if (!navigator.clipboard) return clipboardUnavailable;
  try {
    await navigator.clipboard.writeText(text);
    return null;
  } catch {
    return clipboardUnavailable;
  }
}
