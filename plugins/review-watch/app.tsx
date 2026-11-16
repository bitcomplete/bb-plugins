// Review Watch owns the durable inbox; PR Board owns its navigation and page.
import { useCallback, useEffect, useRef } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { definePluginApp, UrlLink, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { QueueItem, Rule } from "./src/types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { createSnapshotCache, useSnapshot } from "./lib/snapshot-cache";
import type { z } from "zod";

const UNIFIED_REVIEWS_URL = "/plugins/pr-board/pr-board/to-review";
const SECTIONS: readonly { rule: Rule; title: string }[] = [
  { rule: "review-requested", title: "Needs your review" },
  { rule: "review-followup", title: "Needs a follow-up" },
];
function ruleLabel(rule: Rule): string {
  return SECTIONS.find((section) => section.rule === rule)?.title ?? rule;
}

type LastPoll = { at: string; ok: boolean; error?: string } | null;

function SyncFailureNotice({ lastPoll }: { lastPoll: LastPoll }) {
  if (lastPoll === null || lastPoll.ok) return null;
  const date = new Date(lastPoll.at);
  const time = Number.isNaN(date.valueOf())
    ? lastPoll.at
    : date.toLocaleString();
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Last sync failed at <time dateTime={lastPoll.at}>{time}</time>
      {`: ${lastPoll.error || "The poll did not complete."}`}
    </p>
  );
}

function QueueCountChip({
  count,
  className,
}: {
  count: number;
  className: string;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const previousCount = useRef(count);
  useEffect(() => {
    if (previousCount.current === count) return;
    previousCount.current = count;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = chipRef.current?.animate(
      [
        { transform: "translateY(1px) scale(0.96)", opacity: 0.72 },
        { transform: "translateY(-2px) scale(1.06)", opacity: 1 },
        { transform: "translateY(0) scale(1)", opacity: 1 },
      ],
      { duration: 240, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
    );
    return () => animation?.cancel();
  }, [count]);
  return (
    <span ref={chipRef} className={className}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

function QueueCountChips({
  initial,
  followups,
}: {
  initial: number;
  followups: number;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted tabular-nums",
        "gap-1.5 px-1.5 py-0.5",
      )}
    >
      <QueueCountChip
        count={initial}
        className="inline-flex min-w-4 justify-center rounded bg-primary/10 px-1 py-1 text-[10px] font-medium leading-none text-primary"
      />
      <QueueCountChip
        count={followups}
        className="inline-flex min-w-4 justify-center rounded bg-amber-500/10 px-1 py-1 text-[10px] font-medium leading-none text-amber-800 dark:text-amber-200"
      />
    </span>
  );
}

/** Split-pane headers share one cached queue read and realtime subscription. */
export const queueCache = createSnapshotCache<z.infer<(typeof rpcContract)["queue_list"]["output"]>>();

function useActiveReviewItems(): { items: QueueItem[]; lastPoll: LastPoll } {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("queue_list"), [rpc]);
  const snapshot = useSnapshot(queueCache, load);
  const refetch = useCallback(() => queueCache.refresh(load), [load]);
  useRealtime("queue-changed", refetch);
  return {
    items: snapshot.data?.items.filter((item) => item.state === "queued" || item.state === "started") ?? [],
    lastPoll: snapshot.data?.lastPoll ?? null,
  };
}

/**
 * The same two counts in the thread header, so review work stays visible
 * while the user works in a thread, including when the queue is empty.
 */
function QueuedHeaderAction({
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { items, lastPoll } = useActiveReviewItems();
  const initial = items.filter((item) => item.rule === "review-requested").length;
  const followups = items.filter((item) => item.rule === "review-followup").length;
  const activeCount = items.length;
  const previewItems = [...items].sort((left, right) => {
    const ruleOrder = SECTIONS.findIndex((section) => section.rule === left.rule)
      - SECTIONS.findIndex((section) => section.rule === right.rule);
    return ruleOrder || right.updatedAt.localeCompare(left.updatedAt);
  });
  // The registration's `title` labels the host's wrapper, not this button.
  const label = `${initial} initial reviews, ${followups} follow-up reviews`;
  return (
    <HoverCard.Root openDelay={250} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            // Keep the action at 28px to match neighboring header controls.
            isCompactViewport ? "h-7 gap-1 px-1.5" : "h-7 gap-1.5 px-2",
          )}
          aria-label={label}
        >
          <UrlLink href={UNIFIED_REVIEWS_URL}>
            <Icon name="GitPullRequest" className="size-4" />
            <QueueCountChips
              initial={initial}
              followups={followups}
            />
          </UrlLink>
        </Button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex flex-wrap gap-x-2 text-xs font-medium">
              <span>Initial: {initial}</span>
              <span>Follow-ups: {followups}</span>
            </span>
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-7"
            >
              <UrlLink href={UNIFIED_REVIEWS_URL}>Open To review</UrlLink>
            </Button>
          </div>
          <SyncFailureNotice lastPoll={lastPoll} />
          {previewItems.length === 0 ? (
            <p role="status" className="py-2 text-xs text-muted-foreground">
              No review requests or follow-ups queued.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {previewItems.slice(0, 5).map((item) => (
                <li key={item.key} className="py-2 first:pt-0 last:pb-0">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {item.repo}#{item.number}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-medium">
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {ruleLabel(item.rule)}
                  </p>
                  {item.state === "started" ? (
                    <p className="mt-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
                      Review not sent
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {activeCount > 5 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              +{activeCount - 5} more
            </p>
          ) : null}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "queued-count",
    title: "Review queue",
    component: QueuedHeaderAction,
  });
});
