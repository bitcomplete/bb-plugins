import * as React from "react";

/** A small confirm dialog. A native <dialog> would need a ref and showModal;
 * this is the two pieces the Advanced section needs, with the usual dialog
 * semantics. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>
        {footer !== undefined ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}
