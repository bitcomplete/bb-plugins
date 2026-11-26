// BB-413 (BB-291 criterion 8, slice C7): the composed holds in their own
// module. One derivation over the binding fields, read by the composer, the
// idle rule, `atWork`, the card row, the wake and the reconcile's held/start/
// withdraw decisions. These fixtures pin each hold kind and the `bindingHeld`
// decision the surfaces read.
import { describe, expect, it } from "vitest";
import { bindingHeld, schedulingHolds, type HoldFields } from "./holds.js";

const NOW = 1_000_000;

const fields = (over: Partial<HoldFields> = {}): HoldFields => ({ hold: null, ending: null, requeueUntil: null, holdBehind: [], holdStack: [], mergeBehind: [], ...over });

const heldIds = (b: HoldFields, now = NOW): string[] => schedulingHolds(b, now).filter((h) => h.held).map((h) => h.id);

describe("the composed holds (BB-413, C7)", () => {
  it("emits one item per hold kind, in a stable order", () => {
    expect(schedulingHolds(fields(), NOW).map((h) => h.id)).toEqual(["hold", "ending", "requeue", "behind", "stack", "merge-behind"]);
  });

  it("pins each hold kind from the binding fields", () => {
    expect(heldIds(fields({ hold: "a freeze" }))).toEqual(["hold"]);
    expect(heldIds(fields({ ending: "terminal" }))).toEqual(["ending"]);
    expect(heldIds(fields({ requeueUntil: NOW + 1 }))).toEqual(["requeue"]);
    expect(heldIds(fields({ requeueUntil: NOW - 1 }))).toEqual([]);
    expect(heldIds(fields({ holdBehind: ["ENG-13"] }))).toEqual(["behind"]);
    expect(heldIds(fields({ holdStack: ["ENG-13"] }))).toEqual(["stack"]);
    expect(heldIds(fields({ mergeBehind: ["ENG-14"] }))).toEqual(["merge-behind"]);
    expect(heldIds(fields())).toEqual([]);
  });

  it("carries the entity keys each behind/stack/merge hold waits on", () => {
    const holds = schedulingHolds(fields({ holdBehind: ["ENG-13", "ENG-14"], holdStack: ["ENG-15"], mergeBehind: ["ENG-16"] }), NOW);
    expect(holds.find((h) => h.id === "behind")!.behind).toEqual(["ENG-13", "ENG-14"]);
    expect(holds.find((h) => h.id === "stack")!.behind).toEqual(["ENG-15"]);
    expect(holds.find((h) => h.id === "merge-behind")!.behind).toEqual(["ENG-16"]);
  });

  it("bindingHeld is the composed `hold` hold the reconcile's deferral/start/withdraw sites read", () => {
    expect(bindingHeld(fields({ hold: "a freeze" }), NOW)).toBe(true);
    expect(bindingHeld(fields({ hold: null, mergeBehind: ["ENG-13"] }), NOW)).toBe(false);
    expect(bindingHeld(fields({ ending: "terminal" }), NOW)).toBe(false);
  });
});
