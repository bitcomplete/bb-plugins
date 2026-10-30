// The batched fresh merge preview behind the deck's Merge (M). Merging stays
// separately authorized: M only opens this, every PR is read live from GitHub
// again, a PR with any refusal can't be picked, and the merge itself needs a
// pointer click on Merge or ⌘↵. Enter or Space on the focused button arrives
// as a click with detail 0 and is refused, and the dialog opens with focus on
// itself, never on that button. Merges run one at a time in number order,
// each pinned to the head commit shown, and stop at the first failure. Like
// the row's own merge dialog, each PR shows its written approval history, and
// says when that history is incomplete.
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Checkbox } from "./components/ui/checkbox";
import { cn, POINTER_CURSORS } from "./lib/utils";

/** action_merge_preview's fresh read, as far as this dialog uses it. */
export type MergePreview = { ok: true; live: { state: string; isDraft: boolean; reviewDecision: string | null; mergeStateStatus: string; headRefOid: string | null;
  stackedAbove: readonly number[]; unresolvedThreads: number; unresolvedAtLeast: boolean;
  approvalNotes: readonly { author: string; body: string; submittedAt: string; truncated: boolean }[]; approvalNotesMore: number; approvalNotesComplete: boolean };
  refusals: readonly string[]; warnings: readonly string[]; method: string; deleteBranch: boolean };
export type MergeResult = { ok: boolean; text: string };
export type MergeItem = { n: number | null; target: string; repo: string; number: number | null; title: string;
  /** Null while GitHub is read. */
  preview: MergePreview | { ok: false; error: string } | null; result: MergeResult | null };
export type MergeTrigger = "merge" | "refuse" | null;

/** Only a pointer click (detail 1 or more) or ⌘↵ / Ctrl↵ merges; Enter or Space on the button is a click with detail 0 and is refused. */
export function mergeTrigger(input: { kind: "click"; detail: number } | { kind: "key"; key: string; metaKey: boolean; ctrlKey: boolean }): MergeTrigger {
  if (input.kind === "click") return input.detail > 0 ? "merge" : "refuse";
  return input.key === "Enter" && (input.metaKey || input.ctrlKey) ? "merge" : null;
}

/** Why a PR can't merge from here: the server's refusals, threads this batch won't acknowledge, a failed read, or no head to pin. */
export function blockers(item: MergeItem): string[] {
  const preview = item.preview;
  if (preview === null) return [];
  if (!preview.ok) return [`GitHub read failed: ${preview.error}`];
  return [...preview.refusals,
    ...preview.live.unresolvedThreads > 0 ? [`${preview.live.unresolvedThreads}${preview.live.unresolvedAtLeast ? "+" : ""} unresolved review threads; merge it from its own preview to acknowledge them`] : [],
    ...preview.live.headRefOid === null ? ["GitHub returned no head commit to pin the merge to"] : []];
}

/** Why Merge is disabled now, or null: nothing picked, a read still running, or a picked PR that can't merge. */
export function mergeBlocked(items: readonly MergeItem[], selected: ReadonlySet<string>): string | null {
  const picked = items.filter((item) => selected.has(item.target) && item.result?.ok !== true);
  if (items.some((item) => item.preview === null)) return "Reading GitHub…";
  if (picked.length === 0) return "Pick a PR to merge";
  const blocked = picked.find((item) => blockers(item).length > 0);
  return blocked ? `${blocked.n ?? blocked.target} can't merge: ${blockers(blocked)[0]}` : null;
}

/** Merge the picked PRs one at a time in number order, stopping at the first failure; the rest are left untried. */
export async function mergeInOrder(items: readonly MergeItem[], selected: ReadonlySet<string>,
  merge: (item: MergeItem & { preview: MergePreview }) => Promise<MergeResult>): Promise<Map<string, MergeResult>> {
  const results = new Map<string, MergeResult>();
  const order = items.filter((item) => selected.has(item.target) && item.result?.ok !== true && item.preview?.ok)
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity)) as (MergeItem & { preview: MergePreview })[];
  for (const item of order) {
    let result: MergeResult;
    try { result = await merge(item); } catch (cause) { result = { ok: false, text: cause instanceof Error ? cause.message : String(cause) }; }
    results.set(item.target, result);
    if (!result.ok) break;
  }
  return results;
}

const MERGE_HINT = "Merging needs ⌘↵ or a click; Enter alone doesn't merge";

