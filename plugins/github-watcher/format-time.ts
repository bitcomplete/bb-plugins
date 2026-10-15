// Relative times for the usage view, shared by the settings section and the
// CLI. No imports, so the app bundle can take it without dragging node in.

/** "3m", "2h", "5d": how long ago, or "never" for 0. */
export function ago(at: number, now: number): string {
  if (at === 0) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "in 3h", "in 5d", "now" once passed. */
export function until(at: number, now: number): string {
  return at <= now ? "now" : `in ${ago(now - (at - now), now)}`;
}
