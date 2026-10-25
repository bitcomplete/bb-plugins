// Scheduling: what each binding's work touches, and which open bindings would
// change the same files at the same time. Pure; the plugin feeds it bindings
// and acts on what it says (a `schedule` escalation to the project steward, a
// hold placed behind the binding already at work).
//
// A touch is a repo-relative path with the repo directory first, as the
// steward reports it: "bb-plugins/plugins/stewards", "bb-gate/docker". Two
// bindings overlap when one touch is the other or a parent directory of it,
// so "bb-plugins" overlaps everything in that repo and
// "bb-plugins/plugins/stewards/wake.ts" overlaps "bb-plugins/plugins/stewards".
import type { Binding, Observed } from "./store.js";

/** A touch as compared: lower case, forward slashes, no leading "./" or surrounding slashes, inner runs of slashes collapsed. */
export function normalizeTouch(raw: string): string {
  return raw
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .toLowerCase();
}

/** The touches a steward reported, normalized, deduplicated, empty strings dropped. */
export function normalizeTouches(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizeTouch).filter((t) => t !== ""))];
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** Whether two touch sets name the same place: a touch of one is, or is inside, a touch of the other. */
export function touchesOverlap(a: readonly string[], b: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const x of a) for (const y of b) if (under(x, y) || under(y, x)) hits.add(x.length >= y.length ? x : y);
  return [...hits].sort();
}

/**
 * Whether a binding's work is finished: every pull request it links has
 * merged, and either the entity reached a terminal state or its steward
 * reported no more are coming. A merged pull request is the whole work for a
 * `pr` binding. Unreported means not finished, so the project steward is
 * woken rather than a hold lifting silently.
 */
export function finished(b: Binding, observed: Observed): boolean {
  if (!allPullsMerged(b, observed)) return false;
  if (b.kind === "pr") return true;
  return b.endedAt !== null || b.ending === "terminal" || b.noMorePulls === true;
}

/** What a caller knows beyond the binding's last snapshot: whether a worker is still running. */
export type AtWorkOptions = { runningWorker?: boolean };

/**
 * Whether a binding is at work on its touches: being built or reviewed, or
 * cleared to start (its gate passed, nothing holds or schedules it: the
 * steward is moving it and starting a worker, and Linear's state reaches the
 * plugin a look later); not held, not ending, not ended, and not finished
 * with no worker still running. A ticket whose pull requests have merged but
 * whose steward has not reported that no more are coming is still at work:
 * the next pull request is a conflict, not a rebase.
 */
export const atWork = (b: Binding, opts: AtWorkOptions = {}): boolean =>
  b.endedAt === null &&
  b.ending === null &&
  b.hold === null &&
  (b.stage === "build" || b.stage === "review" || b.clearedToStart) &&
  b.touches.length > 0 &&
  !(b.lastSnapshot !== null && finished(b, b.lastSnapshot) && opts.runningWorker !== true);

export type Conflict = { with: Binding; on: string[] };

/**
 * The open bindings of the same project whose touches overlap `b`'s, oldest
 * first, without judging whether they are at work. `b` itself, its ancestors
 * and descendants are left out: a promoted sub-issue shares its parent's
 * paths by design. The server filters these with a fresh GitHub read before
 * filing a schedule request.
 */
export function overlapping(b: Binding, open: readonly Binding[]): Conflict[] {
  if (b.touches.length === 0) return [];
  const related = (other: Binding) => other.id === b.id || other.parentBindingId === b.id || b.parentBindingId === other.id;
  return open
    .filter((other) => other.projectId === b.projectId && !related(other))
    .map((other) => ({ with: other, on: touchesOverlap(b.touches, other.touches) }))
    .filter((c) => c.on.length > 0)
    .sort((x, y) => x.with.createdAt - y.with.createdAt);
}

/**
 * The open bindings of the same project already at work on what `b` touches,
 * oldest first, judged from the last snapshot alone. Rendering and tests use
 * this; the schedule request path re-reads GitHub first (BB-54).
 */
export function conflictsOf(b: Binding, open: readonly Binding[]): Conflict[] {
  return overlapping(b, open).filter((c) => atWork(c.with));
}

/**
 * Whether a binding's pull requests have all merged: at least one is
 * observed, and every one is merged. A ticket with no pull request yet is not
 * "all merged"; its ending is the other way a hold behind it lifts.
 */
export function allPullsMerged(b: Binding, observed: Observed): boolean {
  const pulls = b.kind === "ticket" ? observed.pulls : observed.entity.pull === null ? [] : [observed.entity];
  return pulls.length > 0 && pulls.every((p) => p.pull?.merged === true);
}
