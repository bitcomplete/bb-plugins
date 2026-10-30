// Where each thread belongs on the effort deck (plan amendment A17.1), so no
// thread is outside a card. Pure and import-free: the server gathers each
// thread's evidence, the deck read model and the thread's effort chip both
// place it with this one rule, and nothing is stored.
//
// An explicit effort always wins: the thread's own, the one it coordinates,
// then the effort most of its own PRs are in. Without one, the thread goes to
// the service card of the repository most of its own PRs are in (a tie goes
// to the repository its environment is in, when that is one of the tied),
// else of the checkout only it runs in. Anything else is a loose thread.
//
// A thread's own PRs are the ones it links through its own work: a recorded or
// started link, a ticket in its title, an action it ran, or the PR in a
// checkout only it runs in. A link only through a checkout other threads
// share says nothing about the PR checked out there now, so it never counts:
// in a clone many threads run in, every one of them would otherwise land on
// whatever branch is checked out.

/** What places one thread, as the server gathers it. Repositories are `owner/repo`, lowercased. */
export type ThreadEvidence = {
  id: string;
  /** Its own effort (its intent), else the one it coordinates. */
  effortId: string | null;
  /** Its own PRs, open or not, each with its repository and the effort that owns it. */
  prs: readonly { url: string; repo: string; effortId: string | null }[];
  /** The repository of the checkout only it runs in, with or without a PR. */
  checkout: string | null;
  /** The repository its environment is in, whether or not other threads share it: it only breaks a tie. */
  environment: string | null;
};
export type ThreadHome = { kind: "effort"; id: string } | { kind: "service"; repo: string } | { kind: "loose" };

/** The keys that appear most often; several on a tie, none for an empty list. */
function most(keys: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  return [...counts].filter(([, n]) => n === top && top > 0).map(([key]) => key).sort();
}

export function threadHome(thread: ThreadEvidence): ThreadHome {
  if (thread.effortId) return { kind: "effort", id: thread.effortId };
  // Two efforts tied for its PRs: the first by id, so the thread doesn't move between reads.
  const [effort] = most(thread.prs.flatMap((pr) => pr.effortId ?? []));
  if (effort) return { kind: "effort", id: effort };
  const repos = most(thread.prs.map((pr) => pr.repo.toLowerCase()));
  if (repos.length === 1) return { kind: "service", repo: repos[0]! };
  if (repos.length > 1) {
    const environment = thread.environment?.toLowerCase() ?? null;
    return environment && repos.includes(environment) ? { kind: "service", repo: environment } : { kind: "loose" };
  }
  return thread.checkout ? { kind: "service", repo: thread.checkout.toLowerCase() } : { kind: "loose" };
}
