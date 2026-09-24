// A reload (an install, or BB restarting the plugin) kills the host worker in
// the middle of a scan. That is a cancellation, not a failure, and logging it
// as an error makes every install look broken. This decides which it was.

/** How the host call fails when its worker is killed under it. */
const WORKER_GONE = /host plugin worker exited|timed out waiting for command result/iu;

/**
 * "cancelled" when the plugin is disposing, or when the worker died and a
 * dispose follows within `graceMs` (the worker can go down a moment before the
 * server hears it is being disposed). Anything else is a real failure.
 */
export async function scanFailure(
  error: unknown,
  disposal: AbortSignal,
  graceMs: number,
): Promise<"cancelled" | "failed"> {
  if (disposal.aborted) return "cancelled";
  if (!WORKER_GONE.test(String(error))) return "failed";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposal.removeEventListener("abort", onAbort);
      resolve("failed");
    }, graceMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("cancelled");
    };
    disposal.addEventListener("abort", onAbort, { once: true });
  });
}
