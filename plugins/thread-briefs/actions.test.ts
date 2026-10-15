import { describe, expect, it, vi } from "vitest";
import type { RowSignal } from "./contract.js";
import { stageAction, statusAction, type PinWrites } from "./actions.js";
import { stageRingIcon } from "./brief.js";

const signal = (overrides: Partial<RowSignal> = {}): RowSignal => ({
  threadId: "thr_1",
  status: "waiting-on-me",
  stage: "implementation",
  label: "Implementation — Waiting on you",
  pinned: false,
  stageOverride: null,
  statusOverride: null,
  ...overrides,
});

const writes = (): PinWrites & {
  setStage: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
} => ({
  setStage: vi.fn(async () => {}),
  setStatus: vi.fn(async () => {}),
});

const run = { requestRename: () => {} };

describe("the Stage action", () => {
  it("is hidden on a thread with no brief", () => {
    expect(stageAction(undefined, writes())).toBeNull();
  });

  it("names the stage, wears its ring, and lists every stage", () => {
    const action = stageAction(signal(), writes())!;
    expect(action.detail).toBe("Implementation");
    expect(action.icon).toBe(stageRingIcon("implementation"));
    expect(action.choices?.hint).toBeUndefined();
    expect(action.choices?.items).toEqual([
      { id: "discovery", label: "Discovery", icon: stageRingIcon("discovery"), selected: false },
      { id: "planning", label: "Planning", icon: stageRingIcon("planning"), selected: false },
      {
        id: "implementation",
        label: "Implementation",
        icon: stageRingIcon("implementation"),
        selected: true,
      },
      { id: "review", label: "Review", icon: stageRingIcon("review"), selected: false },
    ]);
  });

  it("pins the stage picked", async () => {
    const pins = writes();
    await stageAction(signal(), pins)!.run({ ...run, value: "review" });
    expect(pins.setStage).toHaveBeenCalledWith("thr_1", "review");
  });

  it("pins the model's own stage too, as the panel does", async () => {
    const pins = writes();
    await stageAction(signal(), pins)!.run({ ...run, value: "implementation" });
    expect(pins.setStage).toHaveBeenCalledWith("thr_1", "implementation");
  });

  it("says a pin is a pin, and clears it when picked again", async () => {
    const pins = writes();
    const action = stageAction(
      signal({ stage: "review", stageOverride: "review", pinned: true }),
      pins,
    )!;
    expect(action.detail).toBe("Review · set by hand");
    expect(action.choices?.hint).toMatch(/clears on the next turn/);
    await action.run({ ...run, value: "review" });
    expect(pins.setStage).toHaveBeenCalledWith("thr_1", null);
  });

  it("ignores a value that is not a stage", async () => {
    const pins = writes();
    await stageAction(signal(), pins)!.run({ ...run, value: "nonsense" });
    await stageAction(signal(), pins)!.run(run);
    expect(pins.setStage).not.toHaveBeenCalled();
  });
});

describe("the Status action", () => {
  it("is hidden on a thread with no brief", () => {
    expect(statusAction(undefined, false, writes())).toBeNull();
  });

  it("offers the three statuses a pin may take, never working", () => {
    const action = statusAction(signal(), false, writes())!;
    expect(action.detail).toBe("Waiting on you");
    expect(action.choices?.items.map((item) => item.id)).toEqual([
      "waiting-on-me",
      "waiting-on-other",
      "done",
    ]);
    expect(action.choices?.items.find((item) => item.selected)?.id).toBe(
      "waiting-on-me",
    );
  });

  it("says Working while the agent runs, with nothing selected", () => {
    const action = statusAction(signal(), true, writes())!;
    expect(action.detail).toBe("Working");
    expect(action.choices?.items.some((item) => item.selected)).toBe(false);
  });

  it("pins the status picked, and clears a pin picked again", async () => {
    const pins = writes();
    await statusAction(signal(), false, pins)!.run({ ...run, value: "done" });
    expect(pins.setStatus).toHaveBeenLastCalledWith("thr_1", "done");

    const pinned = statusAction(
      signal({ status: "done", statusOverride: "done", pinned: true }),
      false,
      pins,
    )!;
    expect(pinned.detail).toBe("Done · set by hand");
    await pinned.run({ ...run, value: "done" });
    expect(pins.setStatus).toHaveBeenLastCalledWith("thr_1", null);
  });

  it("refuses working as a pin", async () => {
    const pins = writes();
    await statusAction(signal(), false, pins)!.run({ ...run, value: "working" });
    expect(pins.setStatus).not.toHaveBeenCalled();
  });
});
