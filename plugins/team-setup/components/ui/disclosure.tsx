import * as React from "react";

import { Icon } from "./icon";

/** A chevron disclosure: collapsed by default, with its open state held by
 * the caller so it can fetch on first open and keep the state for the
 * session. */
export function Disclosure({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          {description !== undefined ? <span className="text-xs text-muted-foreground">{description}</span> : null}
        </span>
      </button>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </div>
  );
}
