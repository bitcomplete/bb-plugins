// BB-413 (BB-291 criterion 8, slice C7): the composed holds, as one pure
// derivation over a binding's fields. It lives in its own module so every
// reader shares it without an import cycle: the composer folds it into
// `ComposedAssessment.holds`, `idleInActiveStage` and `atWork` read the `hold`,
// `ending` and `requeue` holds, the card/sidebar row and `bb stewards show`
// read `hold`/`behind`/`merge-behind`, and the wake renders the same set.
//
// It is pure over the binding and `now`, so it adds no store read or source
// call wherever it is called.

/**
 * The source a hold comes from, as the composer names it. The built-in
 * contributors are `github`, `linear` and `local`; a source plugin that serves
 * its own contribution (BB-418, BB-291 C10) may use any id.
 */
export type HoldSource = string;

/**
 * One hold a source contributes: the binding's hold, ending and requeue, the
 * scheduling holds `behind` (BB-215's hold behind another binding), `stack`
 * (BB-215's stack-wait) and `merge-behind` (BB-256's merge hold), and the
 * ready-gate hold. `behind` carries the entity keys a `behind`, `stack` or
 * `merge-behind` hold waits on.
 */
export type HoldContribution = {
  source: HoldSource;
  /** `hold`, `ending`, `requeue`, `behind`, `stack`, `merge-behind` or `ready-gate`. */
  id: string;
  held: boolean;
  behind: readonly string[];
};

/** The binding fields the composed holds read. */
export type HoldFields = {
  hold: string | null;
  ending: string | null;
  requeueUntil: number | null;
  holdBehind?: readonly string[];
  holdStack?: readonly string[];
  mergeBehind?: readonly string[];
};

/**
 * The scheduling holds a binding carries, one item per kind: `hold`, `ending`,
 * `requeue` (a dated wait still ahead), `behind`, `stack` and `merge-behind`.
 * The `hold`/`behind`/`stack`/`merge-behind` rows are what the retired
 * live-source predicate read; `ending` and `requeue` are what
 * `idleInActiveStage` reads. The ready-gate hold is core policy and is added by
 * the composer, which has the playbook and the spec hash.
 */
export function schedulingHolds(b: HoldFields, now: number): HoldContribution[] {
  return [
    { source: "local", id: "hold", held: b.hold !== null, behind: [] },
    { source: "local", id: "ending", held: b.ending !== null, behind: [] },
    { source: "local", id: "requeue", held: b.requeueUntil !== null && b.requeueUntil > now, behind: [] },
    { source: "local", id: "behind", held: (b.holdBehind ?? []).length > 0, behind: b.holdBehind ?? [] },
    { source: "local", id: "stack", held: (b.holdStack ?? []).length > 0, behind: b.holdStack ?? [] },
    { source: "local", id: "merge-behind", held: (b.mergeBehind ?? []).length > 0, behind: b.mergeBehind ?? [] },
  ];
}

/** Whether the binding's composed `hold` hold is held, the one hold that gates a turn. */
export const bindingHeld = (b: HoldFields, now: number = Date.now()): boolean => schedulingHolds(b, now).some((h) => h.id === "hold" && h.held);
