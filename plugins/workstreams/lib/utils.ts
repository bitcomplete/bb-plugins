import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatHomePathForDisplay(pathValue: string): string {
  const homePrefix =
    pathValue.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/root(?=\/|$)/)?.[0] ??
    pathValue.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i)?.[0];
  return homePrefix === undefined
    ? pathValue
    : `~${pathValue.slice(homePrefix.length)}`;
}

/**
 * Pointer cursors for the plugin's own controls. Preflight leaves buttons on
 * the arrow cursor; this puts the pointer back, but only below the element that
 * carries the class — the plugin's root and its portalled overlays — so the
 * host app around it is never affected. Disabled controls read as not allowed.
 */
export const POINTER_CURSORS =
  "[&_button:not(:disabled)]:cursor-pointer [&_[role=button]]:cursor-pointer [&_[role=menuitem]]:cursor-pointer [&_[role=option]]:cursor-pointer [&_[role=tab]]:cursor-pointer [&_a[href]]:cursor-pointer [&_summary]:cursor-pointer [&_label:has(button:not(:disabled))]:cursor-pointer [&_:disabled]:cursor-not-allowed [&_[aria-disabled=true]]:cursor-not-allowed";
