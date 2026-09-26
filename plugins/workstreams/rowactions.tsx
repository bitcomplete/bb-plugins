// Per-row actions on the Board inbox: the compact menu, and the confirm dialog
// behind every write. Nothing here writes on open; each dialog reads (live,
// where it matters), shows what will happen, and acts only on an explicit
// click. The decisions themselves live in actions.ts, where they are tested.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Row } from "./inbox";
import type { Pr } from "./contract";
import {
  AGENT_LABEL,
  DIRECT_LABEL,
  actionPreview,
  actionPrompt,
  nudgeComment,
  type AgentAction,
  type DirectAction,
  type ThreadMode,
} from "./actions";
import { compactAge } from "./workstreams";
import { defaultMessageTarget, orderMessageTargets } from "./threadmessage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Tip } from "@/components/ui/tooltip";
import { POINTER_CURSORS, cn } from "@/lib/utils";
import { toast } from "sonner";

/** Direct actions can target an inventoried PR without inventing a checkout. */
export type DirectRow = { repo: string; title: string; age: { since: number | null }; unit: { pr: Pr | null; path: string } | { pr: Pr; prUrl: string } };
function directTarget(row: DirectRow): { path: string } | { prUrl: string } {
  return "path" in row.unit ? { path: row.unit.path } : { prUrl: row.unit.prUrl };
}

/** Which dialog is open, and for which row. */
export type ActionRequest =
  | { kind: "direct"; action: DirectAction; row: DirectRow }
  | { kind: "agent"; action: AgentAction; row: Row };

/**
 * The row's secondary actions behind one "More actions" button. The primary
 * action is the row's verb chip, so it is not repeated here. Shown on hover or
 * selection like the other row controls, and every item is a real button, so
 * Tab reaches it and Enter or Space runs it.
 */
export function RowActionMenu({
  hasThreads,
  hasOpenPr,
  onGoToThread,
  onMessageAgent,
  onOpenCheckout,
  onNewThread, onHold, onReleaseHold, held, onHeldAction,
}: {
  hasThreads: boolean;
  hasOpenPr: boolean;
  onGoToThread?: () => void;
  onMessageAgent?: () => void;
  onOpenCheckout?: () => void;
  onNewThread?: () => void;
  onHold?: () => void;
  onReleaseHold?: () => void;
  held?: boolean;
  onHeldAction?: { label: string; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const item = (label: string, hint: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        event.stopPropagation();
        setOpen(false);
        run();
      }}
      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-[12px] outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]"
    >
      {label}
      <kbd className="font-mono text-[10.5px] text-muted-foreground">{hint}</kbd>
    </button>
  );
  return (
    <span ref={rootRef} className="relative flex items-center gap-0.5" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
      <Tip label="More actions">
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="MoreHorizontal" className="size-3.5" />
        </button>
      </Tip>
      {open ? (
        <span
          role="menu"
          className="absolute right-0 top-7 z-30 flex w-56 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {hasThreads && onGoToThread ? item("Go to thread", "t", onGoToThread) : null}
          {hasThreads && hasOpenPr && onMessageAgent ? item("Message agent", "", onMessageAgent) : null}
          {onOpenCheckout ? item("Open checkout", "o", onOpenCheckout) : null}
          {onNewThread ? item("Start a new thread", "n", onNewThread) : null}
          {onHeldAction ? item(onHeldAction.label, "", onHeldAction.run) : null}
          {hasOpenPr && onHold ? item(held ? "Edit hold reason" : "Put on hold…", "", onHold) : null}
          {held && onReleaseHold ? item("Release hold", "", onReleaseHold) : null}
        </span>
      ) : null}
    </span>
  );
}

const LINK_REASON = {
  started: "Started from this workstream",
  environment: "Uses this checkout or branch",
  ticket: "Title names this ticket",
  paths: "Worked in this checkout",
} as const;

