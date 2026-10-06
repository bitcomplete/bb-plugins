/**
 * The add-a-repo form row, shared by the Repos panel and the new-project form.
 *
 * One component for both because the two jobs are the same job at different
 * moments: the panel commits each entry to an existing `repos.json`, the form
 * accumulates entries for a `repos.json` that will be written when the
 * project is created. The row does not know which — `onAdd` either commits
 * or appends, and reports back a sentence or nothing.
 *
 * Not a `<form>`. The new-project form wraps this row, and a form inside a
 * form is invalid HTML — the browser gives the inner Add button to the outer
 * form, so pressing it created the project without its repos, or navigated
 * the page. The row is a block with its own button and Enter handler instead,
 * which behaves the same on the panel where there is no outer form.
 *
 * The directory preview and the duplicate check run here, before any server
 * call, with the same helpers the server uses. Not because the server's check
 * is optional — it is the boundary — but because "this name is already
 * taken" should appear as the URL is typed, not after a round trip.
 */
import { useId, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DiscoveredCheckout, RepoSeed } from "./contract.js";
import { dirFromUrl, isSafeSegment, normalizeRemoteUrl } from "./names.js";

/** The one fact about an existing entry the duplicate check needs. */
export interface ExistingRepo {
  dir: string;
  url: string;
}

interface AddRepoRowProps {
  /** Local checkouts on the machine, offered as completions for the URL. */
  suggestions: readonly DiscoveredCheckout[];
  existing: readonly ExistingRepo[];
  /** Commit or append; resolve to an error sentence, or null on success. */
  onAdd: (repo: RepoSeed) => Promise<string | null>;
  /** The label on the submit button. */
  action?: string;
  disabled?: boolean;
}

/** The first problem with adding this entry, as the row should show it, or null. */
export function localProblem(
  seed: RepoSeed,
  existing: readonly ExistingRepo[],
): string | null {
  const url = seed.url.trim();
  if (url.length === 0) return null;
  if (url.startsWith("-")) return `A URL may not start with "-".`;
  const dir = seed.dir ?? dirFromUrl(url);
  if (dir === null) return "Could not work out a directory name from that URL. Give it one.";
  if (dir === ".bb") return `".bb" is reserved for the project's own workspace definition.`;
  if (!isSafeSegment(dir)) return `"${dir}" is not a plain directory name.`;
  const dirKey = dir.toLowerCase();
  const urlKey = normalizeRemoteUrl(url);
  for (const repo of existing) {
    if (repo.dir.toLowerCase() === dirKey) return `"${repo.dir}" is already in the repo set.`;
    if (normalizeRemoteUrl(repo.url) === urlKey) return `${repo.dir} is already this repo (${repo.url}).`;
  }
  return null;
}

export function AddRepoRow({ suggestions, existing, onAdd, action = "Add", disabled = false }: AddRepoRowProps) {
  const listId = useId();
  const [url, setUrl] = useState("");
  const [dir, setDir] = useState("");
  const [branch, setBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const seed = useMemo<RepoSeed>(() => {
    const trimmedUrl = url.trim();
    const trimmedDir = dir.trim();
    const trimmedBranch = branch.trim();
    return {
      url: trimmedUrl,
      ...(trimmedDir.length === 0 ? {} : { dir: trimmedDir }),
      ...(trimmedBranch.length === 0 ? {} : { branch: trimmedBranch }),
    };
  }, [url, dir, branch]);

  const inferred = seed.url.length === 0 ? null : dirFromUrl(seed.url);
  const problem = localProblem(seed, existing);
  const error = serverError ?? problem;
  const ready = seed.url.length > 0 && problem === null && !submitting && !disabled;

  // Checkouts whose remote is already in the set are not useful completions.
  const offered = useMemo(() => {
    const taken = new Set(existing.map((repo) => normalizeRemoteUrl(repo.url)));
    const seen = new Set<string>();
    const result: DiscoveredCheckout[] = [];
    for (const checkout of suggestions) {
      const key = normalizeRemoteUrl(checkout.url);
      if (taken.has(key) || seen.has(key)) continue;
      seen.add(key);
      result.push(checkout);
    }
    return result;
  }, [suggestions, existing]);

  const submit = () => {
    if (!ready) return;
    setSubmitting(true);
    setServerError(null);
    void onAdd(seed)
      .then((result) => {
        if (result === null) {
          setUrl("");
          setDir("");
          setBranch("");
        } else {
          setServerError(result);
        }
      })
      .catch((caught: unknown) => {
        setServerError(caught instanceof Error ? caught.message : "Could not add the repo.");
      })
      .finally(() => setSubmitting(false));
  };

  // Enter in any of the three fields adds, and must not reach an enclosing
  // form, where it would read as "create the project".
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    submit();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <input
            type="text"
            list={listId}
            className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs"
            placeholder="git@github.com:you/repo.git, https://…, or /path/to/checkout"
            value={url}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || submitting}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setUrl(event.target.value);
              setServerError(null);
            }}
          />
          <datalist id={listId}>
            {offered.map((checkout) => (
              <option key={checkout.path} value={checkout.url}>
                {checkout.path}
              </option>
            ))}
          </datalist>
        </div>
        <input
          type="text"
          className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs sm:w-40"
          placeholder={inferred ?? "directory"}
          title="Directory name inside each workspace. Defaults to the repo's name."
          value={dir}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled || submitting}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setDir(event.target.value);
            setServerError(null);
          }}
        />
        <input
          type="text"
          className="bg-background w-full rounded-md border px-2 py-1 font-mono text-xs sm:w-32"
          placeholder="default branch"
          title="Base branch. Defaults to the repo's default branch."
          value={branch}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled || submitting}
          onKeyDown={onKeyDown}
          onChange={(event) => setBranch(event.target.value)}
        />
        <button
          type="button"
          className="bg-primary text-primary-foreground shrink-0 rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
          disabled={!ready}
          onClick={submit}
        >
          {submitting ? "Adding…" : action}
        </button>
      </div>
      {error !== null && <p className="text-destructive text-xs">{error}</p>}
      {error === null && offered.length > 0 && url.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {offered.length === 1
            ? "One checkout on this machine is not in the set yet; the URL field will offer it."
            : `${offered.length} checkouts on this machine are not in the set yet; the URL field will offer them.`}
        </p>
      )}
    </div>
  );
}
