import { useEffect } from "react";
import { toast } from "sonner";
import { PLUGIN_ID } from "../constants";
import type { Notice } from "../types";
import { useUiState } from "./hooks";

// One toast id for every notice: a new notice replaces the previous one in
// bb's toast host and notification center instead of piling up.
export const NOTICE_TOAST_ID = `${PLUGIN_ID}-notice`;

let lastShownNotice: Notice | null = null;

export function Notices(): null {
  const notice = useUiState((state) => state.notice);

  useEffect(() => {
    if (notice === null || notice === lastShownNotice) return;
    lastShownNotice = notice;
    toast(notice.text, { id: NOTICE_TOAST_ID });
  }, [notice]);

  return null;
}
