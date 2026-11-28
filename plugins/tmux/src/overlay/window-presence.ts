import { PLUGIN_LOCKS } from "../constants";

export interface WindowPresence {
  hasOtherWindow: Promise<boolean>;
  release: () => void;
}

// The Web Locks API is missing on pages that are not served over HTTPS or
// from localhost.
export function lockManagerOrNull(): LockManager | null {
  const { locks } = navigator as Partial<Pick<Navigator, "locks">>;
  return locks ?? null;
}

async function hasOtherHolder(locks: LockManager): Promise<boolean> {
  const { held = [] } = await locks.query();
  const holders = new Set(
    held
      .filter((lock) => lock.name === PLUGIN_LOCKS.openWindow)
      .map((lock) => lock.clientId),
  );
  return holders.size > 1;
}

// Every bb window holds one shared lock until release() is called. The
// browser drops the lock of a window that closes or crashes, so the holders
// are exactly the bb windows that are open right now.
export function announceWindow(locks: LockManager): WindowPresence {
  let release = (): void => {};
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hasOtherWindow = new Promise<boolean>((resolve) => {
    const holdLock = async (): Promise<void> => {
      await locks.request(
        PLUGIN_LOCKS.openWindow,
        { mode: "shared" },
        async () => {
          resolve(await hasOtherHolder(locks).catch(() => false));
          await untilReleased;
        },
      );
    };
    holdLock().catch(() => resolve(false));
  });
  return { hasOtherWindow, release };
}
