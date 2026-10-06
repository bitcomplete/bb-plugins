/**
 * Create a multi-repo project in one step.
 *
 * bb's own New project dialog wants a source directory and knows nothing
 * about this plugin, so setting a project up used to mean creating an empty
 * directory by hand, pointing a project at it, and then coming here to give
 * it repos. This form folds those into one: it picks the `.bb` location,
 * initializes or clones it, and creates the project pointing at it.
 *
 * The location is a suggestion the user can overwrite, not a decision. It is
 * recomputed from the name and machine until the user edits it, and then left
 * alone — an edited path that silently reverts when the name changes is the
 * kind of form nobody trusts twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { DiscoveredCheckout, RepoSeed, rpcContract } from "./contract.js";
import { AddRepoRow } from "./add-repo-row.js";
import { dirFromUrl } from "./names.js";

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

type Mode = "fresh" | "clone";

export function NewProjectForm({ onCancel, onCreated }: NewProjectFormProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<HostOption[] | null>(null);
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [pathExists, setPathExists] = useState(false);
  const [mode, setMode] = useState<Mode>("fresh");
  const [cloneUrl, setCloneUrl] = useState("");
  const [repos, setRepos] = useState<RepoSeed[]>([]);
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

  // The suggested location follows the name and machine until it is edited.
  // Debounced because it is a host round trip per keystroke otherwise, and
  // sequenced so a slow early answer cannot overwrite a fast later one.
  const suggestionSeq = useRef(0);
  useEffect(() => {
    if (pathEdited || hostId === null || name.trim().length === 0) return;
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
  }, [rpc, hostId, name, pathEdited]);

  // Local checkouts on the chosen machine, for the add row's completions.
  // Keyed on the path so the sibling scan looks beside where `.bb` will go.
  useEffect(() => {
    if (hostId === null || path.length === 0 || mode !== "fresh") return;
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
  }, [rpc, hostId, path, mode]);

  const existing = useMemo(
    () => repos.map((repo) => ({ dir: repo.dir ?? dirFromUrl(repo.url) ?? repo.url, url: repo.url })),
    [repos],
  );

  const append = useCallback(async (repo: RepoSeed): Promise<string | null> => {
    setRepos((current) => [...current, repo]);
    return null;
  }, []);

  const ready =
    !submitting &&
    hostId !== null &&
    name.trim().length > 0 &&
    path.trim().length > 0 &&
    (mode === "fresh" || cloneUrl.trim().length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || hostId === null) return;
    setSubmitting(true);
    setError(null);
    void rpc
      .call("createProject", {
        name: name.trim(),
        hostId,
        path: path.trim(),
        source: mode === "fresh" ? { kind: "fresh", repos } : { kind: "clone", url: cloneUrl.trim() },
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

  const selectedHost = hosts?.find((entry) => entry.id === hostId) ?? null;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-md border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">New multi-repo project</h2>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-xs"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground text-xs">Name</span>
          <input
            type="text"
            className="bg-background w-full rounded-md border px-2 py-1 text-sm"
            value={name}
            autoFocus
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
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
              onChange={(event) => setHostId(event.target.value)}
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
            setPathExists(false);
          }}
        />
        {pathExists && mode === "fresh" && (
          <span className="text-muted-foreground block text-xs">
            Something is already there. An existing <code className="font-mono">.bb</code> repo is adopted as it is;
            anything else fails.
          </span>
        )}
        {pathExists && mode === "clone" && (
          <span className="text-destructive block text-xs">Something is already there, and a clone needs an empty directory.</span>
        )}
      </label>

      <fieldset className="space-y-2">
        <legend className="text-muted-foreground text-xs">Start from</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" checked={mode === "fresh"} disabled={submitting} onChange={() => setMode("fresh")} />
            A new repo set
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="mode" checked={mode === "clone"} disabled={submitting} onChange={() => setMode("clone")} />
            An existing <code className="font-mono">.bb</code> repo
          </label>
        </div>
      </fieldset>

      {mode === "clone" ? (
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground text-xs">Clone URL of the .bb repo</span>
          <input
            type="text"
            className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs"
            placeholder="git@github.com:you/project.bb.git"
            value={cloneUrl}
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
            onChange={(event) => setCloneUrl(event.target.value)}
          />
          <span className="text-muted-foreground block text-xs">
            Its repos.json, AGENTS.md and skills come with it. Nothing is written back to it here.
          </span>
        </label>
      ) : (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Repos</h3>
          {repos.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              None yet. A project can start empty: its first thread proposes the checkouts it finds on the machine.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {repos.map((repo, index) => {
                const dir = repo.dir ?? dirFromUrl(repo.url) ?? repo.url;
                return (
                  <li key={`${dir}-${index}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon name="FolderGit" className="text-muted-foreground size-3.5 shrink-0" />
                        <span className="truncate text-sm font-medium">{dir}</span>
                        {repo.branch !== undefined && (
                          <span className="text-muted-foreground shrink-0 font-mono text-xs">{repo.branch}</span>
                        )}
                      </div>
                      <div className="text-muted-foreground truncate font-mono text-xs">{repo.url}</div>
                    </div>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground shrink-0 rounded-md px-2 py-0.5 text-xs"
                      disabled={submitting}
                      onClick={() => setRepos((current) => current.filter((_, at) => at !== index))}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <AddRepoRow suggestions={suggestions} existing={existing} onAdd={append} disabled={submitting} />
        </section>
      )}

      {error !== null && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={!ready}
        >
          {submitting ? (mode === "clone" ? "Cloning…" : "Creating…") : "Create project"}
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Then pick <span className="text-foreground">Multi-repo workspace</span> as the environment when you start a
        thread in it.
      </p>
    </form>
  );
}
