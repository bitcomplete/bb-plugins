// The thread dot's menu, shared by the Board and the Map. Hover opens it and
// a short delay closes it, so the pointer can cross into it; a click pins it;
// Escape or an outside click closes it. Every entry is a button that opens its
// thread, and the arrow keys move between them. The rules are in menustate.ts.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { CLOSED, HOVER_CLOSE_MS, menuEntries, menuReducer, nextIndex, threadDotLabel, type MenuEvent } from "./menustate";
import type { ThreadTier } from "./threads";
import { POINTER_CURSORS, cn } from "@/lib/utils";

export type MenuThread = { id: string; title: string; active: boolean; tier: ThreadTier };

export const TIER_WORDS: Record<ThreadTier, string> = {
  started: "started here",
  environment: "runs here",
  ticket: "names it",
  paths: "worked here",
};

export function ThreadMenu({
  threads,
  onOpenThread,
  onMore,
  heading,
  footer,
  className,
  style,
  onHoverChange,
  data,
  children,
}: {
  /** Already in display order. */
  threads: readonly MenuThread[];
  onOpenThread: (id: string) => void;
  /** "+N more": fly to the cluster on the Map, where the full list is. */
  onMore: () => void;
  heading?: ReactNode;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Hover or focus on the dot, for callers that key off it (the Map's T). */
  onHoverChange?: (hovering: boolean) => void;
  /** Extra `data-*` attributes for the dot, e.g. the Map's drag exclusion marker. */
  data?: Record<`data-${string}`, string>;
  /** The dot itself. */
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(menuReducer, CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const send = useCallback((event: MenuEvent) => dispatch(event), []);
  const enter = useCallback(() => {
    cancel();
    send("hover");
  }, [cancel, send]);
  const leave = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => send("hover-timeout"), HOVER_CLOSE_MS);
  }, [cancel, send]);
  useEffect(() => cancel, [cancel]);

  const { shown, more } = menuEntries(threads);
  const label = threadDotLabel(threads.length);
  const entries = (): HTMLButtonElement[] =>
    listRef.current === null ? [] : Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("[data-thread-entry]"));

  return (
    <PopoverPrimitive.Root open={state.open} onOpenChange={(open) => (open ? null : send("dismiss"))}>
      <PopoverPrimitive.Anchor asChild>
        <button
          ref={anchorRef}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={state.open}
          className={className}
          style={style}
          {...data}
          onClick={(event) => {
            event.stopPropagation();
            send("click");
          }}
          onPointerEnter={() => {
            enter();
            onHoverChange?.(true);
          }}
          onPointerLeave={() => {
            leave();
            onHoverChange?.(false);
          }}
          onFocus={() => onHoverChange?.(true)}
          onBlur={() => onHoverChange?.(false)}
        >
          {children}
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onPointerEnter={enter}
          onPointerLeave={() => (state.pinned ? null : leave())}
          // Hover must not steal focus from wherever the reader is; a click or key does move it in.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (state.pinned) entries()[0]?.focus();
          }}
          onInteractOutside={(event) => {
            // The dot's own click toggles; let it, rather than closing and reopening.
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            "z-50 w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            POINTER_CURSORS,
          )}
        >
          <div
            ref={listRef}
            role="menu"
            aria-label={label}
            onKeyDown={(event) => {
              const list = entries();
              const index = nextIndex(list.indexOf(document.activeElement as HTMLButtonElement), event.key, list.length);
              if (index === null) return;
              event.preventDefault();
              list[index]?.focus();
            }}
          >
            {heading === undefined ? null : <p className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted-foreground">{heading}</p>}
            {shown.map((thread) => (
              <button
                key={thread.id}
                type="button"
                role="menuitem"
                data-thread-entry
                onClick={() => {
                  send("dismiss");
                  onOpenThread(thread.id);
                }}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[11.5px] outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.08]"
              >
                <span
                  aria-hidden
                  className={cn("size-[7px] shrink-0 rounded-full", thread.active ? "bg-foreground" : "bg-foreground/40")}
                />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-[10.5px] text-muted-foreground">
                  {thread.active ? "running" : "idle"} · {TIER_WORDS[thread.tier]}
                </span>
              </button>
            ))}
            {more === 0 ? null : (
              <button
                type="button"
                role="menuitem"
                data-thread-entry
                onClick={() => {
                  send("dismiss");
                  onMore();
                }}
                className="w-full rounded-md px-2 py-1 pl-[23px] text-left text-[11px] text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground focus-visible:bg-foreground/[0.08]"
              >
                +{more} more · show on the Map
              </button>
            )}
            {footer === undefined ? null : (
              <p className="mt-1 border-t border-border/70 px-2 pb-0.5 pt-1.5 text-[11px] text-muted-foreground">{footer}</p>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
