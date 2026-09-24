// The server's half of a direct merge: re-read live, re-check, then write.
// The dialog already showed all of this, but the server never trusts that the
// client showed it: the verdict is recomputed here, immediately before the
// write, and the write itself is pinned to the head sha the user confirmed.
import { mergeVerdict, shouldDeleteBranch, type LiveMergeFacts, type MergeMethod } from "./actions.js";
import type { PrWrite } from "./contract.js";

export type WriteResult = { ok: true; detail: string } | { ok: false; error: string };
export type LiveRead = { ok: true; live: LiveMergeFacts } | { ok: false; error: string };

export type MergeDeps = {
  live: (prUrl: string) => Promise<LiveRead>;
  write: (request: PrWrite) => Promise<WriteResult>;
};

export async function executeMerge(
  deps: MergeDeps,
  args: { prUrl: string; sha: string; acknowledgeUnresolved: boolean; method: MergeMethod; deleteBranchSetting: boolean },
): Promise<WriteResult> {
  const read = await deps.live(args.prUrl);
  if (!read.ok) return read;
  const { live } = read;
  const verdict = mergeVerdict(live);
  if (verdict.refusals.length > 0) return { ok: false, error: `Not merged. ${verdict.refusals.join(" ")}` };
  if (live.headRefOid !== args.sha) {
    return { ok: false, error: "Not merged: new commits were pushed since the dialog opened. Reopen it to review the new head." };
  }
  if (live.unresolvedThreads > 0 && !args.acknowledgeUnresolved) {
    return { ok: false, error: `Not merged: ${live.unresolvedThreads} review threads are unresolved. Tick "merge anyway" to go ahead.` };
  }
  return deps.write({
    kind: "merge",
    prUrl: args.prUrl,
    method: args.method,
    sha: args.sha,
    deleteBranch: shouldDeleteBranch(args.deleteBranchSetting, live.stackedAbove),
  });
}
