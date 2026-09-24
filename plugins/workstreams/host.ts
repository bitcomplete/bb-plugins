// Per-machine scanning. Runs in the BB host worker, so node:child_process and
// node:fs are available here and only here.
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type GroupNaming, type RawUnit } from "./contract.js";
import {
  checkConclusions,
  parseAheadBehind,
  parsePrList,
  repoFromRemote,
} from "./gh.js";
import { prTarget, readLiveMerge, runMerge, runNudge, runUpdateBranch, type GhRunner } from "./ghactions.js";

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 20_000;
const GH_WRITE_TIMEOUT_MS = 60_000;
const CONCURRENCY = 8;
const MAX_WARNINGS = 50;

type Run = { ok: true; stdout: string } | { ok: false; error: string };

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).replace(/\s+/gu, " ").trim().slice(0, 200);
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true, stdout: stdout.toString() });
      },
    );
  });
}

/**
 * `gh` with an optional stdin, for the Board's direct actions. Arguments are an
 * array handed straight to execFile: no shell ever parses them.
 */
function ghRunner(signal: AbortSignal): GhRunner {
  return (args, stdin) =>
    new Promise((resolve) => {
      const child = execFile(
        "gh",
        [...args],
        { cwd: homedir(), timeout: GH_WRITE_TIMEOUT_MS, signal, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, error: (stderr || error.message).replace(/\s+/gu, " ").trim().slice(0, 600) });
            return;
          }
          resolve({ ok: true, stdout: stdout.toString() });
        },
      );
      child.stdin?.end(stdin ?? "");
    });
}

async function git(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await run("git", args, cwd, GIT_TIMEOUT_MS, signal);
  return result.ok ? result.stdout.trim() : null;
}

async function isUnit(path: string): Promise<boolean> {
  // `.git` is a directory in a normal clone and a file in a worktree.
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}







/**
 * Whether a PR is stacked depends on the repo's default branch, and a scan
 * holds many checkouts of the same repo. Resolving it once per repo rather than
 * once per checkout is the difference between one `gh` call and twenty.
 */
function defaultBranchResolver(signal: AbortSignal) {
  const cache = new Map<string, Promise<string | null>>();
  return (repo: string | null, path: string): Promise<string | null> => {
    if (repo === null) return Promise.resolve(null);
    const cached = cache.get(repo);
    if (cached !== undefined) return cached;
    const pending = run(
      "gh",
      ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      path,
      GH_TIMEOUT_MS,
      signal,
    ).then((result) => {
      const name = result.ok ? result.stdout.trim() : "";
      return name === "" ? null : name.slice(0, 300);
    });
    cache.set(repo, pending);
    return pending;
  };
}

const PR_FIELDS =
  "number,state,isDraft,reviewDecision,latestReviews,statusCheckRollup,url,title,mergeable,mergeStateStatus,baseRefName,headRefName,mergeCommit,mergedAt,reviewRequests";

/** A release tag: many teams deploy production from a version tag and nothing else. */
const RELEASE_TAG = /^v?\d+(\.\d+){0,3}$/u;

/** Cap the file list per checkout. The RPC result is limited to 8 MiB. */
const MAX_CHANGED_PATHS = 500;

/**
 * Whether a merged commit reached production, from LOCAL TAGS ONLY.
 *
 * Repos that tag their releases already carry them, so this costs one cheap
 * ancestry check per merged checkout and one tag listing per repo — against a
 * GitHub deployments API call per unit, which is a network round trip for a
 * fact already on disk. Missing tags, an unfetched merge commit or any git
 * failure all resolve to `null`, which `unitLifecycle` reads as "merged", never
 * as "shipped": a scan must never block on this, and an unknown must never
 * invent a deploy.
 */
