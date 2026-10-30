// What the effort deck and All PRs share at the SDK layer (plan amendment
// A15): the dialog frame that never starts on a write button and hands focus
// back where it came from, the batch flow (plan, listing confirm, delayed
// send, Undo), Address selected (plan and start at once, then Undo), and the
// one key registry's handler.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ActedKind, DeckWrite } from "./deck-shared";
import type { BatchItem, Skipped } from "./deck-batch";
import { ACTION, actionForKey, typingTarget, type DeckActionId } from "./deck-keys";
import { SECTIONS, type Availability } from "./deck-view-model";
import { clock, withOutcome, type Outcome } from "./inventory-view-model";
import { ConfirmBody, type ConfirmPlan } from "./deck-screen";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { cn, POINTER_CURSORS } from "./lib/utils";

export const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** The last thing Undo takes back: a batch still waiting to send, a classification, or a pile move. */
export type Undo = { label: string; run(): Promise<void>; live(): boolean };

/** One dialog frame: focus starts on its first field or on the dialog itself, never on a write button, and `onReturn` puts it back. */
export function DeckDialog({ open, title, sub, wide, bare, closeKey, onClose, onReturn, onConfirmKey, children }: { open: boolean; title: string; sub?: string; wide?: boolean;
  bare?: boolean; closeKey?: string; onClose(): void; onReturn(): void; onConfirmKey?: () => void; children: ReactNode }) {
  const content = useRef<HTMLDivElement | null>(null);
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent ref={content} hideCloseButton className={cn("max-h-[calc(100dvh-2rem)] overflow-y-auto", wide ? "max-w-3xl" : "max-w-lg", bare && "gap-0 p-0", POINTER_CURSORS)}
      onOpenAutoFocus={(event) => { event.preventDefault(); (content.current?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select") ?? content.current)?.focus(); }}
      onCloseAutoFocus={(event) => { event.preventDefault(); onReturn(); }} onAfterCloseAutoFocus={onReturn}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onConfirmKey) { event.preventDefault(); onConfirmKey(); }
        else if (closeKey && event.key === closeKey && !typingTarget(event.target)) { event.preventDefault(); onClose(); }
      }}>
      <DialogHeader className={bare ? "sr-only" : undefined}><DialogTitle>{title}</DialogTitle>{sub ? <DialogDescription>{sub}</DialogDescription> : null}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

const VERB: Record<DeckWrite | "advance", string> = { nudge: "Nudge", request: "Request", ready: "Mark ready", release: "Release", ask: "Ask", fix: "Ask",
  address: "Address", advance: "Run" };
type Pending = { plan: ConfirmPlan; batchId: string; request: { kind: DeckWrite | "advance"; effortId: string | null; prUrls: string[] | null };
  reviewer: string;
  /** The reviewer field as the listing was planned: another name typed there sends nothing until it plans again. */
  planned: string };

type PlanOut = { ok: false; error: string } | { ok: true; batchId: string | null; items: readonly unknown[]; skipped: Skipped[] };
type StartOut = { ok: false; error: string } | { ok: true; dispatchAt: number };
/** What one Address selected came to: started into its Undo window, with any PR left out and why; or nothing started, and why. */
export type AddressOutcome = { ok: true; batchId: string; dispatchAt: number; count: number; skipped: Skipped[] } | { ok: false; error: string; skipped: Skipped[] };
const refOf = (skipped: readonly Skipped[]) => skipped.map((item) => `${item.ref}: ${item.reason}`).join(" · ");

/**
 * Address selected, with no listing, as Reviews starts its batch: plan one batch thread for the PRs and start it at once, into the server's
 * Undo window. The thread, not this click, does any GitHub work, and dispatch reads each PR and checks every hold and claim again before
 * it claims one. Each refusal comes back in the server's words: a plan it refused, a plan that left every PR out, or a start it refused.
 */
export async function startAddress(rpc: { plan(input: { kind: "address"; effortId?: string; prUrls: string[]; seen: Record<string, number> }): Promise<PlanOut>;
  start(batchId: string): Promise<StartOut> }, effortId: string | null, prUrls: string[], seen: Record<string, number>): Promise<AddressOutcome> {
  const planned = await rpc.plan({ kind: "address", ...effortId ? { effortId } : {}, prUrls, seen }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
  if (!planned.ok) return { ok: false, error: planned.error, skipped: [] };
  if (!planned.batchId) return { ok: false, error: `Nothing started. ${refOf(planned.skipped.slice(0, 1)) || "No PR here has feedback to address."}`, skipped: planned.skipped };
  const started = await rpc.start(planned.batchId).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
  if (!started.ok) return { ok: false, error: `Nothing started. ${started.error}`, skipped: planned.skipped };
  return { ok: true, batchId: planned.batchId, dispatchAt: started.dispatchAt, count: planned.items.length, skipped: planned.skipped };
}
/** The toast a started Address shows beside its Undo, with what it left out and why. */
export const addressToast = (outcome: Extract<AddressOutcome, { ok: true }>) => [`Addressing ${outcome.count} PR${outcome.count === 1 ? "" : "s"} in one thread`,
  outcome.skipped.length === 1 ? `left out ${refOf(outcome.skipped)}` : outcome.skipped.length ? `${outcome.skipped.length} left out, each says why` : ""].filter(Boolean).join(" · ");

/** A batch button between its click and its plan's (or Address's start's) answer: which one, and the rows it takes, which show pending. */
export type Working = { kind: DeckWrite | "advance"; prUrls: ReadonlySet<string> };
/** What the pressed button says while it works. */
export const workingLabel = (working: Working) => working.kind === "address" ? "Starting…" : "Planning…";
/**
 * One batch call at a time: another click or key while one is out is ignored. `set` shows what's working, and clears it once the call
 * answers or fails. Resolves false for an ignored call.
 */
export function oneAtATime<W = Working>(set: (working: W | null) => void) {
  let out = false;
  return async (working: W, call: () => Promise<unknown>): Promise<boolean> => {
    if (out) return false;
    out = true;
    set(working);
    try { await call(); } finally { out = false; set(null); }
    return true;
  };
}
/** A sending batch's line, from its items as dispatch settles each: "Sending 3 of 7…"; null once it isn't sending. */
export function sendingText(batch: { state: string; kind: string; items: readonly Pick<BatchItem, "state">[] }): string | null {
  if (batch.state !== "dispatching") return null;
  const n = batch.items.length;
  if (batch.kind === "address") return `Starting a thread for ${n} PR${n === 1 ? "" : "s"}…`;
  return `Sending ${Math.min(n, batch.items.filter((item) => item.state !== "pending" && item.state !== "sending").length + 1)} of ${n}…`;
}
/** One PR's read as pr_refresh_many answers it. */
export type PrRead = { prUrl: string; read: { status: "checked" | "failed" | "busy"; checkedAt: string | null; error?: string } };
/** A refresh reads four PRs to a call, one call at a time; the host reads a call's four at once. */
export const READ_CHUNK = 4;
/** A refresh's line as it goes: "Reading 3 of 7…". */
export const readingText = (upTo: number, total: number) => `Reading ${Math.min(upTo, total)} of ${total}…`;
/**
 * Refresh from GitHub, one at a time: a row's ↻, a key, or Refresh on a selection while one reads is ignored. It reads the PRs four to a
 * call, never more at once; `on.rows` hears which PRs read now, `on.progress` how far it got, and `on.reads` each call's answers, a
 * failed call answering for each of its PRs. Resolves false for an ignored trigger.
 */
export function refresher(read: (prUrls: string[]) => Promise<PrRead[]>, on: { rows(prUrls: ReadonlySet<string> | null): void;
  progress(text: string | null): void; reads(reads: PrRead[]): void }) {
  const once = oneAtATime<ReadonlySet<string>>(on.rows);
  return (prUrls: readonly string[]): Promise<boolean> => !prUrls.length ? Promise.resolve(false) : once(new Set(prUrls), async () => {
    try {
      for (let offset = 0; offset < prUrls.length; offset += READ_CHUNK) {
        const chunk = prUrls.slice(offset, offset + READ_CHUNK);
        if (prUrls.length > 1) on.progress(readingText(offset + chunk.length, prUrls.length));
        on.reads(await read(chunk).catch((cause: unknown) => chunk.map((prUrl): PrRead => ({ prUrl, read: { status: "failed", checkedAt: null, error: message(cause) } }))));
      }
    } finally { on.progress(null); }
  });
}
/** What each read leaves on its row: Read just now, or why it failed. */
export const readOutcomes = (outcomes: ReadonlyMap<string, Outcome>, reads: readonly PrRead[], at: number): ReadonlyMap<string, Outcome> =>
  reads.reduce((next, { prUrl, read }) => withOutcome(next, prUrl, { at, action: "refresh", ok: read.status === "checked",
    text: read.status === "checked" ? "Read" : read.error ?? "GitHub didn't answer" }), outcomes);
/**
 * The deck's and All PRs' refresh: the PRs reading now, which spin, the selection's progress line, and what each read left on its row;
 * `on.started` hears the PRs a read takes once it starts, and `on.reads` each call's answers. `all` reads every open PR again, in full;
 * a click while that's out is ignored, and `say` hears why GitHub's rate limit refused it.
 */
export function useRefresh(on: { started?(prUrls: ReadonlySet<string>): void; reads?(reads: PrRead[]): void; say(text: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const latest = useRef(on);
  latest.current = on;
  const [read] = useState(() => refresher((prUrls) => rpc.call("pr_refresh_many", { prUrls }).then((result) => result.reads), {
    rows: (prUrls) => { setReading(prUrls ?? new Set()); if (prUrls) latest.current.started?.(prUrls); }, progress: setProgress,
    reads: (reads) => {
      const done = new Set(reads.map((item) => item.prUrl));
      setReading((current) => new Set([...current].filter((prUrl) => !done.has(prUrl))));
      setOutcomes((current) => readOutcomes(current, reads, Date.now()));
      latest.current.reads?.(reads);
    } }));
  const [all] = useState(() => {
    const once = oneAtATime<true>(() => undefined);
    return () => void once(true, () => rpc.call("inventory_refresh", null).then((result) => {
      if (result.limitedUntil) latest.current.say(`GitHub's rate limit holds reads until ${clock(result.limitedUntil, Date.now())}`);
    }, (cause: unknown) => latest.current.say(message(cause))));
  });
  return { reading, progress, outcomes, read, all };
}

/** Each item of a batch sending now, by PR, as its row shows it. */
export type LiveItems = ReadonlyMap<string, { kind: ActedKind; state: BatchItem["state"] }>;
const NO_ITEMS: LiveItems = new Map();

/**
 * Every GitHub write from the deck or All PRs: plan it (nothing is written), list each PR in a confirm, and send it only after the
 * server's Undo window; Address starts at once instead, with the same window. `reread` is anything that changes with each read, so refusals from batches this view started show on their rows.
 */
export function useBatchConfirm(options: { seenAt(): Record<string, number>; scopeName(effortId: string): string | null; say(text: string, undo?: boolean, ms?: number): void;
  setUndo(undo: Undo | null): void; load(): void; onOpen(): void; onReturn(): void; reread: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<readonly string[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, string>>(new Map());
  /** Why the last Address left each PR out, and why it started nothing, until the next. */
  const [left, setLeft] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [once] = useState(() => oneAtATime(setWorking));
  /** Sending batches' items, and the first one's line, from deck_batch_get each second until it ends. */
  const [live, setLive] = useState<{ items: LiveItems; text: string | null }>({ items: NO_ITEMS, text: null });
  const [tick, setTick] = useState(0);
  const liveKey = useRef("");
  const latest = useRef(options);
  latest.current = options;

  const plan = useCallback(async (kind: DeckWrite | "advance", effortId: string | null, prUrls: string[] | null, reviewer = "") => {
    const { say } = latest.current;
    const reviewers = reviewer.trim() ? reviewer.split(/[\s,]+/u).map((login) => login.replace(/^@/u, "")).filter(Boolean) : undefined;
    const result = await rpc.call("deck_batch_plan", { kind, ...effortId ? { effortId } : {}, ...prUrls ? { prUrls } : {}, ...reviewers ? { reviewers } : {},
      seen: latest.current.seenAt() }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    const open = pending !== null;
    if (!result.ok) { if (open) setError(result.error); else say(result.error); return; }
    if (!result.batchId) {
      const first = result.skipped[0]; const why = first ? `${first.ref}: ${first.reason}` : "Nothing to send here."; if (open) setError(why); else say(why); return;
    }
    // One PR's listing names it: Advance from a row reads "Advance folio #340".
    const one = prUrls?.length === 1 ? result.items[0]?.ref ?? result.skipped[0]?.ref : undefined;
    const scope = one ?? (effortId ? latest.current.scopeName(effortId) ?? "this effort" : `${prUrls?.length ?? 0} PR${prUrls?.length === 1 ? "" : "s"}`);
    if (!open) latest.current.onOpen();
    setError(null); setBusy(false);
    const { batchId } = result;
    setPending({ batchId, request: { kind, effortId, prUrls }, reviewer, planned: reviewer, plan: {
      title: kind === "advance" ? `Advance ${scope}` : kind === "release" ? `Release · ${scope}` : kind === "ask" ? `Ask its thread · ${scope}`
        : kind === "fix" ? `Ask threads to fix · ${scope}` : kind === "address" ? `Address feedback · ${scope}` : `${SECTIONS[kind].title} · ${scope}`,
      sub: kind === "advance" ? `${result.items.length} action${result.items.length === 1 ? "" : "s"}, listed in full. Nothing else changes.`
        : kind === "release" ? "Each hold, listed in full. Batches and Advance can act on these again."
        : kind === "ask" ? "The listed thread gets the approval-feedback recipe. Nothing is confirmed."
        : kind === "fix" ? "Each PR's thread gets its own fix; a PR with none gets a new worker. Nothing merges." : "Each PR's one write, listed in full.",
      when: kind === "release" ? "Releases" : "Sends",
      verb: VERB[kind], items: result.items, skipped: result.skipped, request: kind === "request" || (kind === "advance" && result.items.some((item) => item.kind === "request")),
      excluded: kind === "advance" ? "Not included: merges (preview them with m) and code work, which each PR's thread does." : null } });
  }, [rpc, pending]);

  /** A started batch's Undo, and its line, which go when the window closes, since an Undo after that takes nothing back. */
  const arm = useCallback((batchId: string, dispatchAt: number, label: string, line: string) => {
    const { say, setUndo, load } = latest.current;
    setBatches((current) => [...current, batchId]);
    setUndo({ label, live: () => Date.now() < dispatchAt, run: async () => {
      const undone = await rpc.call("deck_batch_undo", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
      latest.current.say(undone.ok ? "Undone. Nothing was sent." : undone.error);
      latest.current.load();
    } });
    say(line, true, Math.max(0, dispatchAt - Date.now()));
    load();
  }, [rpc]);
  const dirty = !!pending && pending.reviewer.trim() !== pending.planned.trim();
  const start = useCallback(async () => {
    if (!pending || busy) return;
    // ⌘↵ after typing another reviewer plans again rather than send a listing that asks someone else.
    if (dirty) { void plan(pending.request.kind, pending.request.effortId, pending.request.prUrls, pending.reviewer); return; }
    setBusy(true);
    const { batchId, plan: listed } = pending;
    const started = await rpc.call("deck_batch_start", { batchId }).catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    if (!started.ok) { setError(started.error); setBusy(false); return; }
    setPending(null);
    arm(batchId, started.dispatchAt, listed.title, `${listed.verb} ${listed.items.length} · sends in ${Math.max(1, Math.round((started.dispatchAt - Date.now()) / 1_000))} s`);
  }, [rpc, pending, busy, dirty, plan, arm]);
  /** Address selected: one batch thread for these PRs, started now into its Undo window; what it leaves out, and a refusal, show on the rows. */
  const address = useCallback(async (effortId: string | null, prUrls: string[]) => {
    const outcome = await startAddress({ plan: (input) => rpc.call("deck_batch_plan", input), start: (batchId) => rpc.call("deck_batch_start", { batchId }) },
      effortId, prUrls, latest.current.seenAt());
    setLeft(new Map(outcome.skipped.map((item) => [item.prUrl, item.reason])));
    setRefusal(outcome.ok ? null : outcome.error);
    if (outcome.ok) arm(outcome.batchId, outcome.dispatchAt, "Address", addressToast(outcome));
    else latest.current.say(outcome.error);
  }, [rpc, arm]);

  // What a refused or cut-off write said, from the batches this view started, until each is done; while one sends, each item's state
  // and "Sending 3 of 7…", read each second.
  const tracking = batches.length > 0;
  useEffect(() => {
    if (!tracking) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [tracking]);
  useEffect(() => {
    let alive = true;
    void Promise.all(batches.map((batchId) => rpc.call("deck_batch_get", { batchId }).then((batch) => batch ?? batchId, () => null))).then((read) => {
      if (!alive) return;
      const sending = read.flatMap((batch) => batch && typeof batch !== "string" && batch.state === "dispatching" ? [batch] : []);
      const items = sending.flatMap((batch) => batch.items.map((item) => [item.prUrl, { kind: item.kind, state: item.state }] as const));
      const text = sending.map(sendingText).find(Boolean) ?? null;
      // A read that changed nothing keeps the same map, so the rows aren't drawn again each second.
      const key = JSON.stringify([items, text]);
      if (key !== liveKey.current) { liveKey.current = key; setLive({ items: items.length ? new Map(items) : NO_ITEMS, text }); }
      for (const batch of read) {
        if (!batch) continue;
        // A batch that's gone has nothing more to say.
        if (typeof batch === "string") { setBatches((current) => current.filter((id) => id !== batch)); continue; }
        const said = batch.items.filter((item) => (item.state === "refused" || item.state === "unknown") && item.detail);
        if (said.length) setDetails((current) => new Map([...current, ...said.map((item) => [item.prUrl, item.detail!] as const)]));
        if (batch.state !== "done" && batch.state !== "cancelled") continue;
        setBatches((current) => current.filter((id) => id !== batch.id));
        const sent = batch.items.filter((item) => item.state === "sent").length;
        if (batch.state === "done") {
          latest.current.say([`${sent} ${batch.kind === "address" ? "started" : "sent"}`, batch.items.length - sent && `${batch.items.length - sent} not sent`].filter(Boolean).join(" · "));
          latest.current.load();
        }
      }
    });
    return () => { alive = false; };
  }, [options.reread, batches, rpc, tick]);

  const element = <DeckDialog open={pending !== null} title={pending?.plan.title ?? ""} sub={pending?.plan.sub} onClose={() => setPending(null)} onReturn={options.onReturn}
    onConfirmKey={() => void start()}>
    {pending ? <ConfirmBody plan={pending.plan} busy={busy} error={error} reviewer={pending.reviewer} dirty={dirty} onReviewer={(value) => setPending({ ...pending, reviewer: value })}
      onReplan={() => void plan(pending.request.kind, pending.request.effortId, pending.request.prUrls, pending.reviewer)} onConfirm={() => void start()}
      onCancel={() => setPending(null)} /> : null}
  </DeckDialog>;
  return {
    /** A click or key's plan: its button works, and its rows show pending, until the plan answers; a second while one is out is ignored. */
    plan: (kind: DeckWrite | "advance", effortId: string | null, prUrls: string[] | null) => once({ kind, prUrls: new Set(prUrls ?? []) }, () => plan(kind, effortId, prUrls)),
    address: (effortId: string | null, prUrls: string[]) => once({ kind: "address", prUrls: new Set(prUrls) }, () => address(effortId, prUrls)),
    working, sending: live.text, live: tracking ? live.items : NO_ITEMS,
    refusal, details: left.size ? new Map([...details, ...left]) : details, open: pending !== null, element };
}

/**
 * The one key registry's handler for a view: only while focus is in `root` (or nowhere), never while you type (⌘K aside), and a key
 * that can't run here says why in the hint bar. Enter opens a row's details only on the row itself; on a button it's that button's click.
 */
export function useRegistryKeys(rootRef: RefObject<HTMLElement | null>, handlers: { on(): Availability; run(id: DeckActionId, n?: number): void; say(text: string): void;
  isRow(target: HTMLElement): boolean }) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || (active && active !== document.body && !root.contains(active))) return;
      const hit = actionForKey(event);
      const typing = typingTarget(event.target);
      if (event.key === "Escape") { if (hit && !typing) { event.preventDefault(); latest.current.run("clear"); } return; }
      if (!hit || (typing && hit.id !== "palette")) return;
      if (hit.id === "expand" && !(event.target instanceof HTMLElement && latest.current.isRow(event.target))) return;
      event.preventDefault();
      const available = latest.current.on()[hit.id];
      if (available.on) latest.current.run(hit.id, hit.n);
      else if (available.why && available.why !== "you're here") latest.current.say(`${ACTION[hit.id].title.replace("…", "")}: ${available.why}.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef]);
}
