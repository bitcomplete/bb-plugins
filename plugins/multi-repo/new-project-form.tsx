/**
 * Create a multi-repo project in one step.
 *
 * bb's own New project dialog wants a source directory and knows nothing
 * about this plugin, so setting a project up used to mean creating an empty
 * directory by hand, pointing a project at it, and then coming here to give
 * it repos. This form folds those into one: it clones the remote (or adopts
 * a local checkout) and creates the project pointing at it. It does nothing
 * else to the repo — no seed commit, no push, no pull request. The Repos
 * panel seeds `.bb/` and publishes it, by the project's policy, the first
 * time a repo is added.
 *
 * The URL comes first and everything else is derived from it. The name is the
 * URL's last component and the location follows the name. Nothing else is
 * shown until a probe of the remote answers: the probe decides how the project
 * is stood up (a standalone `.bb` repo, a primary repo, a plain repo or a
 * local checkout), and there is nothing useful to ask before it does. A probe
 * error stays under the field and reveals nothing. Every derived field stays
 * editable — it is recomputed until the user edits it, and then left alone —
 * because an edited field that silently reverts is the kind of form nobody
 * trusts twice.
 *
 * The probe runs on blur or Enter, never per keystroke, and changing the
 * machine runs it again on the new one.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { DiscoveredCheckout, ProbeRemoteResult, rpcContract } from "./contract.js";
import { createReady, deriveName, fieldsRevealed, locationFrozen, probeNeeded, sourceFromProbe } from "./new-project-derive.js";

interface HostOption {
  id: string;
  name: string;
  connected: boolean;
  primary: boolean;
}

interface NewProjectFormProps {
  onCancel: () => void;
  onCreated: (projectId: string, warnings: readonly string[]) => void;
}

type Probe =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "done"; result: ProbeRemoteResult }
  | { status: "error"; message: string };

export function NewProjectForm({ onCancel, onCreated }: NewProjectFormProps) {
  const rpc = useRpc<typeof rpcContract>();
  const suggestionsListId = useId();
  const [hosts, setHosts] = useState<HostOption[] | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [pathAdopted, setPathAdopted] = useState(false);
  const [pathExists, setPathExists] = useState(false);
  const [probe, setProbe] = useState<Probe>({ status: "idle" });
  const [revealed, setRevealed] = useState(false);
  const [suggestions, setSuggestions] = useState<DiscoveredCheckout[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("hosts", null)
      .then((result) => {
        if (cancelled) return;
        setHosts(result.hosts);
        setHostId((current) => {
          if (current !== null) return current;
          const preferred =
            result.hosts.find((entry) => entry.primary && entry.connected) ??
            result.hosts.find((entry) => entry.connected) ??
            result.hosts[0];
          return preferred?.id ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) setHosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // The name follows the URL's last component until the user edits it.
  useEffect(() => {
    setName((current) => deriveName(url, current, nameEdited));
  }, [url, nameEdited]);

  // The suggested location follows the name and machine until it is edited.
  // Debounced because it is a host round trip per keystroke otherwise, and
  // sequenced so a slow early answer cannot overwrite a fast later one.
  const suggestionSeq = useRef(0);
  useEffect(() => {
    if (locationFrozen(pathEdited, pathAdopted) || hostId === null || name.trim().length === 0) return;
    const seq = ++suggestionSeq.current;
    const timer = window.setTimeout(() => {
      void rpc
        .call("suggestProjectSource", { hostId, name: name.trim() })
        .then((result) => {
          if (seq !== suggestionSeq.current) return;
          setPath(result.path);
          setPathExists(result.exists);
        })
        .catch(() => {
          // No suggestion is survivable: the field is editable.
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [rpc, hostId, name, pathEdited, pathAdopted]);

  // Local checkouts on the chosen machine, for the URL field's completions.
  useEffect(() => {
    if (hostId === null || path.length === 0) return;
    let cancelled = false;
    void rpc
      .call("suggestRepos", { hostId, path })
      .then((result) => {
        if (!cancelled) setSuggestions(result.checkouts);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, hostId, path]);

  // A local path that is already a checkout is adopted as the project source,
  // so show where it is. This freezes the location the way an edit does, but
  // only until the URL changes — see `onUrlChanged`.
  useEffect(() => {
    if (probe.status !== "done" || probe.result.outcome !== "checkout") return;
    if (locationFrozen(pathEdited, pathAdopted)) return;
    setPath(url.trim());
    setPathExists(true);
    setPathAdopted(true);
  }, [probe, url, pathEdited, pathAdopted]);

  const probeSeq = useRef(0);
  // The URL and machine the last probe answered for. A blur or Enter that
  // matches this is a no-op, so clicking a revealed field does not start a
  // probe that unmounts it under the cursor.
  const lastProbe = useRef<{ url: string; hostId: string } | null>(null);
  const runProbe = useCallback(
    (probeHostId: string | null = hostId) => {
      const value = url.trim();
      if (probeHostId === null || value.length === 0) return;
      const seq = ++probeSeq.current;
      setProbe({ status: "probing" });
      void rpc
        .call("probeRemote", { hostId: probeHostId, url: value })
        .then((result) => {
          if (seq !== probeSeq.current) return;
          lastProbe.current = { url: value, hostId: probeHostId };
          setProbe({ status: "done", result });
          setRevealed(true);
        })
        .catch((caught: unknown) => {
          if (seq !== probeSeq.current) return;
          setProbe({
            status: "error",
            message: caught instanceof Error ? caught.message : "Could not read that remote.",
          });
        });
    },
    [rpc, url, hostId],
  );

  const runProbeIfNeeded = useCallback(() => {
    if (!probeNeeded(lastProbe.current, url.trim(), hostId)) return;
    runProbe();
  }, [runProbe, url, hostId]);

  // Invalidate any in-flight probe, so a result for the old URL or machine
  // cannot land as the answer for the new one.
  const resetProbe = useCallback(() => {
    probeSeq.current += 1;
    setProbe({ status: "idle" });
  }, []);

  const revealedFields = fieldsRevealed(revealed, probe.status);
  const urlOutcome = probe.status === "done" ? probe.result.outcome : null;

  const source = useMemo(
    () => (probe.status === "done" ? sourceFromProbe(probe.result.outcome, url.trim()) : null),
    [probe, url],
  );

  const ready = createReady({
    submitting,
    probe: probe.status,
    hostId,
    name,
    path,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || hostId === null || source === null) return;
    setSubmitting(true);
    setError(null);
    void rpc
      .call("createProject", {
        name: name.trim(),
        hostId,
        path: path.trim(),
        source,
      })
      .then((result) => {
        if (result.ok && result.projectId !== null) {
          onCreated(result.projectId, result.warnings);
        } else {
          setError(result.error ?? "Could not create the project.");
        }
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not create the project."))
      .finally(() => setSubmitting(false));
  };

  // Enter in the URL field probes instead of submitting the form.
  const onUrlKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runProbeIfNeeded();
  };

  const selectedHost = hosts?.find((entry) => entry.id === hostId) ?? null;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border p-4">
      <h2 className="text-sm font-medium">New multi-repo project</h2>

      <label className="block space-y-1 text-sm">
        <span className="text-muted-foreground text-xs">Git remote or local path</span>
        <input
          type="text"
          list={suggestionsListId}
          className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs"
          placeholder="git@github.com:you/repo.git, https://…, or /path/to/checkout"
          value={url}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          disabled={submitting}
          onKeyDown={onUrlKeyDown}
          onBlur={runProbeIfNeeded}
          onChange={(event) => {
            setUrl(event.target.value);
            // A new URL re-derives the location, but only the freeze a
            // previous checkout adoption put on it — never a hand edit. It
            // also hides the revealed fields and forgets the last answer, so
            // the next blur probes the new URL.
            setPathAdopted(false);
            setRevealed(false);
            lastProbe.current = null;
            resetProbe();
          }}
        />
        <datalist id={suggestionsListId}>
          {suggestions.map((checkout) => (
            <option key={checkout.path} value={checkout.url}>
              {checkout.path}
            </option>
          ))}
        </datalist>
        {probe.status === "probing" && (
          <span className="text-muted-foreground block text-xs">Reading the remote…</span>
        )}
        {probe.status === "error" && <span className="text-destructive block text-xs">{probe.message}</span>}
        {probe.status === "done" && <span className="text-muted-foreground block text-xs">{probe.result.message}</span>}
      </label>

      {revealedFields && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground text-xs">Name</span>
              <input
                type="text"
                className="bg-background w-full rounded-md border px-2 py-1 text-sm"
                value={name}
                disabled={submitting}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameEdited(true);
                }}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground text-xs">Machine</span>
              {hosts === null ? (
                <div className="text-muted-foreground py-1 text-xs">Loading machines…</div>
              ) : hosts.length === 0 ? (
                <div className="text-destructive py-1 text-xs">No machine is available to hold the checkout.</div>
              ) : (
                <select
                  className="bg-background w-full rounded-md border px-2 py-1 text-sm"
                  value={hostId ?? ""}
                  disabled={submitting}
                  onChange={(event) => {
                    const next = event.target.value;
                    setHostId(next);
                    runProbe(next);
                  }}
                >
                  {hosts.map((entry) => (
                    <option key={entry.id} value={entry.id} disabled={!entry.connected}>
                      {entry.name}
                      {entry.connected ? "" : " (offline)"}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground text-xs">
              Where the project's <code className="font-mono">.bb</code> checkout lives
              {selectedHost === null ? "" : ` on ${selectedHost.name}`}
            </span>
            <input
              type="text"
              className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs"
              value={path}
              placeholder={name.trim().length === 0 ? "Type a name to get a suggestion" : "Suggesting…"}
              spellCheck={false}
              autoComplete="off"
              disabled={submitting}
              onChange={(event) => {
                setPath(event.target.value);
                setPathEdited(true);
                setPathAdopted(false);
                setPathExists(false);
              }}
            />
            {pathExists && urlOutcome === "checkout" && (
              <span className="text-muted-foreground block text-xs">
                This checkout is used as the project source; nothing is cloned.
              </span>
            )}
            {pathExists && urlOutcome !== "checkout" && urlOutcome !== null && (
              <span className="text-destructive block text-xs">
                Something is already there, and a clone needs an empty directory.
              </span>
            )}
          </label>
        </>
      )}

      {error !== null && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={!ready}
        >
          {submitting ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}