function shippedResolver(warn: (message: string) => void, signal: AbortSignal) {
  const latestTag = new Map<string, Promise<string | null>>();
  const warned = new Set<string>();
  return async (
    repo: string | null,
    path: string,
    mergeCommit: string | null,
  ): Promise<boolean | null> => {
    if (mergeCommit === null) return null;
    const key = repo ?? path;
    let pending = latestTag.get(key);
    if (pending === undefined) {
      pending = git(["tag", "--list", "--sort=-creatordate"], path, signal).then((output) => {
        const tag = (output ?? "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => RELEASE_TAG.test(line));
        return tag ?? null;
      });
      latestTag.set(key, pending);
    }
    const tag = await pending;
    if (tag === null) {
      if (!warned.has(key)) {
        warned.add(key);
        warn(`${key}: no release tags found; merged work cannot be reported as shipped.`);
      }
      return null;
    }
    const contained = await run(
      "git",
      ["merge-base", "--is-ancestor", mergeCommit, tag],
      path,
      GIT_TIMEOUT_MS,
      signal,
    );
    // Exit 1 is the real answer "not an ancestor"; anything else is a failure
    // we cannot tell apart from it here, so both read as not-shipped rather
    // than as unknown. An unknown would be indistinguishable on the board.
    return contained.ok;
  };
}

/**
 * What a branch changes against its merge base with the default branch.
 * Local git, never `gh`: the paths are already on disk, and a network call per
 * checkout would be the most expensive thing in a scan of hundreds of checkouts.
 */
async function changedPathsOf(
  path: string,
  defaultBranch: string | null,
  signal: AbortSignal,
): Promise<string[]> {
  if (defaultBranch === null) return [];
  const base = await git(["merge-base", "HEAD", defaultBranch], path, signal);
  if (base === null || base === "") return [];
  const diff = await git(["diff", "--name-only", `${base}..HEAD`], path, signal);
  if (diff === null) return [];
  return diff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, MAX_CHANGED_PATHS)
    .map((line) => line.slice(0, 300));
}

async function inspect(
  path: string,
  ghUsable: boolean,
  defaultBranchOf: (repo: string | null, path: string) => Promise<string | null>,
  shippedOf: (
    repo: string | null,
    path: string,
    mergeCommit: string | null,
  ) => Promise<boolean | null>,
  warn: (message: string) => void,
  signal: AbortSignal,
): Promise<RawUnit> {
  const dirName = path.split("/").filter(Boolean).pop() ?? path;
  const [remote, branch, status, upstream, lastCommitAt] = await Promise.all([
    git(["remote", "get-url", "origin"], path, signal),
    git(["rev-parse", "--abbrev-ref", "HEAD"], path, signal),
    git(["status", "--porcelain"], path, signal),
    git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], path, signal),
    git(["log", "-1", "--format=%cI"], path, signal),
  ]);
  const counts = upstream === null ? null : parseAheadBehind(upstream);
  const unit: RawUnit = {
    path,
    dirName,
    repo: remote === null ? null : repoFromRemote(remote),
    branch: branch === null || branch === "" ? null : branch,
    dirty: status !== null && status !== "",
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
    lastCommitAt: lastCommitAt === null || lastCommitAt === "" ? null : lastCommitAt,
    defaultBranch: null,
    pr: null,
    shipped: null,
    changedPaths: [],
  };
  if (!ghUsable || unit.branch === null) return unit;
  unit.defaultBranch = await defaultBranchOf(unit.repo, path);
  // The default branch is memoized per repo for stack detection already, so
  // this adds one merge-base and one diff per checkout and no network at all.
  unit.changedPaths = await changedPathsOf(path, unit.defaultBranch, signal);
  const listed = await run(
    "gh",
    // `gh pr view` has no --head flag; `gh pr list --head` is the branch lookup,
    // and it returns [] rather than failing when the branch has no PR.
    ["pr", "list", "--head", unit.branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS],
    path,
    GH_TIMEOUT_MS,
    signal,
  );
  if (!listed.ok) {
    warn(`${dirName}: gh pr list failed: ${listed.error}`);
    return unit;
  }
  const parsed = parsePrList(listed.stdout);
  if (parsed === null) return unit;
  unit.pr = parsed.pr;
  if (parsed.pr.state === "MERGED") {
    unit.shipped = await shippedOf(unit.repo, path, parsed.mergeCommit);
  }
  return unit;
}

