// The plugin's settings section: whether this server is signed in to Slack as
// you, and which bb project a Slack conversation starts its thread in. The
// token itself is never shown.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { CONNECTION_CHANGED } from "./channels";

interface Project {
  id: string;
  name: string;
  kind: string;
}

interface Status {
  signedIn: boolean;
  user: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  projects: Project[];
  hooks: { configured: boolean; connected: boolean; state: string };
}

function SlackSection() {
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
  useRealtime(CONNECTION_CHANGED, refetch);

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

  const signin = async () => {
    setBusy(true);
    try {
      const { url } = await rpc.call("signinStart");
      if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  const signedInAs = status.user?.name ?? null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {!status.hooks.configured ? (
        <p className="text-muted-foreground">This bb server has no bb-gate-hooks service (BB_HOOKS_URL is not set), so the Slack app cannot reach it.</p>
      ) : null}
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground">
          {status.signedIn
            ? `Signed in as ${signedInAs ?? "you"}. DMs to the team's bb app reach this server and answer in Slack.`
            : "Sign in with Slack once so a DM to the team's bb app reaches your bb. This proves who you are; it grants no message access."}
        </p>
        {status.signedIn ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => rpc.call("signout"))}>
            Sign out
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !status.hooks.configured || !status.hooks.connected} onClick={() => void signin()}>
            Sign in with Slack
          </Button>
        )}
      </div>
      {status.projects.length > 0 ? (
        <label className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Project a Slack conversation starts its bb thread in</span>
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            disabled={busy}
            value={status.project?.id ?? ""}
            onChange={(e) => void act(() => rpc.call("setProject", { projectId: e.target.value }))}
          >
            {status.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.kind === "personal" ? " (personal)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {!status.hooks.connected && status.hooks.configured ? <p className="text-muted-foreground">Connecting to bb-gate-hooks…</p> : null}
      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "slack",
    title: "Slack",
    description: "The Slack account this server answers as, and where a Slack conversation starts its bb thread.",
    component: SlackSection,
  });
});
