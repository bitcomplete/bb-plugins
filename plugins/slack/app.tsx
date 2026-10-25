// The plugin's settings section: whether this server is signed in to Slack as
// you, which bb project a Slack conversation starts its thread in by default,
// and the channel → project map. The channel box is a typeahead over the
// channels you can see, read from Slack with your own sign-in token; the id is
// what is stored. The token itself is never shown.
import { useCallback, useEffect, useMemo, useState } from "react";
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

/** One channel the search RPC can return. */
interface ChannelOption {
  id: string;
  name: string;
  private: boolean;
  extShared: boolean;
}

interface ChannelSearch {
  state: "ok" | "signin-required" | "unavailable";
  channels: ChannelOption[];
  botChannels: string[] | null;
  truncated: boolean;
  message?: string;
}

interface Status {
  signedIn: boolean;
  user: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  projects: Project[];
  channels: ChannelEntry[];
  hooks: { configured: boolean; connected: boolean; state: string };
}

/** The reserved channel-map key for a direct message with the app. */
const DM_CHANNEL = "dm";
/** A Slack channel id: `C…` or `G…`, never a name. */
const CHANNEL_ID = /^[CG][A-Z0-9]+$/i;

const isDm = (channel: string): boolean => channel.trim().toLowerCase() === DM_CHANNEL;
const isChannelId = (channel: string): boolean => CHANNEL_ID.test(channel.trim());

/** Whether the map key is a channel id bb's bot is not a member of. */
function needsInvite(channel: string, botChannels: string[] | null): boolean {
  return botChannels !== null && isChannelId(channel) && !botChannels.includes(channel.trim());
}

/** The one-line note under a row: private, Slack Connect, or not invited yet. */
function channelNote(channel: string, options: ChannelOption[], botChannels: string[] | null): string | null {
  if (isDm(channel) || channel.trim() === "") return null;
  if (needsInvite(channel, botChannels)) return "bb is not in this channel yet; invite it";
  const known = options.find((c) => c.id === channel.trim());
  if (known === null || known === undefined) return null;
  if (known.extShared) return "Slack Connect channel";
  if (known.private) return "Private channel";
  return null;
}

/** The meta text beside an option in the dropdown. */
function optionMeta(option: ChannelOption, botChannels: string[] | null): string {
  const parts: string[] = [];
  if (option.private) parts.push("private");
  if (option.extShared) parts.push("Slack Connect");
  if (needsInvite(option.id, botChannels)) parts.push("bb is not in this channel yet; invite it");
  return parts.join(" · ");
}

