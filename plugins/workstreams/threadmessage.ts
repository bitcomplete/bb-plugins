import type { ThreadTier } from "./threads.js";

export type MessageLink = { id: string; tier: ThreadTier };

const TIER_ORDER: readonly ThreadTier[] = ["started", "environment", "ticket", "paths"];

/** Strong links first; keep the caller's active/recent order within a tier. */
export function orderMessageTargets<T extends MessageLink>(links: readonly T[]): T[] {
  return links.map((link, index) => ({ link, index }))
    .sort((a, b) => TIER_ORDER.indexOf(a.link.tier) - TIER_ORDER.indexOf(b.link.tier) || a.index - b.index)
    .map(({ link }) => link);
}

/** Multiple linked threads need an explicit choice, even when one ranks first. */
export function defaultMessageTarget(links: readonly MessageLink[]): string {
  return links.length === 1 ? links[0]!.id : "";
}

export type MessageSdk = {
  get(args: { threadId: string }): Promise<{ archivedAt: number | null }>;
  send(args: { threadId: string; mode: "auto"; input: { type: "text"; text: string; mentions: [] }[] }): Promise<
    { ok: true; delivery: "sent" | "queued" }
  >;
};

/** Send only to a currently linked, visible thread, with the PR named by the server's scan. */
export async function sendRowMessage(
  sdk: MessageSdk,
  request: {
    threadId: string;
    message: string;
    links: readonly MessageLink[];
    pr: { repo: string; number: number; title: string; url: string; checkout: string };
  },
): Promise<{ ok: true; delivery: "sent" | "queued" } | { ok: false; error: string }> {
  const message = request.message.trim();
  if (message.length === 0 || message.length > 4_000) return { ok: false, error: "Write a message of at most 4,000 characters." };
  if (!request.links.some((link) => link.id === request.threadId)) {
    return { ok: false, error: "That agent thread is no longer linked to this row. Refresh and choose another." };
  }
  let thread: { archivedAt: number | null };
  try {
    thread = await sdk.get({ threadId: request.threadId });
  } catch {
    return { ok: false, error: "That agent thread is no longer available. Refresh and choose another." };
  }
  if (thread.archivedAt !== null) return { ok: false, error: "That agent thread is archived. Unarchive it before sending a message." };
  const text = `Workstreams row: ${request.pr.repo} #${request.pr.number} — ${request.pr.title}\nPR: ${request.pr.url}\nCheckout: ${request.pr.checkout}\n\nUser request:\n${message}`;
  return sdk.send({ threadId: request.threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
}
