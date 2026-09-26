import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PrHold } from "./pr-holds";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type HoldTarget = { url: string; label: string; hold?: PrHold | null };
export function usePrHoldControls() {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState<HoldTarget | null>(null);
  const release = async (url: string) => {
    try { await rpc.call("pr_hold_set", { prUrl: url, held: false }); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Could not release hold"); }
  };
  return { target, edit: setTarget, close: () => setTarget(null), release };
}

export function PrHoldDialog({ target, onClose }: { target: HoldTarget | null; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason(target?.hold?.reason ?? ""); setError(null); }, [target]);
  const save = async () => {
    if (target === null || busy) return;
    setBusy(true); setError(null);
    try { await rpc.call("pr_hold_set", { prUrl: target.url, held: true, reason: reason.trim() }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save hold"); }
    finally { setBusy(false); }
  };
  return <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{target?.hold ? "Edit hold" : "Put PR on hold"}</DialogTitle><DialogDescription>{target?.label}</DialogDescription></DialogHeader>
      <p className="text-[12px] text-muted-foreground">Hold blocks new Advance, automatic actions, and merges. Existing workers continue; GitHub readiness and linked threads stay available.</p>
      <label className="flex flex-col gap-1.5 text-[12px]">Reason (optional)<textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Waiting for product approval…" className="resize-y rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      {error ? <p role="alert" className="text-[12px] text-destructive">{error}</p> : null}
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : target?.hold ? "Save reason" : "Put on hold"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
