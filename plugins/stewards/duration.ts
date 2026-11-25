// The duration formatter, in its own module so the browser surfaces (the
// sidebar's `idle <duration>` chip) can render a duration without pulling in
// `config.ts`, whose top-level `node:crypto` import cannot be bundled for the
// app. `config.ts` re-exports `formatDuration`, so its existing callers are
// unchanged.

/** The ms in a minute, hour, day and week, keyed by the suffix `durationSchema` accepts. */
export const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "45m", "3h", "2d", "1w". */
export function formatDuration(ms: number): string {
  if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
  if (ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
  return `${Math.round(ms / UNIT_MS.m!)}m`;
}

/**
 * A rounded age, e.g. `2d`, `3h`, `45m`: days when at least a day, hours when
 * at least an hour, else minutes (at least one). Unlike `formatDuration` it
 * does not require an exact multiple, so a real elapsed time reads `71h`, never
 * `4273m`.
 */
export function formatAge(ms: number): string {
  if (ms >= UNIT_MS.d!) return `${Math.round(ms / UNIT_MS.d!)}d`;
  if (ms >= UNIT_MS.h!) return `${Math.round(ms / UNIT_MS.h!)}h`;
  return `${Math.max(1, Math.round(ms / UNIT_MS.m!))}m`;
}