/** Run `worker` over `items` with at most `CONCURRENCY` in flight. */
async function mapBounded<In, Out>(
  items: In[],
  worker: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(CONCURRENCY, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index] as In);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}


// ---- group naming (Claude) ------------------------------------------------
//
// Claude's only job in this plugin: turn a set of related children into a
// written category name, and say — in the same breath and the same call —
// whether the set looked like one thing at all. Every count, every sort and
// every rollup sentence is produced by code in workstreams.ts, and every other
// word on the board is one the user wrote in a PR title.
//
// Claude may NOT change membership. Jev keeps deciding; this call names and
// flags. The whole value of the flag is that it can disagree with the grouping
// out loud rather than silently repairing it, because a fluent name over a bad
// grouping is harder to catch than an awkward one.

const NAMING_MODEL = "claude-opus-5";
const NAMING_MAX_TOKENS = 16_000;

type Level = "domain" | "program" | "effort";

const LEVEL_BRIEF: Record<Level, string> = {
  effort:
    "An EFFORT is a set of related tickets, each already summarized by the title of its pull request. Write the category name the member tickets share, in 3 to 8 words.",
  program:
    "A PROGRAM is a set of related efforts. Write the name of the DOMAIN they belong to — one level broader than any single effort — in 2 to 6 words.",
  domain:
    "A DOMAIN is a set of related programs. Write the broadest honest name for the area of the product they all sit in, in 1 to 4 words.",
};

/**
 * Stable per level, and therefore cacheable: it mentions no member, no count
 * and no timestamp. The volatile payload goes in the user turn after it, so the
 * cached prefix survives every refresh.
 */
function namingSystem(level: Level): string {
  return [
    "You name and audit engineering groupings.",
    LEVEL_BRIEF[level],
    "Rules for every name:",
    "- Sentence case. No trailing period. No ticket keys, no repository names.",
    "- Name the shared subject at one level above the members, not one member's title.",
    '- Concrete. "Faster search for long-tail titles", never "Platform work" or "Various improvements".',
    "- You may be given candidate phrases. Treat each as one option among the members' own words, never as the answer.",
    "Also judge each grouping:",
    '- "cohesive" when the members plausibly belong together.',
    '- "mixed" when they do not, with one short line naming which members look unrelated.',
    "Do NOT change, add or remove members. Name and judge only; the grouping is not yours to fix.",
    "Return one entry for every label you were given, using the label verbatim as the key.",
  ].join("\n");
}

const NAMING_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          name: { type: "string" },
          cohesion: { type: "string", enum: ["cohesive", "mixed"] },
          reason: { type: ["string", "null"] },
        },
        required: ["label", "name", "cohesion", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
} as const;

export type NamedGroupRow = {
  label: string;
  name: string;
  cohesion: "cohesive" | "mixed";
  reason: string | null;
};

export function parseNames(text: string): NamedGroupRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.label !== "string" || typeof record.name !== "string") return [];
    return [
      {
        label: record.label,
        name: record.name,
        // Anything but an explicit "mixed" is treated as cohesive: a marker
        // that fires on a parse slip would train the reader to ignore it.
        cohesion: record.cohesion === "mixed" ? ("mixed" as const) : ("cohesive" as const),
        reason: typeof record.reason === "string" && record.reason.trim() !== ""
          ? record.reason.trim().slice(0, 300)
          : null,
      },
    ];
  });
}

