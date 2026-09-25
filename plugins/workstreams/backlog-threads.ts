import type { MenuThread } from "./threadmenu";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { advancePrKey } from "./bulk-advance-selection";

type ThreadRecord = { prUrl: string | null; threadId: string | null; status: string; action?: string; previousAttempts?: readonly { threadId: string | null; status: string }[] };
type LiveThread = Pick<PluginSidebarThread, "id" | "title" | "titleFallback" | "updatedAt" | "activity" | "indicator" | "hasPendingInteraction">;
const ACTIVE_INDICATORS = new Set<LiveThread["indicator"]>(["runtime", "workflow", "background-agent", "background-command", "goal", "plan-mode", "waiting-for-input"]);

/** Durable PR links survive a stale readiness verdict and do not require a local checkout. */
export function backlogThreads(prUrl: string, local: readonly MenuThread[], runs: readonly ThreadRecord[], jobs: readonly ThreadRecord[], live: readonly LiveThread[]): MenuThread[] {
  const result = new Map(local.map((thread) => [thread.id, thread]));
  const key = advancePrKey(prUrl);
  for (const [records, fallback] of [[runs, "PR action"], [jobs, "Rebasing..."]] as const) {
    for (const record of records.flatMap((item) => [item, ...(item.previousAttempts ?? []).map((attempt) => ({ ...attempt, prUrl: item.prUrl, action: item.action }))])) {
      if (!record.threadId || !record.prUrl || advancePrKey(record.prUrl) !== key || result.has(record.threadId)) continue;
      result.set(record.threadId, { id: record.threadId, title: record.action ? `${fallback} · ${record.action}` : fallback, tier: "started", active: ["running", "launching", "needs-you"].includes(record.status) });
    }
  }
  const current = new Map(live.map((thread) => [thread.id, thread]));
  return [...result.values()].map((thread) => {
    const found = current.get(thread.id);
    return found ? { ...thread, title: found.title ?? found.titleFallback ?? thread.title, active: found.hasPendingInteraction || ACTIVE_INDICATORS.has(found.indicator) || Object.values(found.activity).some((count) => count > 0) } : thread;
  }).sort((a, b) => Number(b.active) - Number(a.active) || (current.get(b.id)?.updatedAt ?? 0) - (current.get(a.id)?.updatedAt ?? 0));
}
