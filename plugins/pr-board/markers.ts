// In-flight markers: which PRs an agent thread was started on, and when that stops being news.
import { z } from "zod";
import { actionSchema, questionSchema, type AgentQuestion, type MarkerView } from "./board.js";

export const markerSchema = z.object({
  key: z.string(),
  action: actionSchema,
  status: z.enum(["starting", "started", "refused"]),
  at: z.string(),
  threadId: z.string().nullable(),
  title: z.string().nullable(),
  /** The starting head and move expire stopped markers without unanswered questions. */
  head: z.string().nullable(),
  move: z.string().nullable(),
  reason: z.string().nullable(),
  question: questionSchema.nullable().default(null),
  answeredQuestions: z.array(z.string()).default([]),
  answering: z.string().nullable().default(null),
  answerError: z.string().nullable().default(null),
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
 * or the PR closes. An unanswered structured question survives changes to the head or move.
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
    if (pr && m.question) return true;
    return pr !== undefined && pr.head_oid === m.head && pr.move === m.move;
  });
}

export function toView(m: Marker, thread: ThreadInfo | undefined): MarkerView {
  const base = { key: m.key, threadId: m.threadId, title: m.title, reason: m.reason, question: m.question, answering: m.answering !== null, answerError: m.answerError };
  if (m.status !== "started") return { ...base, status: m.status, at: m.at };
  if (thread?.live) return { ...base, status: "live", at: m.at };
  if (m.question) return { ...base, status: "asking", at: thread?.updatedAt ?? m.at };
  return { ...base, status: "done", at: thread?.updatedAt ?? m.at };
}

/** A final, validated block is the only evidence that an agent is asking a question. */
export type QuestionResult = { kind: "valid"; question: AgentQuestion | null } | { kind: "invalid" };
export function parseQuestion(output: string | null): QuestionResult {
  if (output === null) return { kind: "invalid" };
  const match = [...output.matchAll(/```pr-board-question[ \t]*\r?\n([\s\S]*?)\r?\n```/g)].at(-1);
  if (match?.[1] === undefined || output.slice(match.index + match[0].length).trim()) return { kind: "invalid" };
  try {
    const parsed = z.object({ version: z.literal(1), question: questionSchema.nullable() }).strict().safeParse(JSON.parse(match[1]));
    return parsed.success ? { kind: "valid", question: parsed.data.question } : { kind: "invalid" };
  } catch { return { kind: "invalid" }; }
}
