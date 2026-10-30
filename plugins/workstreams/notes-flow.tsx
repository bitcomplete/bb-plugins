// The confirm for one PR's review notes, shared by the effort deck and All
// PRs (plan amendment A17, after live use): it reads the approval's notes and
// what came after them from GitHub now, shows both, and leads with Confirm
// handled only when something since the approval shows the notes handled.
// Otherwise asking the PR's thread leads, through the deck's listing confirm
// and Undo window, when it has somewhere to go (the dialog says where, or
// why not), and confirming anyway is a click on its own button that the
// record keeps as confirmed without evidence. No batch or Advance
// reaches this: it is one PR at a time.
import { useCallback, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { ConfirmRead } from "./approval-evidence";
import { notesScreen } from "./deck-view-model";
import { NotesBody } from "./deck-screen";
import { DeckDialog, message } from "./deck-flow";

export function useNotesConfirm(options: { say(text: string): void; load(): void; onOpen(): void; onReturn(): void;
  /** Plan Ask for this PR: the listing confirm, then its Undo window. */
  ask(prUrl: string, effortId: string | null): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState<{ prUrl: string; ref: string; effortId: string | null } | null>(null);
  const [read, setRead] = useState<ConfirmRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(options);
  latest.current = options;
  // Which opening an answer belongs to: a slow read or confirm for one PR never lands in the dialog opened for another.
  const opened = useRef(0);

  const show = useCallback((prUrl: string, ref: string, effortId: string | null) => {
    latest.current.onOpen();
    const id = ++opened.current;
    setTarget({ prUrl, ref, effortId }); setRead(null); setError(null); setBusy(false);
    const land = (result: ConfirmRead) => { if (opened.current === id) setRead(result); };
    void rpc.call("inventory_confirm_read", { prUrl }).then(land, (cause: unknown) => land({ ok: false, error: message(cause) }));
  }, [rpc]);
  const close = () => setTarget(null);
  const fresh = read?.ok ? read : null;
  const screen = fresh ? notesScreen(fresh, Date.now()) : null;

  /** Record the notes handled on the head and notes this read showed; `anyway` only from Confirm anyway's own button. */
  async function confirmNotes(anyway: boolean) {
    if (!target || !fresh || busy) return;
    const id = opened.current;
    setBusy(true);
    const result = await rpc.call("inventory_confirm_handled", { prUrl: target.prUrl, headOid: fresh.headOid, fingerprint: fresh.fingerprint, ...anyway ? { anyway } : {} })
      .catch((cause: unknown) => ({ ok: false as const, error: message(cause) }));
    const current = opened.current === id;
    if (current) setBusy(false);
    if (!result.ok) { if (current) setError(result.error); return; }
    if (current) close();
    latest.current.say(result.detail);
    latest.current.load();
  }
  function ask() {
    if (!target) return;
    const { prUrl, effortId } = target;
    close();
    // The listing confirm opens once this dialog has handed focus back.
    window.setTimeout(() => latest.current.ask(prUrl, effortId), 0);
  }
  const lead = () => { if (screen?.primary === "confirm") void confirmNotes(false); else if (screen?.primary === "ask") ask(); };

  const element = <DeckDialog open={target !== null} title={target ? `Review notes · ${target.ref}` : ""} onClose={close} onReturn={options.onReturn} onConfirmKey={lead}>
    {target ? <NotesBody screen={screen} failed={read && !read.ok ? read.error : null} busy={busy} error={error}
      onConfirm={() => void confirmNotes(false)} onAnyway={() => void confirmNotes(true)} onAsk={ask} onCancel={close} /> : null}
  </DeckDialog>;
  return { show, open: target !== null, element };
}
