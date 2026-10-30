import type { Row } from "./types.js";

export const PR_STATUSES = [
  { key: "turn", label: "Your turn", color: "bg-amber-500" },
  { key: "blocked", label: "Conflicts / CI", color: "bg-red-500" },
  { key: "waiting", label: "Waiting on reviewer", color: "bg-cyan-600" },
  { key: "approved", label: "Approved", color: "bg-teal-500" },
  { key: "draft", label: "Draft", color: "border border-muted-foreground bg-transparent" },
  { key: "held", label: "Held", color: "bg-muted-foreground/60" },
  { key: "unknown", label: "Status unknown", color: "bg-muted-foreground/25" },
] as const;
export type PrStatus = (typeof PR_STATUSES)[number]["key"];

export function prStatus(row: Row): PrStatus {
  if (row.holdUntil) return "held";
  if (row.turn && !row.dismissed) return "turn";
  if (row.draft) return "draft";
  if (row.status === null) return "unknown";
  if (row.status.mergeable === "CONFLICTING" || row.status.mergeStateStatus === "DIRTY" ||
    row.status.checks === "ERROR" || row.status.checks === "FAILURE") return "blocked";
  if (row.status.reviewDecision === "APPROVED") return "approved";
  return "waiting";
}

export function statusDescription(row: Row): string {
  if (row.turn && !row.dismissed) return row.turn.why;
  if (row.draft) return "Draft";
  if (row.status?.mergeable === "CONFLICTING" || row.status?.mergeStateStatus === "DIRTY") return "Conflicts";
  if (row.status?.checks === "ERROR" || row.status?.checks === "FAILURE") return "CI failing";
  if (row.status?.reviewDecision === "APPROVED") return "Approved";
  return row.status === null ? "Status unknown · refresh GitHub" : "Waiting on reviewer";
}
