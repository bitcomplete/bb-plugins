/**
 * The Changes panel: every repo's diff and pull request, in one tab.
 *
 * The workspace root is not a git repo, so bb's native diff tab and PR badge
 * never appear for these threads and this panel is the whole surface. It is
 * grouped by repo rather than flattened into one file list because the unit a
 * person acts on here is a repo — it has its own base branch, its own merge
 * base, its own remote and its own pull request — and a flat list would make
 * "what did this thread do to bb-plugins" unanswerable at a glance.
 *
 * **The diff viewer is bb's.** `experimental_Diff` owns patch normalization,
 * highlighting, unified and split presentation, gutters and line selection,
 * and it follows the live code theme. That is the expensive half of a diff UI
 * and it comes free; what is built here is the data around it.
 *
 * **What is deliberately missing**, versus bb's own diff: tiering, pagination,
 * virtualization, byte budgeting and patch-section splitting. This caps the
 * file count and the per-file patch instead, and says so where it happens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Diff as Diff,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  ChangedFile,
  PullRequest,
  RepoChanges,
  RepoLiveStatus,
  RepoPullRequest,
  WorkspaceView,
  rpcContract,
} from "./contract.js";
import {
  CHANGES_POLL_MS,
  REPOS_CHANGED_CHANNEL,
  THREAD_CHANGES_CHANNEL,
  changeStatusLabel,
  changeStatusTone,
  threadSignal,
} from "./shared.js";

type PatchState = { loading: boolean; patch: string; truncated: boolean; error: string | null };

const PROJECT_SOURCE_DIR = ".bb";

/** `passed/failed/pending`, collapsed to the one number worth showing. */
function checkLine(pr: PullRequest): { text: string; tone: string } | null {
  if (pr.checks.length === 0) return null;
  let failed = 0;
  let pending = 0;
  for (const check of pr.checks) {
    if (check.conclusion === null) pending += 1;
    else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"].includes(check.conclusion))
      failed += 1;
  }
  if (failed > 0) return { text: `${failed} check${failed === 1 ? "" : "s"} failing`, tone: "text-red-600 dark:text-red-500" };
  if (pending > 0) return { text: `${pending} check${pending === 1 ? "" : "s"} running`, tone: "text-muted-foreground" };
  return { text: "checks passing", tone: "text-green-600 dark:text-green-500" };
}

function reviewLine(pr: PullRequest): { text: string; tone: string } | null {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { text: "approved", tone: "text-green-600 dark:text-green-500" };
    case "CHANGES_REQUESTED":
      return { text: "changes requested", tone: "text-amber-600 dark:text-amber-500" };
    case "REVIEW_REQUIRED":
      return {
        text: pr.reviewRequestCount > 0 ? `${pr.reviewRequestCount} reviewer(s) requested` : "review required",
        tone: "text-muted-foreground",
      };
    default:
      return null;
  }
}

function mergeLine(pr: PullRequest): { text: string; tone: string } | null {
  switch (pr.mergeStateStatus) {
    case "DIRTY":
      return { text: "conflicts", tone: "text-red-600 dark:text-red-500" };
    case "BEHIND":
      return { text: "behind base", tone: "text-amber-600 dark:text-amber-500" };
    case "BLOCKED":
      return { text: "blocked", tone: "text-amber-600 dark:text-amber-500" };
    default:
      return null;
  }
}

