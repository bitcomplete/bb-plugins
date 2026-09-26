import { z } from "zod";

export const prHoldSchema = z.object({ reason: z.string().max(1_000), heldAt: z.number() });
export const prHoldsSchema = z.record(z.string(), prHoldSchema);
export type PrHold = z.infer<typeof prHoldSchema>;
export type PrHolds = z.infer<typeof prHoldsSchema>;

/** One identity across checkout clones, inventory, and copied GitHub links. */
export function canonicalPrUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return null;
    const match = /^\/([a-z\d-]+)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/iu.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
    return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/pull/${match[3]}`;
  } catch { return null; }
}

export function prHoldFor(prUrl: string, holds: PrHolds): PrHold | null {
  const key = canonicalPrUrl(prUrl);
  return key === null ? null : holds[key] ?? null;
}