/** A short user-authored instruction to one linked thread, with row context added by the server. */
export function ThreadMessageDialog({
  row,
  threads,
  onClose,
}: {
  row: Row | null;
  threads: readonly Row["cluster"]["threads"][number][];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [threadId, setThreadId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ordered = orderMessageTargets(threads);
  const option = (thread: (typeof ordered)[number]) => (
    <option key={thread.id} value={thread.id}>
      {thread.active ? "Running · " : ""}{thread.title} · {LINK_REASON[thread.tier]} · {thread.id}
    </option>
  );
  useEffect(() => {
    setThreadId(defaultMessageTarget(threads));
    setMessage("");
    setBusy(false);
    setError(null);
  }, [row]);

  const send = async () => {
    if (row === null || row.unit.pr === null || threadId === "" || message.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("thread_message", { path: row.unit.path, prUrl: row.unit.pr.url, threadId, message: message.trim() });
      if (!result.ok) {
        setError(result.error);
      } else {
        toast.success(result.delivery === "queued" ? "Message queued for the agent" : "Message sent to the agent");
        onClose();
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className={cn("max-w-lg", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>Message an agent</DialogTitle>
          <DialogDescription>{row === null ? null : <PrLine row={row} />}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5 text-[12.5px]">
          <span className="font-medium">Agent thread</span>
          <select
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {threads.length === 1 ? null : <option value="">Choose a thread</option>}
            {ordered.some((thread) => thread.tier === "started" || thread.tier === "environment") ? (
              <optgroup label="Started here or same environment">
                {ordered.filter((thread) => thread.tier === "started" || thread.tier === "environment").map(option)}
              </optgroup>
            ) : null}
            {ordered.some((thread) => thread.tier === "ticket") ? (
              <optgroup label="Title names this ticket">
                {ordered.filter((thread) => thread.tier === "ticket").map(option)}
              </optgroup>
            ) : null}
            {ordered.some((thread) => thread.tier === "paths") ? (
              <optgroup label="Possible match · worked in checkout">
                {ordered.filter((thread) => thread.tier === "paths").map(option)}
              </optgroup>
            ) : null}
          </select>
          <span className="text-[11.5px] text-muted-foreground">
            Ticket and path matches are inferred. Choose the thread handling this PR.
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px]">
          <span className="font-medium">What should the agent do?</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={4_000}
            rows={3}
            placeholder="Rebase and nudge the PR with PTAL"
            className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <p className="text-[11.5px] text-muted-foreground">The agent also receives the PR link, title, and checkout path. BB starts a turn on an idle thread, steers a running one, or queues the message while the thread is waiting.</p>
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || threadId === "" || message.trim() === ""} onClick={() => void send()}>
            {busy ? "Sending…" : "Send message"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled fact in a dialog. */
function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(tone === "bad" && "text-destructive", tone === "warn" && "text-amber-700 dark:text-amber-300")}>{children}</dd>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error === null ? null : (
    <p role="alert" className="text-[12.5px] text-destructive">
      {error}
    </p>
  );
}

function PrLine({ row }: { row: DirectRow }) {
  return (
    <span>
      <span className="font-medium text-foreground">{row.repo}</span>
      {row.unit.pr === null ? null : <span className="font-mono"> #{row.unit.pr.number}</span>} · {row.title}
    </span>
  );
}

// ---- merge ------------------------------------------------------------------

type MergePreview = Extract<Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>>, { live: unknown }>;

/**
 * Merge, after a LIVE re-read. The dialog shows the head commit it read, and
 * the merge is pinned to exactly that commit: if anything was pushed since,
 * GitHub refuses rather than merging code nobody looked at here.
 */
export function MergeDialog({ row, onClose }: { row: DirectRow | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anyway, setAnyway] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (row === null) return;
    let live = true;
    setPreview(null);
    setError(null);
    setAnyway(false);
    setBusy(false);
    rpc.call("action_merge_preview", directTarget(row)).then(
      (result) => {
        if (!live) return;
        if (result.ok) setPreview(result as MergePreview);
        else setError(result.error);
      },
      (cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
  }, [row]);

  const facts = preview?.ok === true ? preview : null;
  const unresolved = facts?.live.unresolvedThreads ?? 0;
  const blocked = facts === null || facts.refusals.length > 0 || facts.live.headRefOid === null || (unresolved > 0 && !anyway);

  const merge = async () => {
    if (row === null || facts === null || facts.live.headRefOid === null || blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("action_merge", {
        ...directTarget(row),
        sha: facts.live.headRefOid,
        acknowledgeUnresolved: anyway,
      });
      if (result.ok) {
        toast.success(result.detail);
        onClose();
        return;
      }
      setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>Merge pull request</DialogTitle>
          <DialogDescription>{row === null ? null : <PrLine row={row} />}</DialogDescription>
        </DialogHeader>
        {facts === null ? (
          error === null ? <p className="text-[12.5px] text-muted-foreground">Reading the pull request from GitHub…</p> : null
        ) : (
          <>
            {unresolved > 0 ? (
              <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[13px]">
                <p className="font-semibold">
                  {unresolved}
                  {facts.live.unresolvedAtLeast ? "+" : ""} unresolved review {unresolved === 1 ? "thread" : "threads"}
                </p>
                <label className="mt-1.5 flex items-center gap-2 text-[12.5px]">
                  <Checkbox checked={anyway} onCheckedChange={(next) => setAnyway(next === true)} aria-label="Merge anyway" />
                  Merge anyway
                </label>
              </div>
            ) : null}
            {facts.live.approvalNotes.length > 0 || !facts.live.approvalNotesComplete ? (
              <section aria-label="Written approval history" className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-[12px]">
                <p className="font-semibold">Written approval history</p>
                <p className="mt-0.5 text-muted-foreground">These notes may have been addressed since the review. Check their requests before merging.</p>
                <ul className="mt-2 max-h-[35vh] space-y-2 overflow-y-auto">
                  {facts.live.approvalNotes.map((note, index) => (
                    <li key={`${note.author}-${note.submittedAt}-${index}`} className="border-t border-border/60 pt-2 first:border-0 first:pt-0">
                      <p className="text-muted-foreground">{note.author} · <time dateTime={note.submittedAt}>{new Date(note.submittedAt).toLocaleDateString()}</time></p>
                      <blockquote className="mt-1 whitespace-pre-wrap break-words text-foreground">{note.body}{note.truncated ? "…" : ""}</blockquote>
                    </li>
                  ))}
                </ul>
                {facts.live.approvalNotesMore > 0 ? <p className="mt-2 text-muted-foreground">{facts.live.approvalNotesMore} older written {facts.live.approvalNotesMore === 1 ? "approval" : "approvals"} on GitHub.</p> : null}
                {!facts.live.approvalNotesComplete ? <p className="mt-2 font-medium text-amber-800 dark:text-amber-300">Review history is incomplete. {row?.unit.pr === null || row === null ? "Check all reviews on GitHub" : <UrlLink href={row.unit.pr.url} className="underline underline-offset-2">Check all reviews on GitHub</UrlLink>} before merging.</p> : null}
              </section>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
              <Fact label="State" tone={facts.live.state === "OPEN" ? undefined : "bad"}>
                {facts.live.state.toLowerCase()}
                {facts.live.isDraft ? ", draft" : ""}
              </Fact>
              <Fact label="Review" tone={facts.live.reviewDecision === "APPROVED" ? undefined : "bad"}>
                {(facts.live.reviewDecision ?? "no decision").toLowerCase().replace(/_/gu, " ")}
              </Fact>
              <Fact
                label="Mergeability"
                tone={["CLEAN", "HAS_HOOKS"].includes(facts.live.mergeStateStatus) ? undefined : facts.live.mergeStateStatus === "UNSTABLE" ? "warn" : "bad"}
              >
                <span className="font-mono">{facts.live.mergeStateStatus}</span>
              </Fact>
              <Fact label="Head commit">
                <span className="font-mono" title={facts.live.headRefOid ?? ""}>
                  {facts.live.headRefOid?.slice(0, 12) ?? "unknown"}
                </span>
              </Fact>
              <Fact label="Method">{facts.method}</Fact>
              <Fact label="Branch">
                {facts.deleteBranch
                  ? "deleted after merge"
                  : facts.live.stackedAbove.length > 0
                    ? `kept: ${facts.live.stackedAbove.map((n) => `#${n}`).join(", ")} ${facts.live.stackedAbove.length === 1 ? "is" : "are"} based on it`
                    : "kept (setting)"}
              </Fact>
            </dl>
            {facts.refusals.length === 0 ? null : (
              <ul className="list-disc pl-5 text-[12.5px] text-destructive">
                {facts.refusals.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {facts.warnings.map((warning) => (
              <p key={warning} className="text-[12.5px] text-amber-700 dark:text-amber-300">
                {warning}
              </p>
            ))}
          </>
        )}
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void merge()} disabled={blocked || busy}>
            {busy ? "Merging…" : facts === null ? "Merge" : `Merge (${facts.method})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- update branch and nudge ---------------------------------------------------

/** Run one write RPC from a dialog: busy state, error kept in the dialog, toast on success. */
function useWrite(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setBusy(false);
    setError(null);
  };
  const run = async (call: () => Promise<{ ok: true; detail: string } | { ok: false; error: string }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (result.ok) {
        toast.success(result.detail);
        onClose();
        return;
      }
      setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };
  return { busy, error, reset, run };
}

export function UpdateBranchDialog({ row, onClose }: { row: DirectRow | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const write = useWrite(onClose);
  useEffect(() => {
    if (row !== null) write.reset();
  }, [row]);
  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className={cn("max-w-lg", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>Update branch</DialogTitle>
          <DialogDescription>{row === null ? null : <PrLine row={row} />}</DialogDescription>
        </DialogHeader>
        <p className="text-[12.5px] text-muted-foreground">
          GitHub merges the latest base branch into this pull request's branch (
          <span className="font-mono">gh pr update-branch</span>). Checks run again afterwards. Your local checkout is not
          touched; pull before you next commit there.
        </p>
        <ErrorLine error={write.error} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={write.busy}>
            Cancel
          </Button>
          <Button
            disabled={write.busy}
            onClick={() => row !== null && void write.run(() => rpc.call("action_update_branch", directTarget(row)))}
          >
            {write.busy ? "Updating…" : "Update branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Nudge the reviewers. Two independent choices: re-request review from the
 * reviewers GitHub still lists as pending, and post a comment. The comment is
 * prefilled and editable; it reaches gh on stdin, never on a command line.
 */
export function NudgeDialog({ row, now, onClose }: { row: DirectRow | null; now: number; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const write = useWrite(onClose);
  const reviewers = row?.unit.pr?.reviewRequests ?? [];
  const [rerequest, setRerequest] = useState(false);
  const [comment, setComment] = useState(true);
  const [text, setText] = useState("");

  useEffect(() => {
    if (row === null || row.unit.pr === null) return;
    write.reset();
    setRerequest(reviewers.length > 0);
    setComment(true);
    setText(
      nudgeComment({
        reviewers,
        repo: row.repo,
        prNumber: row.unit.pr.number,
        title: row.title,
        age: row.age.since === null ? "" : compactAge(row.age.since, now),
      }),
    );
  }, [row]);

  const nothing = !rerequest && (!comment || text.trim() === "");
  return (
    <Dialog open={row !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className={cn("max-w-xl", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>Nudge reviewers</DialogTitle>
          <DialogDescription>{row === null ? null : <PrLine row={row} />}</DialogDescription>
        </DialogHeader>
        {reviewers.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">
            GitHub lists no pending reviewers on this pull request, so there is no one to re-request. You can still post
            a comment.
          </p>
        ) : (
          <label className="flex items-start gap-2 text-[12.5px]">
            <Checkbox className="mt-0.5" checked={rerequest} onCheckedChange={(next) => setRerequest(next === true)} />
            <span>
              Re-request review from{" "}
              <span className="font-medium">{reviewers.map((login) => `@${login}`).join(", ")}</span>
            </span>
          </label>
        )}
        <label className="flex items-center gap-2 text-[12.5px]">
          <Checkbox checked={comment} onCheckedChange={(next) => setComment(next === true)} />
          Post a comment
        </label>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!comment}
          aria-label="Comment"
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <ErrorLine error={write.error} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={write.busy}>
            Cancel
          </Button>
          <Button
            disabled={write.busy || nothing}
            onClick={() =>
              row !== null &&
              void write.run(() =>
                rpc.call("action_nudge", { ...directTarget(row), rerequest, comment: comment ? text : null }),
              )
            }
          >
            {write.busy ? "Sending…" : "Nudge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- agent actions ------------------------------------------------------------

type Plan = Extract<Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>>, { recommendation: unknown; capabilities: unknown }>;

const MODE_LABEL: Record<ThreadMode, string> = {
  continue: "Continue in a thread",
  subthread: "Subthread of a thread",
  new: "New thread",
};

/**
 * An agent action. The server reads the row's linked threads live and
 * preselects where the work should run, with its reason in one line; the user
 * can pick any other mode or thread, and edits the prompt before anything runs.
 */
export function AgentDialog({ request, onClose }: { request: { action: AgentAction; row: Row } | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mode, setMode] = useState<ThreadMode>("new");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (request === null) return;
    const { row, action } = request;
    let live = true;
    setPlan(null);
    setError(null);
    setBusy(false);
    setMode("new");
    setThreadId(null);
    setPrompt(
      actionPrompt(action, {
        repo: row.repo,
        prNumber: row.unit.pr?.number ?? null,
        title: row.unit.pr === null ? null : row.title,
        branch: row.unit.branch,
        path: row.unit.path,
      }),
    );
    rpc.call("agent_plan", { path: row.unit.path, action }).then(
      (result) => {
        if (!live) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        const ready = result as Plan;
        setPlan(ready);
        setMode(ready.recommendation.mode);
        setThreadId(ready.recommendation.threadId ?? ready.candidates[0]?.id ?? null);
      },
      (cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
  }, [request]);

  const candidates = plan?.candidates ?? [];
  const chosen = candidates.find((thread) => thread.id === threadId) ?? null;
  const allowed: Record<ThreadMode, boolean> = {
    new: true,
    continue: false,
    subthread: plan !== null && plan.capabilities.subthread && candidates.some((thread) => thread.canSpawnChild),
  };
  const ready =
    plan !== null && prompt.trim() !== "" && (mode === "new" || (chosen !== null && (mode !== "subthread" || chosen.canSpawnChild)));
  const preview = request === null ? null : actionPreview(request.action, request.row.unit.pr);
  const defaultPrompt = request === null ? "" : actionPrompt(request.action, {
    repo: request.row.repo,
    prNumber: request.row.unit.pr?.number ?? null,
    title: request.row.unit.pr === null ? null : request.row.title,
    branch: request.row.unit.branch,
    path: request.row.unit.path,
  });

  const run = async () => {
    if (request === null || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("agent_run", {
        path: request.row.unit.path,
        action: request.action,
        mode,
        threadId: mode === "new" ? null : threadId,
        prompt,
      });
      if (result.ok) {
        onClose();
        navigate.toThread(result.threadId);
        return;
      }
      setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };

  return (
    <Dialog open={request !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className={cn("max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto", POINTER_CURSORS)}>
        <DialogHeader>
          <DialogTitle>{request === null ? "" : AGENT_LABEL[request.action]}</DialogTitle>
          <DialogDescription>{request === null ? null : <PrLine row={request.row} />}</DialogDescription>
        </DialogHeader>
        {plan === null ? (
          error === null ? <p className="text-[12.5px] text-muted-foreground">Reading the linked threads…</p> : null
        ) : (
          <>
            <p className="rounded-md bg-foreground/[0.04] px-3 py-2 text-[12.5px]">{plan.recommendation.reason}</p>
            <div role="radiogroup" aria-label="Where to run" className="flex flex-wrap gap-1.5">
              {(["subthread", "new"] as ThreadMode[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={mode === option}
                  disabled={!allowed[option]}
                  onClick={() => setMode(option)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                    mode === option ? "border-foreground/60 bg-foreground/[0.07] font-medium" : "border-border",
                  )}
                >
                  {MODE_LABEL[option]}
                  {plan.recommendation.mode === option ? " · recommended" : ""}
                </button>
              ))}
            </div>
            {mode === "new" ? null : (
              <select
                value={threadId ?? ""}
                onChange={(event) => setThreadId(event.target.value)}
                aria-label="Thread"
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-[12.5px]"
              >
                {candidates.map((thread) => (
                  <option key={thread.id} value={thread.id} disabled={mode === "subthread" && !thread.canSpawnChild}>
                    {thread.title} · {thread.running ? "running" : "idle"} · {thread.tier}
                    {thread.contextUsed === null ? "" : ` · ${Math.round(thread.contextUsed * 100)}% context`}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {preview === null ? null : (
          <section aria-label="Action preview" className="space-y-2 rounded-md border border-border px-3 py-2.5 text-[12.5px]">
            <h3 className="font-medium">Planned next steps for this {mode === "subthread" ? "subthread" : "thread"}</h3>
            <ol className="list-decimal space-y-1 pl-5 leading-relaxed">
              {preview.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {preview.lastScan.length > 0 ? (
              <p className="text-muted-foreground">Last scan: {preview.lastScan.join(" · ")}</p>
            ) : null}
            {prompt !== defaultPrompt ? (
              <p className="text-muted-foreground">This preview follows the default instructions. Your edits may change what the agent does.</p>
            ) : null}
          </section>
        )}
        <details className="group rounded-md border border-border px-3 py-2 text-[12.5px]">
          <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">View or edit instructions</summary>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void run();
              }
            }}
            aria-label="Prompt"
            rows={7}
            className="mt-2 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </details>
        <ErrorLine error={error} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={!ready || busy}>
            {busy ? "Starting…" : mode === "subthread" ? "Start subthread" : "Start thread"}
            <kbd className="ml-1 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The one dialog a row action opens, if any. */
export function ActionDialogs({ request, now, onClose }: { request: ActionRequest | null; now: number; onClose: () => void }) {
  const direct = (action: DirectAction) => (request?.kind === "direct" && request.action === action ? request.row : null);
  return (
    <>
      <MergeDialog row={direct("merge")} onClose={onClose} />
      <UpdateBranchDialog row={direct("update-branch")} onClose={onClose} />
      <NudgeDialog row={direct("nudge")} now={now} onClose={onClose} />
      <AgentDialog request={request?.kind === "agent" ? request : null} onClose={onClose} />
    </>
  );
}
