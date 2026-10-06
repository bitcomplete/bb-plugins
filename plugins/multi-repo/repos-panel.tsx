/**
 * The Repos nav panel: the project's repo set, its object cache, and an editor
 * for `repos.json`.
 *
 * **Why it picks its own project.** A nav panel owns a top-level route, beside
 * Plugins and Skills rather than inside a project, so there is no project in
 * the route for `useBbContext()` to return and the page has to offer the
 * choice itself. That is also what lets it reach a project you are not
 * currently working in, which is the case that matters when you are setting a
 * new one up. The choice is remembered in `localStorage` rather than the
 * panel's `subPath`, which the host encodes on the way in and never decodes.
 *
 * **Why a nav panel and not project settings.** There is no project-settings
 * slot among the plugin app slots, so this cannot sit beside bb's own project
 * settings where someone would look for it. A nav panel is the next best
 * thing — bb gives it the whole main area, a route, and a host-owned sidebar
 * item the user can reorder or hide — and the `bb repos` CLI covers the person
 * who looked in the obvious place and did not find it.
 *
 * **Why a list with an escape hatch, not a text editor.** `repos.json` is the
 * single source of truth and it is committed to a git repo the user may also
 * edit by hand or from another machine. The first version of this panel was
 * therefore a textarea, on the theory that a form would lose what the file
 * said. It does not: the serializer already writes entries back the way they
 * were written, with an inferred `dir` left out again, so a structured add,
 * remove or branch change is a one-line commit with a message naming the
 * change — which is better than what the textarea produced. The text stays,
 * behind a disclosure, for the case a form cannot express and for a file
 * that no longer parses, when it is the only thing that can be shown.
 *
 * **Why it can create a project.** bb's own New project dialog wants a source
 * directory and knows nothing about this plugin, so a multi-repo project used
 * to take an empty directory made by hand, a project pointed at it, and a
 * visit here. The form folds the three into one step.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { CacheEntry, DiscoveredCheckout, RepoSeed, RepoSetView, rpcContract } from "./contract.js";
import { AddRepoRow } from "./add-repo-row.js";
import { NewProjectForm } from "./new-project-form.js";
import { REPOS_CHANGED_CHANNEL } from "./shared.js";

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CacheBadge({ entry }: { entry: CacheEntry | undefined }) {
  if (entry === undefined || !entry.present) {
    return <span className="text-muted-foreground text-xs">not cached yet</span>;
  }
  const size = formatSize(entry.sizeBytes);
  return (
    <span className="text-muted-foreground text-xs">
      cached{size === null ? "" : ` · ${size}`}
      {entry.fetchedAt === null ? "" : ` · fetched ${relativeTime(entry.fetchedAt)}`}
    </span>
  );
}

interface ProjectOption {
  id: string;
  name: string;
  hasSource: boolean;
}

/** The project the panel is showing, remembered across visits. */
function useProjectChoice(): {
  projects: ProjectOption[] | null;
  projectId: string | null;
  choose: (id: string) => void;
  reload: () => void;
} {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  // Namespaced by plugin id so a copy published under another package name
  // does not inherit this one's selection.
  const storageKey = `${pluginId}:repos-panel:project`;
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("projects", null)
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setProjectId((current) => {
          if (current !== null && result.projects.some((entry) => entry.id === current)) return current;
          let remembered: string | null = null;
          try {
            remembered = window.localStorage.getItem(storageKey);
          } catch {
            // Private browsing, or storage disabled. Fall through to the first
            // project rather than losing the page.
          }
          if (remembered !== null && result.projects.some((entry) => entry.id === remembered)) {
            return remembered;
          }
          return result.projects[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, storageKey, generation]);

  const choose = useCallback(
    (id: string) => {
      setProjectId(id);
      try {
        window.localStorage.setItem(storageKey, id);
      } catch {
        // Not remembering the choice is survivable; failing the click is not.
      }
    },
    [storageKey],
  );

  return { projects, projectId, choose, reload };
}

/** One repo in the set: name, remote, cache state, an editable base branch, and removal. */
function RepoRow({
  repo,
  cache,
  busy,
  onSetBranch,
  onRemove,
}: {
  repo: { dir: string; url: string; branch: string | null };
  cache: CacheEntry | undefined;
  busy: boolean;
  onSetBranch: (branch: string | null) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
}) {
  const [branch, setBranch] = useState(repo.branch ?? "");
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the field in step with the file when another surface changes it.
  useEffect(() => {
    setBranch(repo.branch ?? "");
  }, [repo.branch]);

  const commitBranch = () => {
    const next = branch.trim().length === 0 ? null : branch.trim();
    if (next === repo.branch) return;
    setWorking(true);
    setError(null);
    void onSetBranch(next)
      .then((result) => {
        if (result !== null) setError(result);
      })
      .finally(() => setWorking(false));
  };

  const remove = () => {
    setWorking(true);
    setError(null);
    void onRemove()
      .then((result) => {
        if (result !== null) {
          setError(result);
          setConfirming(false);
        }
      })
      .finally(() => setWorking(false));
  };

  const disabled = busy || working;
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon name="FolderGit" className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate font-medium">{repo.dir}</span>
            <CacheBadge entry={cache} />
          </div>
          <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{repo.url}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="text"
            className="bg-background w-32 rounded-md border px-2 py-0.5 font-mono text-xs"
            placeholder="default branch"
            title="Base branch. Empty means the repo's default branch. Press Enter or leave the field to save."
            value={branch}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => setBranch(event.target.value)}
            onBlur={commitBranch}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitBranch();
              } else if (event.key === "Escape") {
                setBranch(repo.branch ?? "");
              }
            }}
          />
          {confirming ? (
            <>
              <button
                type="button"
                className="bg-destructive text-destructive-foreground rounded-md px-2 py-0.5 text-xs disabled:opacity-50"
                disabled={disabled}
                onClick={remove}
              >
                {working ? "Removing…" : `Remove ${repo.dir}`}
              </button>
              <button
                type="button"
                className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
                disabled={disabled}
                onClick={() => setConfirming(false)}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground rounded-md px-2 py-0.5 text-xs disabled:opacity-50"
              disabled={disabled}
              onClick={() => setConfirming(true)}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {error !== null && <p className="text-destructive text-xs">{error}</p>}
    </li>
  );
}

