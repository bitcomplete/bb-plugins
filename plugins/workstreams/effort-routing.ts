/** A parent-child relationship is not a filesystem lock. Refuse live writers even outside Workstreams. */
export async function activeCheckoutThread(path: string, hostId: string, list: (offset: number) => Promise<readonly { id: string; status: string; environmentPath: string | null; environmentHostId?: string | null }[]>): Promise<string | null> {
  const normalize = (value: string) => value.replace(/\/+$/u, "");
  for (let offset = 0; offset < 10_000; offset += 100) {
    const rows = await list(offset);
    const active = rows.find((thread) => (thread.environmentHostId == null || thread.environmentHostId === hostId) && thread.environmentPath !== null && normalize(thread.environmentPath) === normalize(path) && !["idle", "error"].includes(thread.status));
    if (active) return active.id;
    if (rows.length < 100) return null;
  }
  throw new Error("Too many threads to verify checkout ownership. Stop competing work and try again.");
}