function PullRequestRow({
  entry,
  busy,
  onAction,
  onOpen,
}: {
  entry: RepoPullRequest;
  busy: boolean;
  onAction: (action: { kind: "ready" } | { kind: "merge"; method: "squash" } | { kind: "push" }) => void;
  onOpen: (url: string) => void;
}) {
  if (entry.error !== null) {
    return <div className="text-muted-foreground px-3 pb-2 text-xs">Pull requests unavailable: {entry.error}</div>;
  }
  const pr = entry.pr;
  if (pr === null) {
    return (
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <span className="text-muted-foreground text-xs">No pull request for this branch.</span>
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
          onClick={() => onAction({ kind: "push" })}
          disabled={busy}
        >
          Push branch
        </button>
      </div>
    );
  }
  const facts = [checkLine(pr), reviewLine(pr), mergeLine(pr)].filter((fact) => fact !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2">
      <button
        type="button"
        className="hover:underline"
        onClick={() => onOpen(pr.url)}
        title={pr.title}
      >
        <span className="text-muted-foreground font-mono text-xs">#{pr.number}</span>{" "}
        <span className="text-xs">{pr.isDraft ? "Draft" : pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : "Open"}</span>
      </button>
      {facts.map((fact) => (
        <span key={fact.text} className={`text-xs ${fact.tone}`}>
          {fact.text}
        </span>
      ))}
      <div className="ml-auto flex items-center gap-1.5">
        {pr.isDraft && pr.state === "OPEN" && (
          <button
            type="button"
            className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
            onClick={() => onAction({ kind: "ready" })}
            disabled={busy}
          >
            Ready
          </button>
        )}
        {pr.state === "OPEN" && !pr.isDraft && (
          <button
            type="button"
            className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
            onClick={() => onAction({ kind: "merge", method: "squash" })}
            disabled={busy}
          >
            Squash &amp; merge
          </button>
        )}
      </div>
    </div>
  );
}