export function ReposPanel() {
  const { projects, projectId, choose, reload } = useProjectChoice();
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<RepoSetView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<DiscoveredCheckout[]>([]);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (projectId === null) {
      setView(null);
      return;
    }
    void rpc
      .call("repoSet", { projectId })
      .then((next) => {
        setView(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load the repo set."));
  }, [rpc, projectId]);

  useEffect(load, [load]);
  useRealtime(REPOS_CHANGED_CHANNEL, load);

  // A file that does not parse has nothing to show but its text.
  useEffect(() => {
    if (view?.error !== null && view?.error !== undefined) setJsonOpen(true);
  }, [view?.error]);

  const hostId = view?.hostId ?? null;
  const sourcePath = view?.projectSourcePath ?? null;
  useEffect(() => {
    if (hostId === null || sourcePath === null) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    void rpc
      .call("suggestRepos", { hostId, path: sourcePath })
      .then((result) => {
        if (!cancelled) setSuggestions(result.checkouts);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, hostId, sourcePath]);

  const cacheByUrl = useMemo(
    () => new Map((view?.cache ?? []).map((entry) => [entry.url, entry])),
    [view?.cache],
  );

  const addRepo = useCallback(
    async (repo: RepoSeed): Promise<string | null> => {
      if (projectId === null) return "No project selected.";
      const result = await rpc.call("addRepo", { projectId, repo });
      if (result.ok) load();
      return result.ok ? null : result.error;
    },
    [rpc, projectId, load],
  );

  const removeRepo = useCallback(
    async (dir: string): Promise<string | null> => {
      if (projectId === null) return "No project selected.";
      const result = await rpc.call("removeRepo", { projectId, dir });
      if (result.ok) load();
      return result.ok ? null : result.error;
    },
    [rpc, projectId, load],
  );

  const setBranch = useCallback(
    async (dir: string, branch: string | null): Promise<string | null> => {
      if (projectId === null) return "No project selected.";
      const result = await rpc.call("setRepoBranch", { projectId, dir, branch });
      if (result.ok) load();
      return result.ok ? null : result.error;
    },
    [rpc, projectId, load],
  );

  const editing = draft !== null;
  const save = useCallback(() => {
    if (projectId === null || draft === null) return;
    setSaving(true);
    setSaveError(null);
    void rpc
      .call("saveRepoSet", { projectId, reposJson: draft })
      .then((result) => {
        if (result.ok) {
          setDraft(null);
          load();
        } else {
          setSaveError(result.error);
        }
      })
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "Could not save."))
      .finally(() => setSaving(false));
  }, [rpc, projectId, draft, load]);

  if (projects === null) {
    return (
      <div className="p-4 md:p-5">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  const form = (
    <NewProjectForm
      onCancel={() => setCreating(false)}
      onCreated={(id, warnings) => {
        setCreating(false);
        setNotice(warnings.length === 0 ? null : [...warnings]);
        reload();
        choose(id);
      }}
    />
  );

  if (projects.length === 0) {
    return (
      <div className="h-full overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {creating ? (
            form
          ) : (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm">There are no projects yet.</p>
              <button
                type="button"
                className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs"
                onClick={() => setCreating(true)}
              >
                New multi-repo project
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const existing = view?.repos.map((repo) => ({ dir: repo.dir, url: repo.url })) ?? [];

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <label htmlFor="multi-repo-project" className="text-muted-foreground text-sm">
            Project
          </label>
          <select
            id="multi-repo-project"
            className="bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
            value={projectId ?? ""}
            disabled={creating}
            onChange={(event) => choose(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.hasSource ? "" : " (no checkout)"}
              </option>
            ))}
          </select>
          {!creating && (
            <button
              type="button"
              className="hover:bg-muted shrink-0 rounded-md border px-2.5 py-1 text-xs"
              onClick={() => {
                setNotice(null);
                setCreating(true);
              }}
            >
              New project
            </button>
          )}
        </div>

        {creating && form}

        {!creating && notice !== null && (
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
            <div className="font-medium">Created, with notes:</div>
            <ul className="mt-1 list-disc pl-4">
              {notice.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {!creating && loadError !== null && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {loadError}
          </div>
        )}

        {!creating && view !== null && view.projectSourcePath === null && (
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
            This project has no checkout on any machine, so it has no repo set yet.
          </div>
        )}

        {!creating && view !== null && view.error !== null && (
          <div className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
            <div className="text-destructive font-medium">repos.json is invalid</div>
            <div className="text-destructive/90 mt-1 font-mono text-xs">{view.error}</div>
            <div className="text-muted-foreground mt-2 text-xs">
              Every thread created in this project will fail to start until this parses. Fix it below.
            </div>
          </div>
        )}

        {!creating && view !== null && view.projectSourcePath !== null && (
          <>
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium">Repos</h2>
                <span className="text-muted-foreground truncate font-mono text-xs">{view.projectSourcePath}</span>
              </div>

              {view.error === null && view.repos.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No repos yet. A thread started with an empty set proposes the repos it finds on the machine; add
                  them here to decide for yourself.
                </p>
              )}
              {view.repos.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {view.repos.map((repo) => (
                    <RepoRow
                      key={repo.dir}
                      repo={repo}
                      cache={cacheByUrl.get(repo.url)}
                      busy={editing || saving}
                      onSetBranch={(branch) => setBranch(repo.dir, branch)}
                      onRemove={() => removeRepo(repo.dir)}
                    />
                  ))}
                </ul>
              )}
              {view.error === null && (
                <AddRepoRow suggestions={suggestions} existing={existing} onAdd={addRepo} disabled={editing || saving} />
              )}
              <p className="text-muted-foreground text-xs">
                Each change is committed to the project's <code className="font-mono">.bb</code> repo. Existing
                workspaces keep the repos they were created with; changes apply to new threads.
              </p>
            </section>

            <details
              className="space-y-2"
              open={jsonOpen}
              onToggle={(event) => setJsonOpen((event.target as HTMLDetailsElement).open)}
            >
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                Edit repos.json as text
              </summary>
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-end gap-2">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-xs"
                        onClick={() => {
                          setDraft(null);
                          setSaveError(null);
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
                        onClick={save}
                        disabled={saving}
                      >
                        {saving ? "Committing…" : "Commit"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs"
                      onClick={() => setDraft(view.reposJson ?? '{\n  "version": 1,\n  "repos": []\n}\n')}
                    >
                      Edit
                    </button>
                  )}
                </div>

                {saveError !== null && (
                  <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 font-mono text-xs">
                    {saveError}
                  </div>
                )}

                <textarea
                  className="bg-muted/30 h-72 w-full resize-y rounded-md border p-3 font-mono text-xs"
                  spellCheck={false}
                  readOnly={!editing}
                  value={editing ? draft : (view.reposJson ?? "")}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