type NamingResult = {
  names: NamedGroupRow[];
  warnings: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

async function nameGroups(
  apiKey: string,
  level: Level,
  groups: GroupNaming[],
  signal: AbortSignal,
): Promise<NamingResult> {
  const empty: NamingResult = {
    names: [],
    warnings: [],
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  if (groups.length === 0) return empty;

  const client = new Anthropic({ apiKey });
  try {
    // One call for every changed group at this level. One call per group would
    // multiply cost by the size of the board for no extra signal.
    const response = await client.messages.create(
      {
        model: NAMING_MODEL,
        max_tokens: NAMING_MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: NAMING_SCHEMA },
        },
        system: [
          {
            type: "text",
            text: namingSystem(level),
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: JSON.stringify({ groups }) }],
      },
      { signal },
    );
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    return {
      names: parseNames(text),
      warnings:
        response.stop_reason === "refusal"
          ? [`Claude declined to name ${level}s; they keep their selected names.`]
          : [],
      calls: 1,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (error) {
    // Most specific first. The board still renders without these names, so a
    // naming failure is a warning, never a scan failure.
    if (error instanceof Anthropic.AuthenticationError) {
      return { ...empty, calls: 1, warnings: [`Anthropic rejected the API key; ${level}s keep their selected names.`] };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ...empty, calls: 1, warnings: [`Anthropic rate limit reached; ${level}s keep their selected names.`] };
    }
    if (error instanceof Anthropic.APIError) {
      return { ...empty, calls: 1, warnings: [`Anthropic returned ${error.status}; ${level}s keep their selected names.`] };
    }
    return { ...empty, calls: 1, warnings: [`Group naming failed: ${String(error).slice(0, 200)}`] };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: async ({ roots }, context) => {
      const { signal } = context;
      const warnings: string[] = [];
      const warn = (message: string) => {
        if (warnings.length < MAX_WARNINGS) warnings.push(message.slice(0, 500));
      };

      // One auth probe per scan: an expired token would otherwise produce one
      // identical warning per checkout.
      const auth = await run("gh", ["auth", "status"], ".", GH_TIMEOUT_MS, signal);
      const ghUsable = auth.ok;
      if (!ghUsable) {
        warn(
          "gh is not authenticated; run `gh auth refresh -h github.com`. Showing local git state only.",
        );
      }

      const defaultBranchOf = defaultBranchResolver(signal);
      const shippedOf = shippedResolver(warn, signal);
      const candidates = new Set<string>();
      for (const root of roots) {
        if (await isUnit(root)) candidates.add(root);
        let children: string[];
        try {
          children = await readdir(root);
        } catch (error) {
          warn(`${root}: unreadable (${String(error).slice(0, 120)})`);
          continue;
        }
        for (const child of children) {
          const path = join(root, child);
          if (await isUnit(path)) candidates.add(path);
        }
      }

      const units = await mapBounded([...candidates], async (path) => {
        try {
          return await inspect(path, ghUsable, defaultBranchOf, shippedOf, warn, signal);
        } catch (error) {
          // One bad checkout must never fail the whole scan.
          warn(`${path}: ${String(error).slice(0, 200)}`);
          return null;
        }
      });

      return {
        units: units.filter((unit): unit is RawUnit => unit !== null).slice(0, 2_000),
        warnings,
      };
    },
    prLive: async ({ prUrl }, context) => {
      const target = prTarget(prUrl);
      if (target === null) return { ok: false as const, error: "That is not a pull request URL." };
      return readLiveMerge(ghRunner(context.signal), target);
    },
    prWrite: async (request, context) => {
      const target = prTarget(request.prUrl);
      if (target === null) return { ok: false as const, error: "That is not a pull request URL." };
      const gh = ghRunner(context.signal);
      switch (request.kind) {
        case "merge":
          return runMerge(gh, target, request.method, request.sha, request.deleteBranch);
        case "update-branch":
          return runUpdateBranch(gh, target);
        case "nudge":
          return runNudge(gh, target, request.reviewers, request.comment);
      }
    },
    nameGroups: async ({ apiKey, level, groups }, context) =>
      nameGroups(apiKey, level, groups, context.signal),
  },
});
