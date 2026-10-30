/**
 * The changed-files banner above the composer.
 *
 * bb puts a changed-files summary in the thread's prompt context banner, and
 * that summary reads the thread's checkout — which here is a plain directory
 * and not a git repo, so the section never appears. Every fact about the diff
 * was already in the Changes panel, but the panel is behind the panel
 * launcher: nothing in the thread view said a diff existed, so there was
 * nothing to click and no reason to look.
 *
 * This is a one-line summary in the place bb's own would be, and deliberately
 * nothing more. It carries no pull-request state and no actions — the panel is
 * still the surface you act on, and this exists to say a diff is there and to
 * open it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { RepoChanges, rpcContract } from "./contract.js";
import {
  BANNER_POLL_MS,
  CHANGES_ACTION_ID,
  CHANGES_TAB_TITLE,
  REPOS_CHANGED_CHANNEL,
  THREAD_CHANGES_CHANNEL,
  threadSignal,
} from "./shared.js";

interface Summary {
  /** Only the repos with something in them, in manifest order. */
  changed: { dir: string; files: number }[];
  files: number;
  additions: number;
  deletions: number;
}

function summarize(repos: readonly RepoChanges[]): Summary {
  const summary: Summary = { changed: [], files: 0, additions: 0, deletions: 0 };
  for (const repo of repos) {
    if (repo.files.length === 0) continue;
    summary.changed.push({ dir: repo.dir, files: repo.files.length });
    summary.files += repo.files.length;
    for (const file of repo.files) {
      // Null for a binary file, which still counts as a changed file.
      summary.additions += file.additions ?? 0;
      summary.deletions += file.deletions ?? 0;
    }
  }
  return summary;
}

/**
 * The banner.
 *
 * **One RPC, and it doubles as the workspace check.** `changes` returns one
 * entry per checked-out repo — empty `files` for a clean one — and an empty
 * array for a thread with no multi-repo workspace at all. The composer slot is
 * registered app-wide, so the overwhelmingly common case is that second one,
 * and it costs a single server round trip that never reaches a machine.
 *
 * **An empty first read stops the timer.** The banner is mounted in every
 * thread in every project, and a plain bb thread must not poll a git host
 * every fifteen seconds for the rest of its life to be told again that it has
 * no repos. `REPOS_CHANGED_CHANNEL` stays subscribed either way, and
 * provisioning, an inherited workspace and `workspace_add_repo` all publish on
 * it — so a workspace that appears after the first read starts the timer then.
 */
export function ChangesBanner() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  // The registration scopes this to `"thread"`, so the narrowing always holds;
  // it is here because the scope union is what the hook returns.
  const threadId =
    composer.scope.kind === "thread" ? composer.scope.threadId : null;

  /** Null until the first read answers; `[]` means "no workspace here". */
  const [repos, setRepos] = useState<readonly RepoChanges[] | null>(null);

  // Same reason as the panel: a read that overlapped the previous one would
  // queue host calls behind each other on a slow machine and never catch up.
  const running = useRef(false);

  const load = useCallback(() => {
    if (threadId === null || running.current) return;
    running.current = true;
    void rpc
      .call("changes", { threadId })
      .then(
        (result) => setRepos(result.repos),
        () => {
          // A banner is a glance. A failed read leaves the last good summary
          // standing rather than putting an error above the composer, where it
          // would be in the way of the thing the user came to do. The panel is
          // where a diff failure is worth reporting, and it reports it.
        },
      )
      .finally(() => {
        running.current = false;
      });
  }, [rpc, threadId]);

  useEffect(load, [load]);

  const polls = repos !== null && repos.length > 0;
  useEffect(() => {
    if (!polls) return;
    // A hidden tab has no reader to serve, and a phone in a pocket should not
    // be spawning git processes on someone's machine.
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(tick, BANNER_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [polls, load]);

  useRealtime(REPOS_CHANGED_CHANNEL, load);
  useRealtime(
    THREAD_CHANGES_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const signal = threadSignal(payload);
        if (signal === null || signal.threadId !== threadId) return;
        load();
      },
      [load, threadId],
    ),
  );

  const summary = useMemo(() => summarize(repos ?? []), [repos]);

  // Nothing changed is not worth a row: the thread view stays as quiet as bb's
  // own does, and the Changes action is still in the panel launcher.
  if (summary.files === 0) return null;

  return (
    <button
      type="button"
      // Geometry copied from bb's own prompt-stack header rows: the host wraps
      // a `card` banner in a bordered, `rounded-lg`, unpadded shell, so the row
      // owns its padding and its hover fill has to match those corners.
      className="hover:bg-muted/50 flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors"
      onClick={() => {
        // False when this surface has no side panel — a `ThreadChat` embedded
        // somewhere else. Nothing to recover from: the summary is still read.
        navigate.openThreadPanel({ actionId: CHANGES_ACTION_ID, title: CHANGES_TAB_TITLE });
      }}
      title="Open the Changes panel"
    >
      <Icon name="FolderGit" className="text-muted-foreground size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">
        {summary.changed.length} repo{summary.changed.length === 1 ? "" : "s"} changed
      </span>
      <span className="text-muted-foreground shrink-0">
        {summary.files} file{summary.files === 1 ? "" : "s"}
      </span>
      <span className="shrink-0 text-green-600 dark:text-green-500">+{summary.additions}</span>
      <span className="shrink-0 text-red-600 dark:text-red-500">−{summary.deletions}</span>
      {/* Which repos moved, which is the question a count alone leaves open
          and the one thing this banner says that bb's single-repo one cannot. */}
      <span className="text-muted-foreground ml-auto truncate pl-2 font-mono">
        {summary.changed.map((repo) => `${repo.dir} ${repo.files}`).join("  ·  ")}
      </span>
    </button>
  );
}