/** One clickable row of the picker's dropdown. */
function PickerRow({ label, meta, selected, onClick }: { label: string; meta: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left hover:bg-state-hover ${selected ? "bg-state-active" : ""}`}
      // mousedown, not click: it runs before the input's blur closes the list.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      <span className="truncate">{label}</span>
      {meta !== "" ? <span className="shrink-0 text-xs text-muted-foreground">{meta}</span> : null}
    </button>
  );
}

/**
 * The channel box. With a searchable token it is a typeahead over the
 * developer's channels, showing `#name` and a lock for a private channel, and
 * storing the id; a pasted `C…`/`G…` id and `dm` are still accepted. Without
 * one it is the plain id box the picker falls back to.
 */
function ChannelPicker({
  value,
  options,
  botChannels,
  canSearch,
  disabled,
  onChange,
}: {
  value: string;
  options: ChannelOption[];
  botChannels: string[] | null;
  canSearch: boolean;
  disabled: boolean;
  onChange: (channel: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((c) => c.id === value.trim()) ?? null;
  const label = isDm(value) ? "Direct message" : selected !== null ? `#${selected.name}` : value;
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  /** Store what was typed: an exact id, an exact name, a pasted id, or `dm`. */
  const accept = (text: string) => {
    const typed = text.trim();
    if (typed === "") return close();
    if (typed.toLowerCase() === DM_CHANNEL) {
      onChange(DM_CHANNEL);
      return close();
    }
    const byId = options.find((c) => c.id === typed);
    if (byId !== undefined) {
      onChange(byId.id);
      return close();
    }
    const byName = options.find((c) => c.name.toLowerCase() === typed.toLowerCase());
    if (byName !== undefined) {
      onChange(byName.id);
      return close();
    }
    if (isChannelId(typed)) {
      onChange(typed);
      return close();
    }
    close();
  };

  const wanted = query.trim().toLowerCase();
  const allMatches = useMemo(
    () => (wanted === "" ? options : options.filter((c) => c.name.toLowerCase().includes(wanted) || c.id.toLowerCase().includes(wanted))),
    [options, wanted],
  );
  const matches = allMatches.slice(0, 50);
  const capped = allMatches.length > matches.length;
  const rawId = isChannelId(query) && !options.some((c) => c.id === query.trim()) ? query.trim() : null;

  if (!canSearch) {
    return (
      <input
        className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
        placeholder="C0123 or dm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="relative">
      <input
        className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
        placeholder="Search channels or paste an id"
        value={open ? query : label}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            accept(query);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          if (open) accept(query);
        }}
      />
      {open ? (
        <div className="absolute z-10 mt-1 w-72 rounded-md border border-input bg-popover p-1 text-sm shadow-md">
          <div className="max-h-56 overflow-auto">
            {wanted === "" || "direct message".includes(wanted) ? (
              <PickerRow label="Direct message" meta="dm" selected={isDm(value)} onClick={() => { onChange(DM_CHANNEL); close(); }} />
            ) : null}
            {matches.map((option) => (
              <PickerRow
                key={option.id}
                label={`${option.private ? "🔒 " : ""}#${option.name}`}
                meta={optionMeta(option, botChannels)}
                selected={option.id === value.trim()}
                onClick={() => {
                  onChange(option.id);
                  close();
                }}
              />
            ))}
            {rawId !== null ? (
              <PickerRow label={`Use id ${rawId}`} meta="not in the list" selected={value.trim() === rawId} onClick={() => { onChange(rawId); close(); }} />
            ) : null}
            {capped ? <p className="px-2 py-1 text-xs text-muted-foreground">Refine your search to see more.</p> : null}
            {matches.length === 0 && wanted !== "" && rawId === null ? <p className="px-2 py-1 text-muted-foreground">No matching channels.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The channel → project map: a row per channel, saved together. */
function ChannelMapEditor({
  status,
  search,
  busy,
  save,
}: {
  status: Status;
  search: ChannelSearch | null;
  busy: boolean;
  save: (entries: ChannelEntry[]) => void;
}) {
  const [rows, setRows] = useState<ChannelEntry[]>(status.channels);
  useEffect(() => setRows(status.channels), [status.channels]);
  const projectNames = status.projects.map((p) => p.name);
  const valid = rows.filter((row) => row.channel.trim() !== "" && row.project.trim() !== "");
  const dirty = JSON.stringify(valid) !== JSON.stringify(status.channels);
  const change = (index: number, patch: Partial<ChannelEntry>) =>
    setRows((all) => all.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const options = search?.channels ?? [];
  const botChannels = search?.botChannels ?? null;
  const canSearch = search?.state === "ok";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        A mention in a channel starts its thread in the project beside it. The channel is a Slack channel id (<code>C…</code> or <code>G…</code>), never a name, so
        renaming a channel does not break its entry; the reserved <code>dm</code> is a direct message with the app. A channel or DM with no entry uses the project above.
      </p>
      {search !== null && search.state !== "ok" ? (
        <p className="text-muted-foreground">
          {search.state === "signin-required"
            ? status.signedIn
              ? "Sign in again to search channels; paste a channel id instead."
              : "Sign in with Slack to search channels; paste a channel id instead."
            : `Could not search channels right now${search.message !== undefined ? ` (${search.message})` : ""}; paste a channel id instead.`}
        </p>
      ) : null}
      {search !== null && search.state === "ok" && search.truncated ? (
        <p className="text-muted-foreground">Slack has more channels than could be listed here; some may be missing from the search.</p>
      ) : null}
      {rows.length === 0 ? <p className="text-muted-foreground">No channel entries yet.</p> : null}
      {rows.map((row, index) => {
        const note = channelNote(row.channel, options, botChannels);
        return (
          <div key={index} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <ChannelPicker
                value={row.channel}
                options={options}
                botChannels={botChannels}
                canSearch={canSearch}
                disabled={busy}
                onChange={(channel) => change(index, { channel })}
              />
              <select
                className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                value={row.project}
                disabled={busy}
                onChange={(e) => change(index, { project: e.target.value })}
              >
                {!projectNames.includes(row.project) ? <option value={row.project}>{row.project} (not on this server)</option> : null}
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
            {note !== null ? <span className="text-xs text-muted-foreground">{note}</span> : null}
          </div>
        );
      })}
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
  const [search, setSearch] = useState<ChannelSearch | null>(null);
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

  const loadChannels = useCallback(() => {
    rpc.call("searchChannels", { query: "" }).then(
      (result: ChannelSearch) => setSearch(result),
      (e: unknown) => {
        setSearch(null);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [rpc]);
  // Reload when sign-in changes: a fresh token must not be served the old list.
  useEffect(loadChannels, [loadChannels, status?.signedIn]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      refetch();
      loadChannels();
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
            ? `Signed in as ${signedInAs ?? "you"}. DMs and channel mentions of the team's bb app reach this server and answer in Slack. The sign-in also lets this page list the channels you can see.`
            : "Sign in with Slack once so a DM or a channel mention of the team's bb app reaches your bb. This proves who you are and lets this page list the channels you can see; it grants no message access."}
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
        <ChannelMapEditor status={status} search={search} busy={busy} save={(entries) => void act(() => rpc.call("setChannels", { entries }))} />
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
