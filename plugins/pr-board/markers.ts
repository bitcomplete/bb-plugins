// In-flight markers: which PRs an agent thread was started on, and when that stops being news.
import { z } from "zod";
import { actionSchema, type MarkerView } from "./board.js";

export const markerSchema = z.object({
  key: z.string(),
  action: actionSchema,
  status: z.enum(["starting", "started", "refused"]),
  at: z.string(),
  threadId: z.string().nullable(),
  title: z.string().nullable(),
  /** The PR's head SHA and derived move when the thread started; a change to either ends the marker. */
  head: z.string().nullable(),
  move: z.string().nullable(),
  reason: z.string().nullable(),
});
export type Marker = z.infer<typeof markerSchema>;

/** A thread's state as far as markers care. `null` means the thread is gone. */
export type ThreadInfo = { live: boolean; updatedAt: string } | null;

const LIVE = new Set(["active", "pending", "starting", "stopping"]);
export const isLiveStatus = (status: string) => LIVE.has(status);

/** PRs that suggestions skip and that cannot be started again: starting or started ones. */
export function busyKeys(markers: Marker[]): string[] {
  return markers.filter((m) => m.status !== "refused").map((m) => m.key);
}

/**
 * Markers that survive a refresh. A refusal lasts until the next refresh after it. A started marker
 * stays while its thread is live; once the thread stops, it stays until the PR's head or move changes
 * or the PR closes.
 */
export function afterRefresh(
  markers: Marker[],
  prs: Record<string, { head_oid: string; move: string } | undefined>,
  threads: Record<string, ThreadInfo>,
  refreshStartedAt: string,
): Marker[] {
  return markers.filter((m) => {
    if (m.status === "refused") return m.at >= refreshStartedAt;
    if (m.status === "starting" || m.threadId === null) return true;
    if (threads[m.threadId]?.live) return true;
    const pr = prs[m.key];
    return pr !== undefined && pr.head_oid === m.head && pr.move === m.move;
  });
}

export function toView(m: Marker, thread: ThreadInfo | undefined): MarkerView {
  const base = { key: m.key, threadId: m.threadId, title: m.title, reason: m.reason };
  if (m.status !== "started") return { ...base, status: m.status, at: m.at };
  if (thread?.live) return { ...base, status: "live", at: m.at };
  return { ...base, status: "done", at: thread?.updatedAt ?? m.at };
}
