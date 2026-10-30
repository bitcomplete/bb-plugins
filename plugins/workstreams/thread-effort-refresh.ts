/** One read in flight, with a single follow-up for a burst of board/deck events. A save invalidates older replies. */
export function createThreadEffortRefresh<T>(options: {
  read(): Promise<T>;
  apply(value: T, list: boolean): void;
  failed(cause: unknown): void;
  settleMs?: number;
}) {
  let disposed = false;
  let held = false;
  let running = false;
  let wanted = false;
  let listWanted = false;
  let activeList = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (disposed || held || running || !wanted || timer !== null) return;
    // Do not reset the timer on new events: a steady stream must still make progress.
    timer = setTimeout(() => { timer = null; void run(); }, options.settleMs ?? 80);
  };
  const run = async () => {
    if (disposed || held || running || !wanted) return;
    running = true;
    wanted = false;
    const list = listWanted;
    activeList = list;
    listWanted = false;
    const at = generation;
    try {
      const value = await options.read();
      if (!disposed && !held && at === generation) options.apply(value, list);
    } catch (cause) {
      if (!disposed && !held && at === generation) options.failed(cause);
    } finally {
      running = false;
      activeList = false;
      schedule();
    }
  };
  return {
    request(list = false) { if (!disposed) { wanted = true; listWanted ||= list; schedule(); } },
    hold() {
      held = true;
      generation++;
      // Preserve an opening's list request if a save overtook that read.
      if (running) { wanted = true; listWanted ||= activeList; }
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    resume() { held = false; schedule(); },
    dispose() { disposed = true; generation++; if (timer !== null) clearTimeout(timer); },
  };
}
