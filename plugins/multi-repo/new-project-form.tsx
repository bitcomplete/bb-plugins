/**
 * Create a multi-repo project in one step.
 *
 * bb's own New project dialog wants a source directory and knows nothing
 * about this plugin, so setting a project up used to mean creating an empty
 * directory by hand, pointing a project at it, and then coming here to give
 * it repos. This form folds those into one: it picks the `.bb` location,
 * initializes or clones it, and creates the project pointing at it.
 *
 * The URL comes first and everything else is derived from it. The name is the
 * URL's last component, the location follows the name, and a probe of the
 * remote's default branch decides the mode the old radio buttons used to ask
 * for: a root `repos.json` is a standalone `.bb` repo, `.bb/repos.json` is a
 * primary repo, neither is a plain repo. Every derived field stays editable —
 * it is recomputed until the user edits it, and then left alone — because an
 * edited field that silently reverts is the kind of form nobody trusts twice.
 *
 * The probe runs on blur or Enter, never per keystroke, and Create does not
 * wait for it: the host re-probes on submit when the answer has not arrived.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { DiscoveredCheckout, ProbeRemoteResult, RepoSeed, rpcContract } from "./contract.js";
import { AddRepoRow } from "./add-repo-row.js";
import { deriveName, locationFrozen } from "./new-project-derive.js";
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

/** URL-first is the default; "from scratch" is the secondary link. */
type FormMode = "url" | "fresh";

type Probe =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "done"; result: ProbeRemoteResult }
  | { status: "error"; message: string };