/** What approvers wrote, which may ask for changes an approval doesn't show, and a warning when GitHub didn't return the whole history. */
function ApprovalHistory({ live, url, onOpenUrl }: { live: MergePreview["live"]; url: string; onOpenUrl(url: string): void }) {
  if (live.approvalNotes.length === 0 && live.approvalNotesComplete) return null;
  const more = live.approvalNotesMore;
  return <section aria-label="Written approval history" className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-2 py-1.5 text-[11px]">
    <p><span className="font-medium">Written approval history.</span> <span className="text-muted-foreground">These notes may have been addressed since the review.
      Check their requests before merging.</span></p>
    {live.approvalNotes.length ? <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
      {live.approvalNotes.map((note, index) => <li key={`${note.author}-${note.submittedAt}-${index}`}>
        <span className="text-muted-foreground">{note.author} · <time dateTime={note.submittedAt}>{new Date(note.submittedAt).toLocaleDateString()}</time></span>
        <blockquote className="whitespace-pre-wrap break-words">{note.body}{note.truncated ? "…" : ""}</blockquote>
      </li>)}
    </ul> : null}
    {more > 0 ? <p className="mt-1 text-muted-foreground">{more} older written {more === 1 ? "approval" : "approvals"} on GitHub.</p> : null}
    {live.approvalNotesComplete ? null : <p className="mt-1 font-medium text-amber-800 dark:text-amber-300">Review history is incomplete. <button type="button"
      onClick={() => onOpenUrl(url)} className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">Check all reviews on GitHub</button> before merging.</p>}
  </section>;
}

/** The preview itself: each PR's fresh facts, a pick box that a refusal disables, and Merge. */
export function MergePreviewBody({ items, selected, busy, notice, onToggle, onMerge, onCancel, onOpenUrl }: { items: readonly MergeItem[]; selected: ReadonlySet<string>;
  busy: boolean; notice: string | null; onToggle(target: string, on: boolean): void; onMerge(trigger: MergeTrigger): void; onCancel(): void; onOpenUrl(url: string): void }) {
  const blocked = mergeBlocked(items, selected);
  const count = items.filter((item) => selected.has(item.target) && item.result?.ok !== true).length;
  const facts = items.find((item) => item.preview?.ok)?.preview as MergePreview | undefined;
  return <div className="grid gap-3 text-[12px]">
    <ul className="grid gap-2">
      {items.map((item) => {
        const preview = item.preview?.ok ? item.preview : null;
        const reasons = blockers(item);
        return <li key={item.target} data-merge-item={item.n ?? item.target} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-md border border-border px-2 py-1.5">
          <Checkbox checked={selected.has(item.target) && reasons.length === 0} disabled={reasons.length > 0 || item.preview === null || item.result?.ok === true || busy}
            aria-label={`Merge ${item.n ?? item.target}`} onCheckedChange={(on) => onToggle(item.target, on === true)} className="mt-0.5" />
          <div className="min-w-0">
            <p className="truncate"><span className="tabular-nums">{item.n}</span> <span className="text-muted-foreground">{item.repo}{item.number === null ? "" : ` #${item.number}`}</span> {item.title}</p>
            {item.preview === null ? <p className="text-[11px] text-muted-foreground">Reading GitHub…</p> : preview ? <p className="text-[11px] text-muted-foreground">
              head <span className="font-mono">{preview.live.headRefOid?.slice(0, 7) ?? "unknown"}</span> · {preview.live.state.toLowerCase()}{preview.live.isDraft ? ", draft" : ""}
              {" · "}{(preview.live.reviewDecision ?? "no review decision").toLowerCase().replace(/_/gu, " ")} · <span className="font-mono">{preview.live.mergeStateStatus}</span>
              {preview.live.stackedAbove.length ? ` · then ${preview.live.stackedAbove.map((n) => `#${n}`).join(", ")} retarget` : ""}
            </p> : null}
            {reasons.map((reason) => <p key={reason} className="text-[11px] text-destructive">{reason}</p>)}
            {preview?.warnings.map((warning) => <p key={warning} className="text-[11px] text-muted-foreground">Warning: {warning}</p>)}
            {preview ? <ApprovalHistory live={preview.live} url={item.target} onOpenUrl={onOpenUrl} /> : null}
            {item.result ? <p role="status" className={cn("text-[11px]", !item.result.ok && "text-destructive")}>{item.result.ok ? "Merged" : "Not merged"}: {item.result.text}</p> : null}
          </div>
        </li>;
      })}
    </ul>
    {facts ? <p className="text-[11px] text-muted-foreground">{facts.method} · {facts.deleteBranch ? "branches deleted after merge" : "branches kept"} · one at a time in number order,
      stopping at the first failure</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" data-merge-go disabled={busy || blocked !== null} title={`Click, or press ⌘↵. ${MERGE_HINT}.`}
        onClick={(event) => onMerge(mergeTrigger({ kind: "click", detail: event.detail }))}
        className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[12px] font-medium text-background outline-none hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        {busy ? "Merging…" : `Merge ${count} ${count === 1 ? "PR" : "PRs"}`}</button>
      <kbd className="rounded border border-border px-1 font-mono text-[11px] leading-4 text-muted-foreground">⌘↵</kbd>
      <button type="button" onClick={onCancel} disabled={busy} className="inline-flex h-8 items-center rounded-md px-3 text-[12px] outline-none hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring">
        {items.some((item) => item.result?.ok) ? "Done" : "Cancel"}</button>
      <span role="status" className="text-[11px] text-muted-foreground">{notice ?? blocked ?? ""}</span>
    </div>
  </div>;
}

/**
 * The dialog: reads every PR's preview in parallel when it opens, picks each one nothing refuses, and merges only on a click or ⌘↵.
 * `onClosed` puts focus back where the caller wants it, since the dialog has no trigger of its own to return to.
 */
export function MergePreviewDialog({ targets, rows, onClose, onMerged, onOpenUrl, onClosed }: { targets: readonly { target: string; n: number | null }[] | null;
  /** What names each PR: the deck's rows. */
  rows: readonly { target: string; repo: string; number: number | null; title: string }[]; onClose(): void; onMerged(): void; onOpenUrl(url: string): void; onClosed?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<MergeItem[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const key = targets?.map((item) => item.target).join(" ") ?? null;
  useEffect(() => {
    if (!targets) return;
    let live = true;
    const base = [...targets].sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity)).map((item): MergeItem => {
      const row = rowsRef.current.find((other) => other.target === item.target);
      return { n: item.n, target: item.target, repo: row?.repo.split("/").at(-1) ?? "", number: row?.number ?? null, title: row?.title ?? item.target, preview: null, result: null };
    });
    setItems(base);
    setSelected(new Set());
    setNotice(null);
    setBusy(false);
    for (const item of base) {
      const done = (preview: NonNullable<MergeItem["preview"]>) => {
        if (!live) return;
        setItems((current) => current.map((other) => other.target === item.target ? { ...other, preview } : other));
        if (blockers({ ...item, preview }).length === 0) setSelected((current) => new Set([...current, item.target]));
      };
      rpc.call("action_merge_preview", { prUrl: item.target }).then((result) => done(result.ok ? result : { ok: false, error: result.error }),
        (cause: unknown) => done({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
    }
    return () => { live = false; };
  }, [key, rpc]);
  const merge = async (trigger: MergeTrigger) => {
    if (trigger === "refuse") { setNotice(MERGE_HINT); return; }
    if (trigger !== "merge" || busy || mergeBlocked(items, selected) !== null) return;
    setBusy(true);
    setNotice(null);
    const results = await mergeInOrder(items, selected, async (item) => {
      const result = await rpc.call("action_merge", { prUrl: item.target, sha: item.preview.live.headRefOid!, acknowledgeUnresolved: false });
      onMerged();
      return result.ok ? { ok: true, text: result.detail } : { ok: false, text: result.error };
    });
    setItems((current) => current.map((item) => results.has(item.target) ? { ...item, result: results.get(item.target)! } : item));
    setBusy(false);
  };
  return <Dialog open={targets !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent ref={content} className={cn("max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto", POINTER_CURSORS)}
      onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }}
      onCloseAutoFocus={(event) => { if (onClosed) { event.preventDefault(); onClosed(); } }} onAfterCloseAutoFocus={onClosed}
      onKeyDown={(event) => { if (mergeTrigger({ kind: "key", key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey }) === "merge") { event.preventDefault(); void merge("merge"); } }}>
      <DialogHeader>
        <DialogTitle>Fresh merge preview</DialogTitle>
        <DialogDescription>Read live from GitHub now. Each merge is pinned to the head commit shown, so anything pushed since stops it.</DialogDescription>
      </DialogHeader>
      <MergePreviewBody items={items} selected={selected} busy={busy} notice={notice} onMerge={(trigger) => void merge(trigger)} onCancel={onClose} onOpenUrl={onOpenUrl}
        onToggle={(target, on) => setSelected((current) => { const next = new Set(current); if (on) next.add(target); else next.delete(target); return next; })} />
    </DialogContent>
  </Dialog>;
}
