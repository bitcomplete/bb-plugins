// In-memory counting of store reads and GitHub/Linear source calls, per
// reconcile and per wake (BB-297). Nothing here reads the store or a source:
// counting wraps a call that already happens and adds an increment, so a
// measured run performs exactly the reads an unmeasured one does. The counters
// are per process and reset by a restart, like the per-method table (BB-100).
import { AsyncLocalStorage } from "node:async_hooks";

/** Store reads and GitHub/Linear source calls in one measured scope. */
export type CallCounts = { storeReads: number; sourceCalls: number };

/**
 * One reconcile pass: the reads and source calls of every reconcile that ran
 * since the pass began, how many reconciles that was, and the number of open
 * bindings the pass was taken at. The pass is what `bb stewards stats` reports
 * so the owner can divide the load by the binding count.
 */
export type ReconcilePassCounts = CallCounts & { reconciles: number; bindings: number };

/** Every wake since the process started: its reads, source calls and count. */
export type WakeCounts = CallCounts & { wakes: number };

export type ReadCountSnapshot = { reconcile: ReconcilePassCounts; wake: WakeCounts };

export interface ReadCounts {
  /** Count one store read. A no-op outside a measured reconcile or wake. */
  storeRead(): void;
  /** Count one GitHub/Linear source call. A no-op outside a measured reconcile or wake. */
  sourceCall(): void;
  /**
   * Start a new reconcile pass, resetting the totals and recording the
   * binding count the pass is taken at. Called by the sweep before it looks
   * at a project's bindings.
   */
  beginReconcilePass(bindings: number): void;
  /** Run one reconcile, adding its reads and source calls to the current pass. */
  runReconcile<T>(fn: () => Promise<T>): Promise<T>;
  /** Run one wake, adding its reads and source calls to the wake totals. */
  runWake<T>(fn: () => Promise<T>): Promise<T>;
  /** The counters as `bb stewards stats` and the overview read them. */
  snapshot(): ReadCountSnapshot;
}

export function createReadCounts(): ReadCounts {
  // A reconcile and a wake each run in their own async context, so overlapping
  // reconciles of different bindings never mix their counts, and a wake inside
  // a reconcile counts in both. `node:async_hooks` keeps the scopes apart the
  // same way the store's turn coalescing does (BB-95).
  const reconcileScope = new AsyncLocalStorage<CallCounts>();
  const wakeScope = new AsyncLocalStorage<CallCounts>();
  let pass: ReconcilePassCounts = { storeReads: 0, sourceCalls: 0, reconciles: 0, bindings: 0 };
  let wake: WakeCounts = { storeReads: 0, sourceCalls: 0, wakes: 0 };

  return {
    storeRead(): void {
      const reconcile = reconcileScope.getStore();
      if (reconcile !== undefined) reconcile.storeReads += 1;
      const w = wakeScope.getStore();
      if (w !== undefined) w.storeReads += 1;
    },
    sourceCall(): void {
      const reconcile = reconcileScope.getStore();
      if (reconcile !== undefined) reconcile.sourceCalls += 1;
      const w = wakeScope.getStore();
      if (w !== undefined) w.sourceCalls += 1;
    },
    beginReconcilePass(bindings: number): void {
      pass = { storeReads: 0, sourceCalls: 0, reconciles: 0, bindings };
    },
    async runReconcile<T>(fn: () => Promise<T>): Promise<T> {
      const scope: CallCounts = { storeReads: 0, sourceCalls: 0 };
      try {
        return await reconcileScope.run(scope, fn);
      } finally {
        pass.storeReads += scope.storeReads;
        pass.sourceCalls += scope.sourceCalls;
        pass.reconciles += 1;
      }
    },
    async runWake<T>(fn: () => Promise<T>): Promise<T> {
      const scope: CallCounts = { storeReads: 0, sourceCalls: 0 };
      try {
        return await wakeScope.run(scope, fn);
      } finally {
        wake.storeReads += scope.storeReads;
        wake.sourceCalls += scope.sourceCalls;
        wake.wakes += 1;
      }
    },
    snapshot(): ReadCountSnapshot {
      return { reconcile: { ...pass }, wake: { ...wake } };
    },
  };
}

/** The part of a prepared statement the wrapper counts: the methods that read rows. */
type ReadableStatement = { get?: unknown; all?: unknown; iterate?: unknown };

/**
 * Wrap one prepared statement so `.get`, `.all` and `.iterate` count as a
 * store read. `.run` and every other method pass through untouched: a write
 * is not a read, and the wrapper must not change what the statement does.
 */
function countingStatement(statement: object, onRead: () => void): object {
  return new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "get" || property === "all" || property === "iterate") {
        const method = Reflect.get(target, property, target) as ((...args: unknown[]) => unknown) | undefined;
        if (typeof method !== "function") return method;
        return (...args: unknown[]): unknown => {
          onRead();
          return method.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      // `run` and the rest are native methods that need the real statement as
      // `this`; calling through the proxy would be an illegal invocation.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap a better-sqlite3 database so every statement it prepares counts its
 * reads. `createStore` prepares its statements through this, so every store
 * read is counted and no read of the wrapper's own is added. `transaction` and
 * every other method are bound to the real database and pass through.
 */
export function countingDatabase<D extends { prepare(sql: string): ReadableStatement }>(db: D, onRead: () => void): D {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string): ReadableStatement => countingStatement(target.prepare(sql), onRead) as ReadableStatement;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D;
}
