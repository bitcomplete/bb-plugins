// The plugin's settings section: the Linear workspaces this server is
// connected to and who each acts as; connect another, pick the default,
// disconnect one.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { WatchesSection } from "@/components/watches-section";
import { WATCHES_CHANGED } from "./channels";

interface Account {
  key: string;
  user: { id: string; name: string; email: string | null };
  organization: { name: string; urlKey: string };
  isDefault: boolean;
}

interface Status {
  connected: boolean;
  configured: boolean;
  linearUrl: string;
  accounts: Account[];
}

function LinearSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("status").then(
      (s: Status) => {
        setStatus(s);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("connection-changed", refetch);

  const open = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await rpc.call("connect");
      open(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  const several = status.accounts.length > 1;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {status.connected ? (
        <>
          <ul className="flex flex-col gap-2">
            {status.accounts.map((a) => (
              <li key={a.key} className="flex items-center justify-between gap-4">
                <p>
                  <code>{a.organization.name}</code> as <code>{a.user.name}</code>
                  {several && a.isDefault ? <span className="text-muted-foreground"> · default</span> : null}
                </p>
                <div className="flex shrink-0 gap-2">
                  {several && !a.isDefault ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => rpc.call("setDefault", { account: a.key }))}>
                      Make default
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => rpc.call("disconnect", { account: a.key }))}>
                    Disconnect
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground">
              {several
                ? "Threads read and update issues as you. An issue or team key picks its workspace; anything else goes to the default."
                : "Threads read and update issues as you. Connect another workspace to use more than one; Linear asks which."}
            </p>
            <Button variant="outline" size="sm" disabled={busy || !status.configured} onClick={() => void connect()}>
              Connect another workspace
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground">
            {status.configured
              ? "Connect your Linear account so threads can read and update issues as you. You approve it on Linear."
              : "Enter the Linear OAuth application's client ID above, then connect."}
          </p>
          <Button size="sm" disabled={busy || !status.configured} onClick={() => void connect()}>
            Connect Linear
          </Button>
        </div>
      )}
      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "linear",
    title: "Linear",
    description: "The Linear workspaces this server's threads act in, and as whom.",
    component: LinearSection,
  });
  app.slots.settingsSection({
    id: "watches",
    title: "Watches",
    description: "What this server's threads are waiting on in Linear, how often each watch has fired, what stewards has leased, and the doorbell stream's state.",
    component: () => <WatchesSection changedChannel={WATCHES_CHANGED} targetLabel="issue" />,
  });
});