export function NewProjectForm({ onCancel, onCreated }: NewProjectFormProps) {
  const rpc = useRpc<typeof rpcContract>();
  const suggestionsListId = useId();
  const [hosts, setHosts] = useState<HostOption[] | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [hostId, setHostId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [pathAdopted, setPathAdopted] = useState(false);
  const [pathExists, setPathExists] = useState(false);
  const [probe, setProbe] = useState<Probe>({ status: "idle" });
  const [seedPr, setSeedPr] = useState(false);
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

  // The name follows the URL's last component until the user edits it.
  useEffect(() => {
    if (formMode !== "url") return;
    setName((current) => deriveName(url, current, nameEdited));
  }, [url, nameEdited, formMode]);

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

  // Local checkouts on the chosen machine, for the URL field's completions
  // (and, in "from scratch" mode, for the add row). Keyed on the path so the
  // sibling scan looks beside where `.bb` will go.
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
    if (formMode !== "url" || probe.status !== "done" || probe.result.outcome !== "checkout") return;
    if (locationFrozen(pathEdited, pathAdopted)) return;
    setPath(url.trim());
    setPathExists(true);
    setPathAdopted(true);
  }, [formMode, probe, url, pathEdited, pathAdopted]);

  const probeSeq = useRef(0);
  const runProbe = useCallback(() => {
    const value = url.trim();
    if (formMode !== "url" || hostId === null || value.length === 0) return;
    const seq = ++probeSeq.current;
    setProbe({ status: "probing" });
    void rpc
      .call("probeRemote", { hostId, url: value })
      .then((result) => {
        if (seq === probeSeq.current) setProbe({ status: "done", result });
      })
      .catch((caught: unknown) => {
        if (seq !== probeSeq.current) return;
        setProbe({
          status: "error",
          message: caught instanceof Error ? caught.message : "Could not read that remote.",
        });
      });
  }, [rpc, hostId, url, formMode]);

  // Invalidate any in-flight probe, so a result for the old URL or machine
  // cannot land as the answer for the new one.
  const resetProbe = useCallback(() => {
    probeSeq.current += 1;
    setProbe({ status: "idle" });
  }, []);

  const existing = useMemo(
    () => repos.map((repo) => ({ dir: repo.dir ?? dirFromUrl(repo.url) ?? repo.url, url: repo.url })),
    [repos],
  );

  const append = useCallback(async (repo: RepoSeed): Promise<string | null> => {
    setRepos((current) => [...current, repo]);
    return null;
  }, []);

  const urlOutcome = probe.status === "done" ? probe.result.outcome : null;

  const ready =
    !submitting &&
    hostId !== null &&
    name.trim().length > 0 &&
    path.trim().length > 0 &&
    (formMode === "fresh" || url.trim().length > 0);

  /**
   * What the host is asked to build. A finished probe picks the exact mode; an
   * unfinished or failed one falls back to `auto`, which re-probes on submit,
   * so Create is never blocked on the probe.
   */
  const source = useMemo(() => {
    if (formMode === "fresh") return { kind: "fresh" as const, repos };
    const value = url.trim();
    if (urlOutcome === "standalone") return { kind: "clone" as const, url: value };
    if (urlOutcome === "primary") {
      return { kind: "primary" as const, url: value, repos: [] as RepoSeed[], openPullRequest: false };
    }
    if (urlOutcome === "plain") {
      return { kind: "plain" as const, url: value, repos: [] as RepoSeed[], openPullRequest: seedPr };
    }
    return { kind: "auto" as const, url: value, repos: [] as RepoSeed[], openPullRequest: seedPr };
  }, [formMode, url, urlOutcome, seedPr, repos]);

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
        source,
      })
      .then((result) => {
        if (result.ok && result.projectId !== null) {
          onCreated(result.projectId, [
            ...result.warnings,
            ...(result.prUrl === null ? [] : [`Seed pull request: ${result.prUrl}`]),
          ]);
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
    runProbe();
  };

  const selectedHost = hosts?.find((entry) => entry.id === hostId) ?? null;
  const showSeedCheckbox =
    formMode === "url" && (urlOutcome === null || urlOutcome === "plain" || urlOutcome === "checkout");
  // In URL mode the remote is the whole repo set: a standalone `.bb` carries
  // its own, a primary carries `.bb/`, and a plain repo is a single-repo
  // project. Extra repos are added from the panel once the project exists.
  const showRepos = formMode === "fresh";

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

      {formMode === "url" && (
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
            onBlur={runProbe}
            onChange={(event) => {
              setUrl(event.target.value);
              // A new URL re-derives the location, but only the freeze a
              // previous checkout adoption put on it — never a hand edit.
              setPathAdopted(false);
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
      )}

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
                setHostId(event.target.value);
                resetProbe();
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
        {pathExists && formMode === "fresh" && (
          <span className="text-muted-foreground block text-xs">
            Something is already there. An existing <code className="font-mono">.bb</code> repo is adopted as it is;
            anything else fails.
          </span>
        )}
        {pathExists && formMode === "url" && urlOutcome === "standalone" && (
          <span className="text-destructive block text-xs">Something is already there, and a clone needs an empty directory.</span>
        )}
        {pathExists && formMode === "url" && urlOutcome === "checkout" && (
          <span className="text-muted-foreground block text-xs">This checkout is used as the project source; nothing is cloned.</span>
        )}
        {pathExists &&
          formMode === "url" &&
          urlOutcome !== "standalone" &&
          urlOutcome !== "checkout" &&
          urlOutcome !== null && (
            <span className="text-muted-foreground block text-xs">
              An existing checkout of the repo is fetched and used as it is; `.bb/` is seeded into it when it carries none.
            </span>
          )}
      </label>

      {showSeedCheckbox && (
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={seedPr}
            disabled={submitting}
            onChange={(event) => setSeedPr(event.target.checked)}
          />
          Seed <code className="font-mono">.bb/</code> and open a pull request
        </label>
      )}

      {showRepos && (
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

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline"
          disabled={submitting}
          onClick={() => {
            setFormMode((current) => (current === "url" ? "fresh" : "url"));
            resetProbe();
          }}
        >
          {formMode === "url" ? "A new repo set from scratch" : "Use a git remote instead"}
        </button>
        <button
          type="submit"
          className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={!ready}
        >
          {submitting ? (source.kind === "clone" ? "Cloning…" : "Creating…") : "Create project"}
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Then pick <span className="text-foreground">Multi-repo workspace</span> as the environment when you start a
        thread in it.
      </p>
    </form>
  );
}
