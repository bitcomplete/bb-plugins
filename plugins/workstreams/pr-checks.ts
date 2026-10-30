/** Check conclusions from a scan. Unknown results are neither green nor a repair signal. */
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

export function checksFailed(conclusions: readonly string[]): boolean {
  return conclusions.some((value) => FAILED.has(value));
}

/** An empty rollup is green because some repositories run no checks. */
export function checksGreen(conclusions: readonly string[]): boolean {
  return conclusions.every((value) => GREEN.has(value));
}

