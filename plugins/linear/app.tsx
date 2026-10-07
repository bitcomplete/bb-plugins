// The plugin's settings section: connect or disconnect Linear, and who the
// connection acts as.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

interface Status {
  connected: boolean;
  configured: boolean;
  user: { id: string; name: string; email: string | null } | null;
  organization: { name: string; urlKey: string } | null;
  linearUrl: string;
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

  const disconnect = async () => {
    setBusy(true);
    try {
      await rpc.call("disconnect");
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

  return (
    <div className="flex flex-col gap-4 text-sm">
      {status.connected ? (
        <div className="flex items-center justify-between gap-4">
          <p>
            Connected
            {status.user !== null ? (
              <>
                {" "}as <code>{status.user.name}</code>
              </>
            ) : null}
            {status.organization !== null ? (
              <>
                {" "}in <code>{status.organization.name}</code>
              </>
            ) : null}
            . Threads read and update issues as you.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
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
    description: "The Linear account this server's threads act as.",
    component: LinearSection,
  });
});
