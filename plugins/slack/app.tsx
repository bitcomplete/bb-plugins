// The plugin's settings section: whether this server is signed in to Slack as
// you, which bb project a Slack conversation starts its thread in by default,
// and the channel → project map. The token itself is never shown.
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

interface ChannelEntry {
  channel: string;
  project: string;
}

interface Status {
  signedIn: boolean;
  user: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  projects: Project[];
  channels: ChannelEntry[];
  hooks: { configured: boolean; connected: boolean; state: string };
}

/** The name shown beside a channel id when one is known. Only the reserved `dm` has one. */
function channelLabel(channel: string): string | null {
  return channel.trim().toLowerCase() === "dm" ? "Direct message" : null;
}

/** The channel → project map: a row per channel, saved together. */
function ChannelMapEditor({ status, busy, save }: { status: Status; busy: boolean; save: (entries: ChannelEntry[]) => void }) {
  const [rows, setRows] = useState<ChannelEntry[]>(status.channels);
  useEffect(() => setRows(status.channels), [status.channels]);
  const projectNames = status.projects.map((p) => p.name);
  const valid = rows.filter((row) => row.channel.trim() !== "" && row.project.trim() !== "");
  const dirty = JSON.stringify(valid) !== JSON.stringify(status.channels);
  const change = (index: number, patch: Partial<ChannelEntry>) =>
    setRows((all) => all.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        A mention in a channel starts its thread in the project beside it. A channel is a Slack channel id (<code>C…</code> or <code>G…</code>), never a name, so
        renaming a channel does not break its entry; the reserved <code>dm</code> is a direct message with the app. A channel or DM with no entry uses the project above.
      </p>
      {rows.length === 0 ? <p className="text-muted-foreground">No channel entries yet.</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <label className="flex flex-col gap-0.5">
            <input
              className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
              placeholder="C0123 or dm"
              value={row.channel}
              disabled={busy}
              onChange={(e) => change(index, { channel: e.target.value })}
            />
            {channelLabel(row.channel) !== null ? <span className="text-xs text-muted-foreground">{channelLabel(row.channel)}</span> : null}
          </label>
          <select
            className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
            value={row.project}
            disabled={busy}
            onChange={(e) => change(index, { project: e.target.value })}
          >
            {projectNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setRows((all) => all.filter((_, i) => i !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || projectNames.length === 0}
          onClick={() => setRows((all) => [...all, { channel: "", project: projectNames[0] ?? "" }])}
        >
          Add channel
        </Button>
        <Button size="sm" disabled={busy || !dirty} onClick={() => save(valid)}>
          Save map
        </Button>
      </div>
    </div>
  );
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
            ? `Signed in as ${signedInAs ?? "you"}. DMs and channel mentions of the team's bb app reach this server and answer in Slack.`
            : "Sign in with Slack once so a DM or a channel mention of the team's bb app reaches your bb. This proves who you are; it grants no message access."}
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
      {status.projects.length > 0 ? (
        <ChannelMapEditor status={status} busy={busy} save={(entries) => void act(() => rpc.call("setChannels", { entries }))} />
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
