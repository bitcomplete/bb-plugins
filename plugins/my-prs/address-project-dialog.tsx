import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Selection } from "./types.js";
import type { z } from "zod";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";

type Targets = z.infer<(typeof rpcContract)["address_targets"]["output"]>;
type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; targets: Targets };

export function AddressProjectDialog({ items, onClose, onStart }: {
  items: Selection[];
  onClose: () => void;
  onStart: (projectId: string) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [projectId, setProjectId] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    rpc.call("address_targets", { items: items.map(({ id, activity }) => ({ id, activity })) }).then((targets) => {
      if (!active) return;
      setLoad({ kind: "ready", targets });
      setProjectId(targets.projectId ?? "");
    }, (cause) => {
      if (active) setLoad({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { active = false; };
  }, [items, rpc]);

  const start = async () => {
    if (starting || projectId === "" || load.kind !== "ready") return;
    setStarting(true);
    setError(null);
    try { await onStart(projectId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStarting(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) onClose(); }}>
      <DialogContent hideCloseButton={starting} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{items.length === 1 ? "Address feedback" : `Address ${items.length} pull requests`}</DialogTitle>
          <DialogDescription>Choose the project for this feedback thread.</DialogDescription>
        </DialogHeader>
        {load.kind === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading projects…</p> : null}
        {load.kind === "error" ? <p role="alert" className="text-sm text-destructive">{load.message}</p> : null}
        {load.kind === "ready" ? (
          <div className="grid gap-2">
            <label htmlFor="address-project" className="text-sm font-medium">Project</label>
            <select id="address-project" value={projectId} disabled={starting}
              onChange={(event) => setProjectId(event.target.value)}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="" disabled>Choose a project</option>
              {load.targets.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              {load.targets.projects.length === 0 ? "Add a project checkout in BB to address feedback."
                : load.targets.reason === "mixed" ? "These PRs map to different projects. Choose one for this batch."
                : load.targets.reason === "organization" ? "Preselected from your organization mappings."
                : load.targets.reason === "default" ? "Preselected from your default feedback project."
                : "This selection has no available default project."}
            </p>
          </div>
        ) : null}
        {error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={starting} onClick={onClose}>Cancel</Button>
          <Button disabled={starting || load.kind !== "ready" || projectId === ""} onClick={start}>
            {starting ? "Starting…" : "Address feedback"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