function CreatePullRequest({
  dir,
  busy,
  onCreate,
}: {
  dir: string;
  busy: boolean;
  onCreate: (title: string, body: string, draft: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  if (!open) {
    return (
      <div className="px-3 pb-2">
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
          onClick={() => setOpen(true)}
        >
          Open a pull request
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2 px-3 pb-3">
      <input
        className="w-full rounded-md border px-2 py-1 text-sm"
        placeholder={`Title for ${dir}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        className="h-20 w-full resize-y rounded-md border px-2 py-1 text-sm"
        placeholder="Description"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          onClick={() => onCreate(title.trim(), body, false)}
          disabled={busy || title.trim().length === 0}
        >
          Create
        </button>
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          onClick={() => onCreate(title.trim(), body, true)}
          disabled={busy || title.trim().length === 0}
        >
          Create draft
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground px-1 text-xs"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      <p className="text-muted-foreground text-xs">The branch is pushed first if it is not already on the remote.</p>
    </div>
  );
}

function FileRow({
  file,
  expanded,
  patch,
  onToggle,
}: {
  file: ChangedFile;
  expanded: boolean;
  patch: PatchState | undefined;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="hover:bg-muted/60 flex w-full items-center gap-2 px-3 py-1 text-left"
        onClick={onToggle}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          className="text-muted-foreground size-3 shrink-0"
        />
        <span className={`w-3 shrink-0 font-mono text-xs ${changeStatusTone(file.status)}`}>
          {changeStatusLabel(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        </span>
        {file.additions !== null && (
          <span className="shrink-0 font-mono text-xs text-green-600 dark:text-green-500">+{file.additions}</span>
        )}
        {file.deletions !== null && (
          <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-500">−{file.deletions}</span>
        )}
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          {patch === undefined || patch.loading ? (
            <div className="text-muted-foreground text-xs">Loading…</div>
          ) : patch.error !== null ? (
            <div className="text-destructive text-xs">{patch.error}</div>
          ) : patch.patch.length === 0 ? (
            <div className="text-muted-foreground text-xs">No textual diff (binary or empty file).</div>
          ) : (
            <>
              <Diff patch={patch.patch} path={file.path} />
              {patch.truncated && (
                <div className="text-muted-foreground mt-2 text-xs">
                  This patch was cut at the panel's size limit. Open the file in the repo to see the rest.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function RepoSection({
  changes,
  status,
  pr,
  branch,
  busy,
  patches,
  expanded,
  onToggleFile,
  onAction,
  onCreate,
  onOpenUrl,
}: {
  changes: RepoChanges;
  status: RepoLiveStatus | undefined;
  pr: RepoPullRequest | undefined;
  branch: string;
  busy: boolean;
  patches: Record<string, PatchState>;
  expanded: Set<string>;
  onToggleFile: (dir: string, file: ChangedFile) => void;
  onAction: (dir: string, action: { kind: "ready" } | { kind: "merge"; method: "squash" } | { kind: "push" }) => void;
  onCreate: (dir: string, title: string, body: string, draft: boolean) => void;
  onOpenUrl: (url: string) => void;
}) {
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of changes.files) {
      additions += file.additions ?? 0;
      deletions += file.deletions ?? 0;
    }
    return { additions, deletions };
  }, [changes.files]);

  return (
    <section className="rounded-md border">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2">
        <Icon name="FolderGit" className="text-muted-foreground size-3.5 shrink-0 self-center" />
        <span className="font-medium">{changes.dir}</span>
        <span className="text-muted-foreground font-mono text-xs">{status?.branch ?? branch}</span>
        <span className="text-muted-foreground text-xs">vs {changes.baseBranch}</span>
        {status !== undefined && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-muted-foreground font-mono text-xs">
            ↑{status.ahead} ↓{status.behind}
          </span>
        )}
        <span className="ml-auto text-xs">
          {changes.files.length === 0 ? (
            <span className="text-muted-foreground">no changes</span>
          ) : (
            <>
              <span className="text-muted-foreground">
                {changes.files.length} file{changes.files.length === 1 ? "" : "s"}
              </span>{" "}
              <span className="text-green-600 dark:text-green-500">+{totals.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-500">−{totals.deletions}</span>
            </>
          )}
        </span>
      </header>

      {changes.error !== null && <div className="text-destructive px-3 pb-2 text-xs">{changes.error}</div>}

      {changes.dir !== PROJECT_SOURCE_DIR &&
        (pr?.pr != null || pr?.error != null ? (
          <PullRequestRow
            entry={pr}
            busy={busy}
            onAction={(action) => onAction(changes.dir, action)}
            onOpen={onOpenUrl}
          />
        ) : changes.files.length > 0 ? (
          <CreatePullRequest
            dir={changes.dir}
            busy={busy}
            onCreate={(title, body, draft) => onCreate(changes.dir, title, body, draft)}
          />
        ) : null)}

      {changes.files.length > 0 && (
        <ul className="divide-y border-t">
          {changes.files.map((file) => (
            <FileRow
              key={`${file.status}:${file.path}`}
              file={file}
              expanded={expanded.has(`${changes.dir}:${file.path}`)}
              patch={patches[`${changes.dir}:${file.path}`]}
              onToggle={() => onToggleFile(changes.dir, file)}
            />
          ))}
        </ul>
      )}
      {changes.truncated && (
        <div className="text-muted-foreground border-t px-3 py-2 text-xs">
          Only the first {changes.files.length} changed files are shown.
        </div>
      )}
    </section>
  );
}

/**
 * The panel.
 *
 * **Why it polls.** Nothing in bb tells a panel that a file on a machine
 * changed: there is no watcher signal to subscribe to, and the plugin's own
 * realtime channels fire on environment and repo-set edits. Loading once at
 * mount therefore froze the tab on whatever was on disk when it opened — a tab
 * opened at the start of a thread showed "no changes" for the rest of it. So
 * the diff half re-reads itself on a timer while the tab is visible, and a
 * finished turn publishes `THREAD_CHANGES_CHANNEL` so it lands sooner than the
 * next tick.
 *
 * **The two halves refresh independently.** Diffs and working-tree status are
 * a few short git commands against a warm checkout. Pull requests shell out to
 * `gh` per repo, over the network, and are server-side cached for a minute —
 * so they are deliberately left out of the poll, and a `gh` failure must not
 * take the diffs down with it. They used to share one `Promise.all`, which is
 * exactly what that failure did.
 */
export function ChangesPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [workspace, setWorkspace] = useState<WorkspaceView | null | undefined>(undefined);
  const [changes, setChanges] = useState<RepoChanges[]>([]);
  const [status, setStatus] = useState<RepoLiveStatus[]>([]);
  const [prs, setPrs] = useState<RepoPullRequest[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [patches, setPatches] = useState<Record<string, PatchState>>({});
  const [busy, setBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** The cheap half: the manifest, the diffs, the working-tree counters. */
  const loadDiffs = useCallback(async () => {
    const result = await rpc.call("workspace", { threadId });
    setWorkspace(result.workspace);
    if (result.workspace === null) return;
    const [nextChanges, nextStatus] = await Promise.all([
      rpc.call("changes", { threadId }),
      rpc.call("workspaceStatus", { threadId }),
    ]);
    setChanges(nextChanges.repos);
    setStatus(nextStatus.repos);
  }, [rpc, threadId]);

  /** The `gh` half. `refresh` bypasses the server's one-minute cache. */
  const loadPrs = useCallback(
    async (refresh: boolean) => {
      const next = await rpc.call("pullRequests", { threadId, refresh });
      setPrs(next.repos);
    },
    [rpc, threadId],
  );

  // A poll that overlapped the previous one would queue host calls behind each
  // other on a slow machine and never catch up. Only polls are dropped, never
  // a click: the Refresh button already guards itself with `loading`.
  const running = useRef(false);

  const load = useCallback(
    (options: { prs: boolean; refreshPrs?: boolean; quiet?: boolean }) => {
      const quiet = options.quiet === true;
      if (quiet && running.current) return;
      running.current = true;
      if (!quiet) setLoading(true);
      const diffs = loadDiffs().then(
        () => setDiffError(null),
        (error: unknown) => setDiffError(error instanceof Error ? error.message : "Could not load changes."),
      );
      const pulls = options.prs
        ? loadPrs(options.refreshPrs === true).then(
            () => setPrError(null),
            (error: unknown) =>
              setPrError(error instanceof Error ? error.message : "Could not load pull requests."),
          )
        : Promise.resolve();
      void Promise.all([diffs, pulls]).finally(() => {
        running.current = false;
        if (!quiet) setLoading(false);
      });
    },
    [loadDiffs, loadPrs],
  );

  // Stable identities, so a re-render does not re-subscribe or restart the timer.
  const initial = useCallback(() => load({ prs: true }), [load]);
  const poll = useCallback(() => load({ prs: false, quiet: true }), [load]);

  useEffect(initial, [initial]);

  useEffect(() => {
    // A hidden tab has no reader to serve, and a phone in a pocket should not
    // be spawning git processes on someone's machine.
    const tick = () => {
      if (document.visibilityState === "visible") poll();
    };
    const timer = window.setInterval(tick, CHANGES_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [poll]);

  useRealtime(REPOS_CHANGED_CHANNEL, poll);
  useRealtime(
    THREAD_CHANGES_CHANNEL,
    useCallback(
      (payload: unknown) => {
        const signal = threadSignal(payload);
        if (signal === null || signal.threadId !== threadId) return;
        load({ prs: signal.pullRequests, quiet: true });
      },
      [load, threadId],
    ),
  );

  const statusByDir = useMemo(() => new Map(status.map((entry) => [entry.dir, entry])), [status]);
  const prByDir = useMemo(() => new Map(prs.map((entry) => [entry.dir, entry])), [prs]);

  const toggleFile = useCallback(
    (dir: string, file: ChangedFile) => {
      const key = `${dir}:${file.path}`;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (patches[key] !== undefined) return;
      setPatches((current) => ({ ...current, [key]: { loading: true, patch: "", truncated: false, error: null } }));
      void rpc
        .call("filePatch", { threadId, dir, file: file.path, untracked: file.status === "untracked" })
        .then((result) =>
          setPatches((current) => ({
            ...current,
            [key]: { loading: false, patch: result.patch, truncated: result.truncated, error: result.error },
          })),
        )
        .catch((error: unknown) =>
          setPatches((current) => ({
            ...current,
            [key]: {
              loading: false,
              patch: "",
              truncated: false,
              error: error instanceof Error ? error.message : "Could not load the patch.",
            },
          })),
        );
    },
    [rpc, threadId, patches],
  );

  const act = useCallback(
    (dir: string, action: Parameters<typeof rpc.call<"pullRequestAction">>[1]["action"]) => {
      setBusy(true);
      setActionNotice(null);
      void rpc
        .call("pullRequestAction", { threadId, dir, action })
        .then((result) => {
          setActionNotice(`${dir}: ${result.message}`);
          load({ prs: true, refreshPrs: true });
        })
        .catch((error: unknown) =>
          setActionNotice(error instanceof Error ? error.message : "The action failed."),
        )
        .finally(() => setBusy(false));
    },
    [rpc, threadId, load],
  );

  if (workspace === undefined) {
    return (
      <div className="text-muted-foreground p-4 text-sm">
        {diffError === null ? "Loading…" : diffError}
      </div>
    );
  }
  if (workspace === null) {
    return (
      <div className="p-4 text-sm">
        <p className="text-muted-foreground">
          This thread has no multi-repo workspace: no environment created by the Multi-repo workspace provider is
          attached to it.
        </p>
      </div>
    );
  }

  const failed = workspace.repos.filter((repo) => repo.status === "failed");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="truncate font-mono text-xs" title={workspace.root}>
          {workspace.branchName}
        </span>
        <button
          type="button"
          className="hover:bg-muted ml-auto flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs disabled:opacity-50"
          onClick={() => load({ prs: true, refreshPrs: true })}
          disabled={loading || busy}
        >
          <Icon name="RefreshCw" className="size-3" />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {actionNotice !== null && (
          <div className="bg-muted/50 rounded-md border px-3 py-2 text-xs">{actionNotice}</div>
        )}


        {diffError !== null && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            {diffError}
          </div>
        )}

        {/* Deliberately its own banner rather than a reason to hide the diffs:
            `gh` can be missing or unauthenticated on a perfectly good checkout. */}
        {prError !== null && (
          <div className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
            Pull requests unavailable: {prError}
          </div>
        )}

        {workspace.sharedWith.length > 0 && (
          <div className="rounded-md border px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <Icon name="GitFork" className="size-3" />
              {workspace.sharedWith.length === 1
                ? "Another thread shares this checkout"
                : `${workspace.sharedWith.length} other threads share this checkout`}
            </div>
            <ul className="text-muted-foreground mt-1 space-y-0.5">
              {workspace.sharedWith.map((other) => (
                <li key={other.threadId}>{other.title ?? other.threadId}</li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-1">
              A forked thread keeps the environment it was forked from, so these threads work in{" "}
              <span className="font-mono">{workspace.root}</span> on{" "}
              <span className="font-mono">{workspace.branchName}</span> together. Commits from either land on the same
              branch.
            </p>
          </div>
        )}

        {failed.length > 0 && (
          <div className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-xs">
            <div className="text-destructive font-medium">
              {failed.length} repo{failed.length === 1 ? "" : "s"} missing from this workspace
            </div>
            <ul className="text-destructive/90 mt-1 space-y-0.5">
              {failed.map((repo) => (
                <li key={repo.dir}>
                  <span className="font-mono">{repo.dir}</span> — {repo.message ?? "failed to clone"}
                </li>
              ))}
            </ul>
          </div>
        )}

        {changes.length === 0 && !loading && (
          <p className="text-muted-foreground text-sm">No repos are checked out in this workspace.</p>
        )}

        {changes.map((repo) => (
          <RepoSection
            key={repo.dir}
            changes={repo}
            status={statusByDir.get(repo.dir)}
            pr={prByDir.get(repo.dir)}
            branch={workspace.branchName}
            busy={busy}
            patches={patches}
            expanded={expanded}
            onToggleFile={toggleFile}
            onAction={act}
            onCreate={(dir, title, body, draft) => act(dir, { kind: "create", title, body, draft })}
            onOpenUrl={(url) => {
              void navigate.openUrl(url);
            }}
          />
        ))}
      </div>
    </div>
  );
}
