import { useLayoutEffect, useState, type CSSProperties } from "react";
import { useIsCompactViewport } from "../../components/ui/hooks/use-compact-viewport";
import { SELECTORS } from "../constants";

export interface DialogPosition {
  centerX: number;
  maxWidth: number;
}

const DIALOG_MIN_WIDTH_PX = 280;
const STRIP_MARGIN_PX = 16;

// The embedded Browser tab is a native view painted above the page. bb draws
// its own HTML (new tab screen, load error) in the tab's content element, the
// last child of the tab root, only while that view is off. A lone img there is
// the snapshot bb shows during a window resize.
export function nativeViewRect(browserTab: Element): DOMRect | null {
  const content = browserTab.lastElementChild;
  if (content === null) return null;
  const showsHostMarkup = Array.from(content.children).some(
    (child) => child.tagName !== "IMG",
  );
  if (showsHostMarkup) return null;
  const rect = content.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function visibleNativeViewRects(doc: Document = document): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const browserTab of doc.querySelectorAll(SELECTORS.browser)) {
    const rect = nativeViewRect(browserTab);
    if (rect !== null) rects.push(rect);
  }
  return rects;
}

export function dialogPosition(
  nativeViews: readonly Pick<DOMRect, "left">[],
  dialogMaxWidthPx: number,
): DialogPosition | null {
  if (nativeViews.length === 0) return null;
  const stripWidth = Math.min(...nativeViews.map((rect) => rect.left));
  const maxWidth = Math.min(dialogMaxWidthPx, stripWidth - 2 * STRIP_MARGIN_PX);
  if (maxWidth < DIALOG_MIN_WIDTH_PX) return null;
  return { centerX: stripWidth / 2, maxWidth };
}

function isSamePosition(
  a: DialogPosition | null,
  b: DialogPosition | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.centerX === b.centerX && a.maxWidth === b.maxWidth;
}

export function useDialogPositionStyle(
  isOpen: boolean,
  dialogMaxWidthPx: number,
): CSSProperties | undefined {
  const isCompact = useIsCompactViewport();
  const [position, setPosition] = useState<DialogPosition | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = (): void => {
      const next = isCompact
        ? null
        : dialogPosition(visibleNativeViewRects(), dialogMaxWidthPx);
      setPosition((current) =>
        isSamePosition(current, next) ? current : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isOpen, isCompact, dialogMaxWidthPx]);

  if (position === null) return undefined;
  return { left: `${position.centerX}px`, maxWidth: `${position.maxWidth}px` };
}
