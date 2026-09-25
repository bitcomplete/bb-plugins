import { isTicketlessClone } from "./workstreams.js";
import type { Row } from "./inbox.js";

export type WorkstreamAttention = {
  key: string;
  name: string;
  ready: number;
  update: number;
  fix: number;
  respond: number;
  waitingRereview: number;
  waitingReview: number;
  waitingOther: number;
  unknown: number;
  inFlight: number;
  parked: number;
  merged: number;
  inReleaseTag: number;
  oldCommits: number;
};
type CountKey = Exclude<keyof WorkstreamAttention, "key" | "name">;

const PRIORITY: CountKey[] = [
  "ready", "update", "fix", "respond", "waitingRereview", "waitingReview", "inFlight", "waitingOther", "unknown", "parked", "merged", "inReleaseTag",
];

/** Rank all scanned workstreams by the first available forward move, then name. */
export function workstreamAttention(rows: readonly Row[]): WorkstreamAttention[] {
  const byKey = new Map<string, WorkstreamAttention>();
  const seenPrs = new Set<string>();
  for (const row of rows) {
    if (isTicketlessClone(row.unit)) continue;
    const prUrl = row.unit.pr?.url;
    if (prUrl) {
      const id = `${row.effortKey}\0${prUrl}`;
      if (seenPrs.has(id)) continue;
      seenPrs.add(id);
    }
    let item = byKey.get(row.effortKey);
    if (item === undefined) {
      item = { key: row.effortKey, name: row.effort, ready: 0, update: 0, fix: 0, respond: 0,
        waitingRereview: 0, waitingReview: 0, waitingOther: 0, unknown: 0, inFlight: 0, parked: 0,
        merged: 0, inReleaseTag: 0, oldCommits: 0 };
      byKey.set(row.effortKey, item);
    }
    if (row.unit.lifecycle === "shipped") item.inReleaseTag++;
    else if (row.unit.lifecycle === "merged") item.merged++;
    else if (row.section === "merge" && row.verb === "Ready to merge") item.ready++;
    else if (row.section === "merge") item.update++;
    else if (row.section === "fix") item.fix++;
    else if (row.section === "respond") item.respond++;
    else if (row.section === "waiting" && row.unit.lifecycle === "awaiting-rereview") item.waitingRereview++;
    else if (row.section === "waiting" && row.unit.lifecycle === "awaiting-review") item.waitingReview++;
    else if (row.unit.lifecycle === "unverified") item.unknown++;
    else if (row.section === "waiting") item.waitingOther++;
    else if (row.section === "in-flight") item.inFlight++;
    else item.parked++;
    if (row.unit.lifecycle !== "merged" && row.unit.lifecycle !== "shipped" &&
      (row.unit.staleness === "cold" || row.unit.staleness === "dead")) item.oldCommits++;
  }
  const rank = (item: WorkstreamAttention) => PRIORITY.findIndex((key) => item[key] > 0);
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

const WORDS: [CountKey, string][] = [
  ["ready", "ready to merge"], ["update", "to update branch"], ["fix", "to fix"],
  ["respond", "to respond"], ["waitingRereview", "awaiting re-review"], ["waitingReview", "waiting for review"],
  ["inFlight", "in progress"], ["waitingOther", "otherwise waiting"],
  ["unknown", "with unknown status"], ["parked", "parked"],
  ["merged", "merged"], ["inReleaseTag", "in release tag"],
];

/** Native select options use the first useful state; the detail line shows the full mix. */
export function attentionLabel(item: WorkstreamAttention): string {
  const first = WORDS.find(([key]) => item[key] > 0);
  return first === undefined ? "No checkouts" : `${item[first[0]]} ${first[1]}`;
}

export function attentionDetail(item: WorkstreamAttention): string {
  const parts = WORDS.filter(([key]) => item[key] > 0).map(([key, label]) => `${item[key]} ${label}`);
  if (item.oldCommits > 0) parts.push(`${item.oldCommits} with old or missing commit dates`);
  return parts.length === 0 ? "No checkouts in this workstream." : `${parts.join(" · ")}.`;
}

/** Completed-only workstreams have no Board v2 group to select or scroll to. */
export function hasBoardRows(item: WorkstreamAttention): boolean {
  return PRIORITY.slice(0, PRIORITY.indexOf("merged")).some((key) => item[key] > 0);
}
