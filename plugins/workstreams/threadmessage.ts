import type { ThreadTier } from "./threads.js";

export type MessageLink = { id: string; tier: ThreadTier };

export type MessageSdk = {
  get(args: { threadId: string }): Promise<{ archivedAt: number | null; deletedAt?: number | null; visibility?: string }>;
  send(args: { threadId: string; mode: "auto" | "queue-if-active"; input: { type: "text"; text: string; mentions: [] }[] }): Promise<
    { ok: true; delivery: "sent" | "queued" }
  >;
};

/** Send only to a currently linked, visible thread, with the PR named by the server's scan. */
export async function sendRowMessage(
  sdk: MessageSdk,
  request: {
    threadId: string;
    message: string;
    mode?: "auto" | "queue-if-active";
    links: readonly MessageLink[];
    pr: { repo: string; number: number; title: string; url: string; checkout: string | null };
  },
): Promise<{ ok: true; delivery: "sent" | "queued" } | { ok: false; error: string }> {
  const message = request.message.trim();
  if (message.length === 0 || message.length > 4_000) return { ok: false, error: "Write a message of at most 4,000 characters." };
  if (!request.links.some((link) => link.id === request.threadId)) {
    return { ok: false, error: "That agent thread is no longer linked to this row. Refresh and choose another." };
  }
  let thread: { archivedAt: number | null; deletedAt?: number | null; visibility?: string };
  try {
    thread = await sdk.get({ threadId: request.threadId });
  } catch {
    return { ok: false, error: "That agent thread is no longer available. Refresh and choose another." };
  }
  if (thread.archivedAt !== null) return { ok: false, error: "That agent thread is archived. Unarchive it before sending a message." };
  if (thread.deletedAt != null || (thread.visibility !== undefined && thread.visibility !== "visible")) {
    return { ok: false, error: "That agent thread is no longer visible. Refresh and choose another." };
  }
  const checkout = request.pr.checkout === null ? "" : `\nCheckout: ${request.pr.checkout}`;
  const text = `Workstreams row: ${request.pr.repo} #${request.pr.number} — ${request.pr.title}\nPR: ${request.pr.url}${checkout}\n\nUser request:\n${message}`;
  return sdk.send({ threadId: request.threadId, mode: request.mode ?? "auto", input: [{ type: "text", text, mentions: [] }] });
}
