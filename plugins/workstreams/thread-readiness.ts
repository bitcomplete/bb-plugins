type ChildParent = { canSpawnChild: boolean; environmentHostId?: string | null };

/** A new BB thread can be readable before its environment has a host. */
export async function waitForChildParent<T extends ChildParent>(read: () => Promise<T>,
  validate: (thread: T) => void, expectedHostId: string | null, failure: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const thread = await read();
    validate(thread);
    if (expectedHostId !== null && thread.environmentHostId != null && thread.environmentHostId !== expectedHostId) {
      throw new Error(failure);
    }
    // Child capacity reflects hierarchy depth, not startup state.
    if (!thread.canSpawnChild) throw new Error(failure);
    if (expectedHostId === null || thread.environmentHostId === expectedHostId) return thread;
    if (attempt < 19) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The parent thread's workspace did not attach to its expected host within 5 seconds. Retry after it connects; its recorded thread will be reused.");
}
