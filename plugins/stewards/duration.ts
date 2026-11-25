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
