// The manual "Fetch Linear details via agent" action in How this works. It
// never runs on its own: a click reads how many tickets it would ask about,
// the dialog says so, and only Confirm spawns the one thread.
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { POINTER_CURSORS, cn } from "@/lib/utils";
import { toast } from "sonner";

type Plan = { tickets: number; capped: number; running: boolean; keys: number };

export function LinearFetchAction() {
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    setBusy(true);
    rpc.call("linear_fetch_plan").then(
      (result) => {
        setBusy(false);
        if (result.ok) setPlan(result);
        else toast.error(result.error);
      },
      (failure: unknown) => {
        setBusy(false);
        toast.error(String(failure));
      },
    );
  };

  const confirm = () => {
    setBusy(true);
    rpc.call("linear_fetch_run").then(
      (result) => {
        setBusy(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPlan(null);
        toast.success(`Asking an agent about ${result.asked} ${result.asked === 1 ? "ticket" : "tickets"}.`);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(String(failure));
      },
    );
  };

  const nothing = plan !== null && plan.tickets === 0;
  return (
    <>
      <Button variant="outline" size="sm" disabled={busy} onClick={open}>
        Fetch Linear details via agent
      </Button>
      <Dialog open={plan !== null} onOpenChange={(next) => (next ? null : setPlan(null))}>
        <DialogContent className={cn("max-w-md", POINTER_CURSORS)}>
          <DialogHeader>
            <DialogTitle>Fetch Linear details via agent</DialogTitle>
            <DialogDescription>
              {plan === null
                ? null
                : nothing
                  ? "Every ticket on the board already has Linear detail or is covered by an API key."
                  : `One new thread, in the BB project that holds your checkouts, will look up ${plan.capped} ${plan.capped === 1 ? "ticket" : "tickets"} with that project's Linear tools.`}
            </DialogDescription>
          </DialogHeader>
          {plan === null || nothing ? null : (
            <p className="text-[12.5px] text-muted-foreground">
              Tickets an API key covers are never sent.
              {plan.tickets > plan.capped ? ` ${plan.tickets - plan.capped} more wait for the next run.` : ""} Only titles,
              states, projects and parents are read back; nothing in Linear changes.
              {plan.running ? " A fetch is already running." : ""}
            </p>
          )}
          {error === null ? null : (
            <p role="alert" className="text-[12.5px] text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setPlan(null)} disabled={busy}>
              {nothing ? "Close" : "Cancel"}
            </Button>
            {nothing ? null : (
              <Button disabled={busy || plan?.running === true} onClick={confirm}>
                Start thread
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
