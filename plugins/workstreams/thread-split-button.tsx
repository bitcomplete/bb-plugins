import { experimental_useSidebarThreadActions, experimental_useSidebarThreadSplit } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

/** BB owns split placement, focusing an existing pane, and viewport availability. */
export function ThreadSplitButton({ threadId, onOpened, compact = false }: { threadId: string; onOpened?: () => void; compact?: boolean }) {
  const actions = experimental_useSidebarThreadActions();
  const split = experimental_useSidebarThreadSplit(threadId);
  if (!split.isAvailable) return null;
  return <button type="button" role={compact ? "menuitem" : undefined} aria-label="Open thread in split" title="Open thread in split" data-thread-entry
    onClick={(event) => { event.stopPropagation(); actions.open(threadId, { split: true }); onOpened?.(); }}
    className={cn("shrink-0 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", compact ? "mr-1 flex size-6 items-center justify-center hover:bg-foreground/[0.08]" : "underline underline-offset-2")}>
    {compact ? "↗" : "Open beside board"}
  </button>;
}
