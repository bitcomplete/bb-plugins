// The one tooltip every icon-only control uses: the host-shimmed Radix
// Tooltip, a 300ms open delay, and one style. The label should name the action
// and its shortcut, e.g. "Open checkout (o)", and match the control's aria-label.
import type { ReactElement } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

export function Tip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-[60] max-w-64 whitespace-pre-line rounded-md bg-foreground px-2 py-1 text-[11px] leading-snug text-background shadow-sm"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
