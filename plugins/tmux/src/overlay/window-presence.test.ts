// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LOCKS } from "../constants";
import {
  installFakeLocks,
  removeFakeLocks,
  THIS_WINDOW_CLIENT_ID,
  type FakeLock,
} from "./test-support";
import { announceWindow, lockManagerOrNull } from "./window-presence";

const NAME = PLUGIN_LOCKS.openWindow;

function install(heldElsewhere: readonly FakeLock[] = []) {
  const fake = installFakeLocks(heldElsewhere);
  return { ...fake, manager: fake.locks as unknown as LockManager };
}

afterEach(() => {
  removeFakeLocks();
});

describe("lockManagerOrNull", () => {
  it("is null where the browser has no Web Locks API", () => {
    expect(lockManagerOrNull()).toBeNull();
  });

  it("is the browser's lock manager where there is one", () => {
    const { locks } = install();
    expect(lockManagerOrNull()).toBe(locks);
  });
});

describe("announceWindow", () => {
  it("reports no other window when this one is the only holder", async () => {
    const { manager, held } = install();

    const presence = announceWindow(manager);

    expect(await presence.hasOtherWindow).toBe(false);
    expect(held).toEqual([{ name: NAME, clientId: THIS_WINDOW_CLIENT_ID }]);
    presence.release();
  });

  it("reports another window that holds the lock", async () => {
    const { manager } = install([{ name: NAME, clientId: "other-window" }]);

    const presence = announceWindow(manager);

    expect(await presence.hasOtherWindow).toBe(true);
    presence.release();
  });

  it("does not count this window twice, nor locks with another name", async () => {
    const { manager } = install([
      { name: NAME, clientId: THIS_WINDOW_CLIENT_ID },
      { name: "something-else", clientId: "other-window" },
    ]);

    const presence = announceWindow(manager);

    expect(await presence.hasOtherWindow).toBe(false);
    presence.release();
  });

  it("holds the lock until it is released", async () => {
    const { manager, held } = install();
    const presence = announceWindow(manager);
    await presence.hasOtherWindow;
    expect(held).toHaveLength(1);

    presence.release();

    await vi.waitFor(() => expect(held).toHaveLength(0));
  });

  it("reports no other window when the browser cannot list the locks", async () => {
    const { manager, locks, held } = install();
    locks.query = () => Promise.reject(new Error("not allowed"));

    const presence = announceWindow(manager);

    expect(await presence.hasOtherWindow).toBe(false);
    expect(held).toHaveLength(1);
    presence.release();
  });

  it.each([
    ["is refused", () => Promise.reject(new Error("not allowed"))],
    [
      "throws",
      () => {
        throw new Error("not allowed");
      },
    ],
  ])("reports no other window when the lock request %s", async (_label, request) => {
    const { manager, locks } = install();
    locks.request = request;

    expect(await announceWindow(manager).hasOtherWindow).toBe(false);
  });
});
