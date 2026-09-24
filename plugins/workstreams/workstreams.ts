// Pure board logic: no I/O, no SDK. Everything here is unit-tested in
// workstreams.test.ts, because these rules are the whole point of the plugin.
import type { MergeStateStatus, RawUnit } from "./contract.js";
import { ticketFinder, type TicketSource } from "./tickets.js";

/**
 * The lifecycle taxonomy, written in PRECEDENCE order: when several states
 * could apply to one checkout, the earlier one wins. The order is deliberately
 * NOT a display order. It must never reach a SPATIAL position — on the Map,
 * status is a lens the renderer paints and position belongs to the grouping
 * hierarchy. The Board's inbox is the one list that sorts by next action (see
 * `inboxSection`), and it uses its own section order, not this one.
 *
 * `closed` is the eleventh state and the only one the user did not name: it is
 * abandoned work, kept so a closed PR still renders under Done, and excluded
 * from the attention rail by `ACTIONABLE` rather than by being dropped.
 */
export const LIFECYCLES = [
  "blocked",
  "awaiting-followup",
  "approved-with-comments",
  "awaiting-merge",
  "awaiting-review",
  "active",
  "in-progress",
  "up-next",
  "shipped",
  "merged",
  "closed",
] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/**
 * The three groups. They are exactly the lenses the UI offers, so a state can
 * never be filterable in one place and invisible in another.
 */
export const LIFECYCLE_GROUPS = {
  active: ["active", "in-progress", "up-next"],
  waiting: [
    "blocked",
    "awaiting-followup",
    "approved-with-comments",
    "awaiting-merge",
    "awaiting-review",
  ],
  done: ["shipped", "merged", "closed"],
} as const satisfies Record<string, readonly Lifecycle[]>;

export type LifecycleGroup = keyof typeof LIFECYCLE_GROUPS;

const GROUP_OF = new Map<Lifecycle, LifecycleGroup>(
  (Object.entries(LIFECYCLE_GROUPS) as [LifecycleGroup, readonly Lifecycle[]][]).flatMap(
    ([group, members]) => members.map((member) => [member, group] as const),
  ),
);

export function lifecycleGroup(lifecycle: Lifecycle): LifecycleGroup {
  return GROUP_OF.get(lifecycle) ?? "done";
}

const LIFECYCLE_SET = new Set<string>(LIFECYCLES);

/**
 * Coerce anything that crossed a persistence or RPC boundary back into the
 * enum. A value cached by an older build must degrade to a renderable state
 * rather than crash a load, so the old seven-state names map forward and
 * anything unrecognized lands on the most conservative state there is.
 */
const LEGACY_LIFECYCLES: Record<string, Lifecycle> = {
  ready: "awaiting-merge",
  review: "awaiting-review",
  drafting: "in-progress",
  local: "up-next",
};

export function toLifecycle(value: unknown): Lifecycle {
  if (typeof value !== "string") return "up-next";
  if (LIFECYCLE_SET.has(value)) return value as Lifecycle;
  return LEGACY_LIFECYCLES[value] ?? "up-next";
}

/**
 * Most-urgent first. A cluster takes the lifecycle of its most urgent unit, so
 * a ticket with one blocked PR reads as blocked even when its other checkouts
 * already merged. This ranks; it never positions.
 */
const URGENCY = new Map(LIFECYCLES.map((value, index) => [value, index]));

/**
 * Where a checkout sits in a stack of pull requests. A stack is a REPO-level
 * structure: it is defined by base/head branches, so it neither respects nor
 * needs ticket boundaries, and a chain may span two clusters.
 */
export type StackInfo = {
  /** Stable chain id: the repo plus the pull request at its root. */
  id: string;
  /** 1-based, counted from the bottom of the stack upward. */
  position: number;
  size: number;
  /**
   * The nearest pull request below this one that has not merged yet. Merge
   * order is the real constraint in a stack: an approved, green PR sitting on
   * an unmerged one is not actionable, however green it looks.
   */
  blockedBelow: number | null;
};

export type Unit = RawUnit & {
  ticket: string | null;
  /** Where the ticket was found, so a wrong match is debuggable; null with no ticket. */
  ticketSource: TicketSource | null;
  lifecycle: Lifecycle;
  /** Null when the checkout is not part of a stack of more than one PR. */
  stack: StackInfo | null;
  /** Independent of lifecycle, by design: a PR can be in review AND dead. */
  staleness: Staleness;
  surfaces: string[];
  risk: Risk;
};
/**
 * What Linear says about a cluster's ticket, when a key or the agent fallback
 * found it. Context and a seeding signal; never the decider.
 */
export type ClusterLinear = {
  title: string | null;
  state: string | null;
  project: string | null;
  parentIdentifier: string | null;
  parentTitle: string | null;
  url: string | null;
};

export type Cluster = {
  ticket: string;
  /** Absent or null when no Linear detail is known: the board then behaves exactly as without Linear. */
  linear?: ClusterLinear | null;
  lifecycle: Lifecycle;
  units: Unit[];
  staleness: Staleness;
  /** The union of its units' surfaces, in rule-table order. */
  surfaces: string[];
  risk: Risk;
};
export type Workstream = { name: string; clusters: Cluster[] };

export const UNSORTED = "Unsorted";

/**
 * Find the ticket key on the branch name, falling back to the directory name.
 * Branch wins because a checkout is often reused under a stale directory name.
 * A board resolves tickets with `ticketFinder`, which also reads the PR; this
 * is its branch-and-directory subset.
 */
export function parseTicket(
  pattern: RegExp,
  branch: string | null,
  dirName: string,
): string | null {
  return ticketFinder(pattern, [])({ branch, dirName, pr: null })?.ticket ?? null;
}


// ---- stacks ---------------------------------------------------------------

/**
 * Link units into stacks: B sits on top of A when B's base branch is A's head
 * branch. Runs over every unit before clustering, because a stack is a repo
 * structure and two PRs in one stack can belong to different tickets.
 *
 * Mutates `unit.stack` in place and reports the one case that cannot be
 * modelled — a cycle of bases, which git allows and which would otherwise loop
 * forever here.
 */
export function linkStacks(units: Unit[], warn: (message: string) => void): void {
  const byRepo = new Map<string, Unit[]>();
  for (const unit of units) {
    if (unit.pr === null) continue;
    // A closed PR is not part of anyone's merge order any more.
    if (unit.pr.state === "CLOSED") continue;
    const repo = unit.repo ?? unit.dirName;
    const bucket = byRepo.get(repo);
    if (bucket === undefined) byRepo.set(repo, [unit]);
    else bucket.push(unit);
  }

  for (const [repo, members] of byRepo) {
    const byHead = new Map<string, Unit>();
    for (const unit of members) {
      const head = unit.pr?.headRefName ?? unit.branch;
      if (head !== null && head !== undefined && !byHead.has(head)) byHead.set(head, unit);
    }

    const parent = new Map<Unit, Unit>();
    for (const unit of members) {
      const base = unit.pr?.baseRefName ?? null;
      // A PR based on the default branch is a stack root. So is one whose base
      // has no PR here at all — the chain simply starts where we can see it.
      if (base === null || base === unit.defaultBranch) continue;
      const below = byHead.get(base);
      if (below === undefined || below === unit) continue;
      parent.set(unit, below);
    }

    // Sever cycles before walking anything, so no traversal can loop.
    for (const unit of members) {
      const seen = new Set<Unit>([unit]);
      let node = parent.get(unit);
      while (node !== undefined) {
        if (seen.has(node)) {
          warn(`${repo}: pull request bases form a cycle; stack order is unavailable.`);
          parent.delete(unit);
          break;
        }
        seen.add(node);
        node = parent.get(node);
      }
    }

    const children = new Map<Unit, Unit[]>();
    for (const [child, below] of parent) {
      const bucket = children.get(below);
      if (bucket === undefined) children.set(below, [child]);
      else bucket.push(child);
    }
    for (const bucket of children.values()) {
      bucket.sort((a, b) => (a.pr?.number ?? 0) - (b.pr?.number ?? 0));
    }

    // Roots first, then anything a branch in the stack left unvisited. A
    // branched stack reports its main line as one chain and each side branch as
    // its own; nothing is ever counted into two chains.
    const ordered = [...members].sort((a, b) => (a.pr?.number ?? 0) - (b.pr?.number ?? 0));
    const visited = new Set<Unit>();
    for (const start of [...ordered.filter((unit) => !parent.has(unit)), ...ordered]) {
      if (visited.has(start)) continue;
      const chain: Unit[] = [];
      let node: Unit | undefined = start;
      while (node !== undefined && !visited.has(node)) {
        visited.add(node);
        chain.push(node);
        node = children.get(node)?.find((child) => !visited.has(child));
      }
      // One PR on the default branch is not a stack, and stack chrome around it
      // would be noise.
      if (chain.length < 2) continue;
      const id = `${repo}#${chain[0]?.pr?.number ?? 0}`;
      chain.forEach((unit, index) => {
        const below = chain
          .slice(0, index)
          .reverse()
          .find((other) => other.pr !== null && other.pr.state !== "MERGED");
        unit.stack = {
          id,
          position: index + 1,
          size: chain.length,
          blockedBelow: below?.pr?.number ?? null,
        };
      });
    }
  }
}

const FAILING_CHECKS = new Set(["FAILURE", "ERROR"]);
/**
 * Green means finished and passing. A rollup that is still PENDING or
 * IN_PROGRESS is not green, so an approved PR whose CI has not finished is
 * still waiting on something and is not reported as ready to merge. A rollup
 * with no entries at all is green: plenty of repos run no checks, and calling
 * those permanently un-mergeable would be a lie.
 */
const GREEN_CHECKS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function checksGreen(conclusions: readonly string[]): boolean {
  return conclusions.every((value) => GREEN_CHECKS.has(value));
}

/**
 * Where one checkout sits in the merge pipeline, resolved in the precedence
 * order `LIFECYCLES` is written in.
 *
 * The distinctions that earn their place here are the ones that need DIFFERENT
 * actions from the user: `blocked` needs CI to go green, `awaiting-followup`
 * needs the user's own edit, `approved-with-comments` needs the user to read
 * and resolve, and `awaiting-merge` needs one button. Collapsing any pair of
 * those into one state loses the only thing the board is for.
 */
export function unitLifecycle(unit: RawUnit): Lifecycle {
  const { pr } = unit;
  if (pr === null) {
    // No PR at all: the three ACTIVE states are the whole vocabulary here.
    if (unit.dirty) return "active";
    return (unit.ahead ?? 0) > 0 ? "in-progress" : "up-next";
  }
  if (pr.state === "MERGED") {
    // `shipped` is a local-tag fact the host resolved. Unknown (null) means the
    // check could not run, and an unknown must never invent a deploy.
    return unit.shipped === true ? "shipped" : "merged";
  }
  if (pr.state === "CLOSED") return "closed";
  // A draft is still open, so the WAITING rules below would otherwise claim it.
  // Red checks on a draft are expected rather than actionable, so a draft stays
  // in the ACTIVE group and never competes with a genuinely blocked PR.
  if (pr.isDraft) return unit.dirty ? "active" : "in-progress";
  if (pr.checkConclusions.some((value) => FAILING_CHECKS.has(value))) return "blocked";
  // Changes requested is NOT blocked: the reviewer already acted and the ball
  // is with the author. Merging the two would hide the one state the user can
  // clear on their own.
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "awaiting-followup";
  if (pr.reviewDecision === "APPROVED") {
    if (pr.latestReviewStates.includes("COMMENTED")) return "approved-with-comments";
    if (checksGreen(pr.checkConclusions)) return "awaiting-merge";
  }
  return "awaiting-review";
}

// ---- staleness ------------------------------------------------------------
//
// A DIMENSION, not a lifecycle state. A pull request can be `awaiting-review`
// and `dead` at once, and that pair is the single most useful signal the board
// carries; collapsing them into one enum would destroy it.

export const STALENESS = ["fresh", "recent", "cold", "dead"] as const;
export type Staleness = (typeof STALENESS)[number];

/**
 * The bucket boundaries, in whole days, as inclusive upper bounds. One
 * constant rather than literals sprinkled through the derivation and the UI,
 * because a boundary that exists in three places drifts in two of them.
 */
export const STALENESS_DAYS = { fresh: 7, recent: 30, cold: 90 } as const;

export const DAY_MS = 24 * 60 * 60 * 1_000;

export function stalenessOf(lastCommitAt: string | null, now: number): Staleness {
  if (lastCommitAt === null) return "dead";
  const at = Date.parse(lastCommitAt);
  // A checkout whose last commit date is unreadable is not evidence of
  // freshness, so it reads as dead rather than as fresh.
  if (Number.isNaN(at)) return "dead";
  const days = (now - at) / DAY_MS;
  if (days <= STALENESS_DAYS.fresh) return "fresh";
  if (days <= STALENESS_DAYS.recent) return "recent";
  if (days <= STALENESS_DAYS.cold) return "cold";
  return "dead";
}

const STALENESS_RANK = new Map(STALENESS.map((value, index) => [value, index]));

/**
 * A group is as fresh as its freshest member. One commit yesterday means the
 * work is live, however long its other checkouts have sat.
 */
export function freshest(values: readonly Staleness[]): Staleness {
  return values.reduce(
    (best, candidate) =>
      (STALENESS_RANK.get(candidate) ?? 3) < (STALENESS_RANK.get(best) ?? 3) ? candidate : best,
    values[0] ?? "dead",
  );
}

// ---- surface and risk -----------------------------------------------------
//
// What a change actually touches, from the paths it edits. Deterministic and
// model-free: a rule table is auditable and a classification is not.

export const RISKS = ["none", "low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

/**
 * The shipped table. Exposed as ONE multiline setting because "risk" is
 * org-specific: the lines here (GraphQL schema, generated
 * types, terraform) are exactly what another org would want to replace.
 */
export const DEFAULT_SURFACE_RULES = [
  "# surface: comma-separated glob patterns, matched against repo-relative paths.",
  "# The first table that fails to parse is ignored entirely in favour of this one.",
  "auth: **/auth/**, **/authn/**, **/authorization/**, **/session/**",
  "payments: **/payment*/**, **/stripe/**, **/billing/**, **/invoice*/**, **/checkout/**",
  "migrations: **/migrations/**, **/migration/**, **/db/migrate/**, **/*.sql",
  "schema: **/*.graphql, **/*.graphqls, **/schema.ts, **/__generated__/**, **/generated/graphql*, **/graphql.generated.*",
  // Deliberately narrower than "any YAML": in practice a bare **/*.yml also
  // sweeps up codegen and storybook configs, which are not infrastructure.
  "infra: .github/**, **/*.tf, **/terraform/**, **/Dockerfile*, **/helm/**, **/k8s/**, **/values*.y*ml, **/deployment.y*ml, **/configmap.y*ml, **/*compose*.y*ml",
  "api: **/api/**, **/resolvers/**, **/handlers/**, **/routes/**, **/controllers/**",
  "ui: **/components/**, **/pages/**, **/app/**, **/*.tsx, **/*.css, **/*.scss",
  "tests: **/*.test.*, **/*.spec.*, **/__tests__/**, **/testdata/**, **/e2e/**",
  "docs: **/*.md, **/*.mdx, docs/**",
].join("\n");

export type SurfaceRule = { surface: string; patterns: RegExp[] };

/** A path pattern is a glob, because that is what a developer already knows. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    // Placeholders first, so the single-star rule cannot chew a double star.
    .replace(/\*\*\//gu, "\u0000")
    .replace(/\*\*/gu, "\u0001")
    .replace(/\*/gu, "[^/]*")
    .replace(/\?/gu, "[^/]")
    // `**/` spans zero or more directories, so `**/auth/**` matches `auth/x`.
    .replace(/\u0000/gu, "(?:[^/]*/)*")
    .replace(/\u0001/gu, ".*");
  return new RegExp(`^${escaped}$`, "iu");
}

const RULE_LINE = /^([A-Za-z][A-Za-z0-9_-]{0,30})\s*:\s*(\S.*)$/u;

/**
 * Parse the rule table at the boundary and pass typed values inward. A
 * malformed table falls back to the default WHOLE — half a table silently
 * applied is worse than the default, because the user would see plausible
 * surfaces and never learn their edit was ignored.
 */
export function parseSurfaceRules(text: string): {
  rules: SurfaceRule[];
  warning: string | null;
} {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    return { rules: parseSurfaceRules(DEFAULT_SURFACE_RULES).rules, warning: null };
  }
  const rules: SurfaceRule[] = [];
  for (const line of lines) {
    const match = RULE_LINE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return {
        rules: parseSurfaceRules(DEFAULT_SURFACE_RULES).rules,
        warning: `Surface rules: cannot read "${line.slice(0, 60)}"; using the default table.`,
      };
    }
    const patterns = match[2]
      .split(",")
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern !== "");
    if (patterns.length === 0) {
      return {
        rules: parseSurfaceRules(DEFAULT_SURFACE_RULES).rules,
        warning: `Surface rules: "${match[1]}" lists no patterns; using the default table.`,
      };
    }
    try {
      rules.push({ surface: match[1].toLowerCase(), patterns: patterns.map(globToRegExp) });
    } catch (error) {
      return {
        rules: parseSurfaceRules(DEFAULT_SURFACE_RULES).rules,
        warning: `Surface rules: "${match[1]}" has an unusable pattern (${String(error).slice(0, 80)}); using the default table.`,
      };
    }
  }
  return { rules, warning: null };
}

/** Every surface a set of changed paths touches, in table order. */
export function classifySurfaces(
  paths: readonly string[],
  rules: readonly SurfaceRule[],
): string[] {
  const hit = new Set<string>();
  for (const rule of rules) {
    if (hit.has(rule.surface)) continue;
    if (paths.some((path) => rule.patterns.some((pattern) => pattern.test(path)))) {
      hit.add(rule.surface);
    }
  }
  return rules.map((rule) => rule.surface).filter((surface) => hit.has(surface));
}

/**
 * A coarse ordinal, on purpose. A numeric score over a rule table would carry
 * a precision the table does not have, and the UI would render the decimals as
 * if they meant something.
 */
const HIGH_RISK = new Set(["auth", "payments", "migrations"]);
const LOW_RISK = new Set(["docs", "tests"]);

export function riskOf(surfaces: readonly string[]): Risk {
  if (surfaces.length === 0) return "none";
  if (surfaces.some((surface) => HIGH_RISK.has(surface))) return "high";
  if (surfaces.every((surface) => LOW_RISK.has(surface))) return "low";
  return "medium";
}

/**
 * Surfaces that are dominant at ONE file, whatever else the branch touches:
 * the irreversible ones. A schema migration cannot be un-run against real data
 * and a money path cannot un-charge a customer, so a single file in either is
 * the most important fact about the change. Deliberately a constant and not a
 * setting: which changes are irreversible is not a matter of taste. Every other
 * surface — auth included — is weighed by file count, because a one-file auth
 * helper inside a forty-file UI branch really is a UI change.
 */
export const ESCALATING: readonly string[] = ["migrations", "payments"];

/** The risk of one surface on its own. */
export function surfaceRisk(surface: string): Risk {
  return riskOf([surface]);
}

/** The one surface a cluster is filed under on the Risk face, and its tier. */
export type Dominant = { surface: string | null; risk: Risk };

/**
 * A cluster's ONE home on the Risk face. The union of surfaces is a noisy
 * signal — a big branch touches seven of them and the max over seven is almost
 * always "high" — so the cluster is filed by what it MOSTLY changes: the
 * surface with the most files, ties to the higher tier and then rule-table
 * order. The escalating surfaces override the count (see `ESCALATING`), and
 * between two of them rule-table order decides. A file counts toward every
 * surface it matches, exactly as `classifySurfaces` reads the table.
 */
export function dominantSurface(
  paths: readonly string[],
  rules: readonly SurfaceRule[],
): Dominant {
  const order = new Map<string, number>();
  rules.forEach((rule, index) => {
    if (!order.has(rule.surface)) order.set(rule.surface, index);
  });
  const counts = new Map<string, number>();
  for (const path of paths) {
    const hit = new Set<string>();
    for (const rule of rules) {
      if (!hit.has(rule.surface) && rule.patterns.some((pattern) => pattern.test(path))) {
        hit.add(rule.surface);
      }
    }
    for (const surface of hit) counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  if (counts.size === 0) return { surface: null, risk: "none" };
  const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  const escalated = [...counts.keys()].filter((surface) => ESCALATING.includes(surface)).sort(byOrder);
  const surface =
    escalated[0] ??
    [...counts.keys()].sort(
      (a, b) =>
        (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
        (RISK_RANK.get(surfaceRisk(b)) ?? 0) - (RISK_RANK.get(surfaceRisk(a)) ?? 0) ||
        byOrder(a, b),
    )[0]!;
  return { surface, risk: surfaceRisk(surface) };
}

/** Several units' surfaces, deduplicated and returned in rule-table order. */
export function unionSurfaces(
  groups: readonly (readonly string[])[],
  rules: readonly SurfaceRule[],
): string[] {
  const hit = new Set(groups.flat());
  const ordered = rules.map((rule) => rule.surface).filter((surface) => hit.has(surface));
  // A surface from a table the user has since edited away is still real data;
  // keep it rather than silently dropping work off the board.
  const extra = [...hit].filter((surface) => !ordered.includes(surface)).sort();
  return [...ordered, ...extra];
}

const RISK_RANK = new Map(RISKS.map((value, index) => [value, index]));

export function highestRisk(values: readonly Risk[]): Risk {
  return values.reduce(
    (best, candidate) =>
      (RISK_RANK.get(candidate) ?? 0) > (RISK_RANK.get(best) ?? 0) ? candidate : best,
    values[0] ?? "none",
  );
}

export function mostUrgent(lifecycles: Lifecycle[]): Lifecycle {
  return lifecycles.reduce(
    (best, candidate) =>
      (URGENCY.get(candidate) ?? 99) < (URGENCY.get(best) ?? 99) ? candidate : best,
    lifecycles[0] ?? "local",
  );
}

export function urgencyRank(lifecycle: Lifecycle): number {
  return URGENCY.get(lifecycle) ?? 99;
}

/**
 * The v1 workstream name, which in `basic` mode is also the GROUPING key.
 *
 * Linear stays here on purpose, and only here. With no model in play there is
 * no derived phrase for a project name to compete against, so removing it would
 * not demote Linear from decider to signal — it would delete the only grouping
 * `basic` mode has. Where a derived phrase does exist, Linear is demoted: it
 * becomes one naming CANDIDATE among the cluster's own summaries (see
 * `namingCandidates`), and one weighted similarity term among repos and
 * vocabulary (see `similarity`). A manual override still beats everything.
 */
export function workstreamName(
  ticket: string,
  overrides: Record<string, string>,
  linearProjects: Record<string, string | null>,
): string {
  const override = overrides[ticket];
  if (typeof override === "string" && override.trim() !== "") {
    return override.trim();
  }
  const project = linearProjects[ticket];
  if (typeof project === "string" && project.trim() !== "") return project.trim();
  return ticket;
}

function byRecency(a: Unit, b: Unit): number {
  return (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "");
}

/** Group scanned checkouts into the workstream → cluster → unit tree. */
export function buildBoard(
  rawUnits: RawUnit[],
  options: {
    pattern: RegExp;
    overrides: Record<string, string>;
    linearProjects: Record<string, string | null>;
    /** Ticket → Linear detail. Optional: absent means no Linear, exactly as before. */
    linear?: Record<string, ClusterLinear>;
    /** Receives the one failure stack linking can hit: a cycle of PR bases. */
    onWarning?: (message: string) => void;
    /** Injected so staleness is a pure function and its boundaries testable. */
    now?: number;
    surfaceRules?: readonly SurfaceRule[];
    /** Linear team keys: prefixes a ticket written in prose may use. See `ticketFinder`. */
    teams?: readonly string[];
    /** PR URL → the ticket its Linear linkback comment names. */
    linkbacks?: ReadonlyMap<string, string>;
  },
): Workstream[] {
  const now = options.now ?? Date.now();
  const rules = options.surfaceRules ?? parseSurfaceRules(DEFAULT_SURFACE_RULES).rules;
  const clusters = new Map<string, Cluster>();
  const workstreamOf = new Map<string, string>();
  const all: Unit[] = [];

  const findTicket = ticketFinder(options.pattern, rawUnits, { teams: options.teams, linkbacks: options.linkbacks });
  for (const raw of rawUnits) {
    const found = findTicket(raw);
    const ticket = found?.ticket ?? null;
    const surfaces = classifySurfaces(raw.changedPaths, rules);
    const unit: Unit = {
      ...raw,
      ticket,
      ticketSource: found?.source ?? null,
      lifecycle: unitLifecycle(raw),
      stack: null,
      staleness: stalenessOf(raw.lastCommitAt, now),
      surfaces,
      risk: riskOf(surfaces),
    };
    // A checkout with no ticket gets its own cluster under "Unsorted": it has
    // nothing to be grouped with, and hiding it would hide real work.
    const key = ticket ?? `${UNSORTED}:${raw.path}`;
    const name =
      ticket === null
        ? UNSORTED
        : workstreamName(ticket, options.overrides, options.linearProjects);
    all.push(unit);
    workstreamOf.set(key, name);
    const existing = clusters.get(key);
    if (existing === undefined) {
      const linear = ticket === null ? undefined : options.linear?.[ticket];
      clusters.set(key, {
        ticket: ticket ?? raw.dirName,
        ...(linear === undefined ? {} : { linear }),
        lifecycle: unit.lifecycle,
        units: [unit],
        staleness: unit.staleness,
        surfaces: unit.surfaces,
        risk: unit.risk,
      });
    } else {
      existing.units.push(unit);
    }
  }

  // Stacks span clusters, so they are linked over every unit before grouping.
  linkStacks(all, options.onWarning ?? (() => {}));

  const workstreams = new Map<string, Cluster[]>();
  for (const [key, cluster] of clusters) {
    cluster.lifecycle = mostUrgent(cluster.units.map((unit) => unit.lifecycle));
    cluster.staleness = freshest(cluster.units.map((unit) => unit.staleness));
    cluster.surfaces = unionSurfaces(cluster.units.map((unit) => unit.surfaces), rules);
    cluster.risk = riskOf(cluster.surfaces);
    // Recency inside a cluster is a tiebreak between checkouts of one ticket,
    // not a status ordering: a unit's lifecycle never reaches this comparison.
    cluster.units.sort(byRecency);
    const name = workstreamOf.get(key) ?? UNSORTED;
    const bucket = workstreams.get(name);
    if (bucket === undefined) workstreams.set(name, [cluster]);
    else bucket.push(cluster);
  }

  // Order is the grouping's business and nothing else's. Sorting by lifecycle
  // is what made this a status board wearing thematic labels, and it is what
  // moved rows under the reader between two refreshes that changed no work.
  return [...workstreams]
    .map(([name, list]) => ({
      name,
      clusters: list.sort((a, b) => a.ticket.localeCompare(b.ticket)),
    }))
    .sort((a, b) => {
      // Unsorted is a catch-all, not a workstream; keep it last.
      if ((a.name === UNSORTED) !== (b.name === UNSORTED)) {
        return a.name === UNSORTED ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
}

// ---------------------------------------------------------------------------
// v2: words and efforts.
//
// Everything below is deterministic. Code owns counting, sorting, rollup math,
// hashing and candidate grouping; a model is only ever asked to pick between
// options code produced, or to rename a group code assembled.
// ---------------------------------------------------------------------------

/** A cluster with the summary the board shows next to it. */
export type SummarizedCluster = Cluster & { summary: string };

/**
 * The derived grouping levels, coarsest first. THREE is the ceiling, in code
 * and not in a setting: depth is the parameter a grouping algorithm is worst at
 * choosing, and handing that choice to a config field just moves the mistake.
 *
 * The collapse rules in `collapseGroups` are what make a third level safe. They
 * let the data DECLINE the extra level rather than obliging it to invent one:
 * a domain that merely restates its programs, or a program holding one effort,
 * is deleted rather than rendered. Depth is a maximum, never a target.
 */
export const GROUP_LEVELS = ["domain", "program", "effort"] as const;
export type GroupLevel = (typeof GROUP_LEVELS)[number];

/** How many words a name at each level gets. Broader as the level widens. */
export const NAME_WORDS: Record<GroupLevel, { min: number; max: number }> = {
  domain: { min: 1, max: 4 },
  program: { min: 2, max: 6 },
  effort: { min: 3, max: 8 },
};

/**
 * Claude's verdict on a grouping it was asked to NAME, returned in the same
 * call. It exists because a fluent name makes a bad grouping harder to spot,
 * not easier — and because in a hierarchy an incoherent program silently
 * mis-frames everything under it.
 *
 * Claude may not change membership. The whole value of the flag is that it
 * disagrees with the grouping out loud instead of quietly fixing it.
 */
export type Cohesion = {
  verdict: "cohesive" | "mixed";
  /** One line, only when the verdict is `mixed`. */
  reason: string | null;
};

/** A name paid for once, with the verdict that was free alongside it. */
export type NamedGroup = { name: string; cohesion: Cohesion | null };

/**
 * One node of the grouping hierarchy at any level. Sent FLAT with a
 * `parentKey`, because a flat list validates without recursion, survives a
 * collapse that changes which level is the root, and lets the renderer rebuild
 * exactly the tree the server decided on.
 */
export type BoardGroup = {
  level: GroupLevel;
  /** Unique board-wide: the level prefix plus the label members were assigned to. */
  key: string;
  parentKey: string | null;
  /** Display name. Word budget per level, see `NAME_WORDS`. */
  name: string;
  /** Templated sentence over real counts. */
  rollup: string;
  lifecycle: Lifecycle;
  /** Null in `basic` and `jev` modes: no verdict is better than a fabricated one. */
  cohesion: Cohesion | null;
  /** Populated only at the effort level; the two levels above hold groups. */
  clusters: SummarizedCluster[];
  repoCount: number;
  /** Units that merged or shipped, out of every unit below this group. */
  merged: number;
  total: number;
  staleness: Staleness;
  surfaces: string[];
  risk: Risk;
};

/** v3's name for the effort level, kept so callers read the way they did. */
export type Effort = BoardGroup;

/**
 * Many teams prefix PR titles with the Linear key ("OPS-1234: Add gift card wrapping").
 * The key is already the cluster heading, so repeating it in the summary wastes
 * the only line the summary gets.
 */
export function stripTicketPrefix(title: string): string {
  return title.replace(/^\s*[A-Za-z]{2,5}-\d{1,6}\s*[:\-–—]\s*/u, "").trim();
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word !== "").length;
}

/**
 * A summary earns its place by being scannable. Under three words it says
 * nothing; over eight it stops being readable in a dense row, so an over-long
 * candidate is rejected rather than silently truncated mid-thought.
 */
export function isSummaryLength(text: string): boolean {
  const words = wordCount(text);
  return words >= 3 && words <= 8;
}

/** Trim a candidate to the 3-8 word window, or reject it as unusable. */
const CONVENTIONAL_TYPES =
  "feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert";

/**
 * Many teams use conventional commits, so a real title reads
 * "fix(search): trim stray whitespace from queries". The type and scope say
 * nothing a reader of this board needs and cost two of the eight words a
 * summary gets.
 */
export function stripConventionalPrefix(title: string): string {
  return title
    .replace(new RegExp(`^\\s*(${CONVENTIONAL_TYPES})(\\([^)]*\\))?!?\\s*:\\s*`, "iu"), "")
    .trim();
}

/**
 * Titles carry either prefix, in either order ("OPS-1234: fix(x): ..." and
 * "fix(x): OPS-1234 ..." both occur), so strip until nothing more comes off.
 */
function stripPrefixes(title: string): string {
  let text = title.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripConventionalPrefix(stripTicketPrefix(text));
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Clean a PR title into summary text. Deliberately does NOT truncate: callers
 * choose between whole candidates first and only truncate as a last resort,
 * because a title cut mid-phrase ("rebuild the recommendation carousel so it loads lazily...") reads
 * worse than a slightly older title that fits whole.
 */
export function normalizeSummary(raw: string): string | null {
  const text = stripPrefixes(raw).replace(/\s+/gu, " ").replace(/[.\s]+$/u, "").trim();
  if (text === "") return null;
  if (text.split(" ").length < 3) return null;
  return text;
}

/** Last-resort shortening, keeping the leading, most specific clause. */
export function truncateSummary(text: string): string {
  return text.split(" ").slice(0, 8).join(" ");
}

/**
 * A PR title as it should appear on a unit row: prefixes stripped, nothing
 * else changed. Unlike normalizeSummary this never rejects a short title and
 * never truncates — the row is already width-constrained, and the full text
 * stays available in the hover title.
 */
export function displayTitle(raw: string): string {
  const text = stripPrefixes(raw).replace(/\s+/gu, " ").trim();
  return text === "" ? raw.trim() : text;
}

function unitsByRecency(cluster: Cluster): Unit[] {
  return [...cluster.units].sort((a, b) =>
    (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""),
  );
}

/**
 * The PR titles a model may choose between for this cluster's summary. They are
 * the user's own words, so selecting one is always better than generating a
 * paraphrase of them.
 */
export function summaryCandidates(cluster: Cluster): string[] {
  const seen = new Set<string>();
  for (const unit of unitsByRecency(cluster)) {
    const title = unit.pr === null ? null : normalizeSummary(unit.pr.title);
    if (title !== null) seen.add(title);
  }
  const all = [...seen];
  // Offer every title that already fits before any truncated one: a whole
  // sentence from a slightly older PR describes the cluster better than the
  // newest PR's title chopped mid-phrase.
  const whole = all.filter((text) => isSummaryLength(text));
  const shortened = all
    .filter((text) => !isSummaryLength(text))
    .map((text) => truncateSummary(text))
    .filter((text) => !whole.includes(text));
  return [...whole, ...shortened].slice(0, 8);
}

/**
 * What Jev chooses a cluster's summary from: its PR titles, plus its Linear
 * ticket's title when one is known — one more candidate, never the default.
 * With no Linear detail this is exactly `summaryCandidates`.
 */
export function summaryChoices(cluster: Cluster): string[] {
  const titles = summaryCandidates(cluster);
  const raw = cluster.linear?.title;
  const linear = typeof raw === "string" ? normalizeSummary(raw) : null;
  if (linear === null || titles.includes(linear)) return titles;
  return [...titles.slice(0, 7), isSummaryLength(linear) ? linear : truncateSummary(linear)];
}

/**
 * Summary with no model in the loop: the most recent PR title, prefix stripped.
 * This is what the board shows before — or instead of — any model call, so it
 * has to be genuinely useful rather than a placeholder.
 */
export function fallbackSummary(cluster: Cluster): string {
  return summaryCandidates(cluster)[0] ?? cluster.ticket;
}

/** FNV-1a. Not cryptographic; it only has to be stable and browser-safe. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Hash only what changes the MEANING of a cluster: its ticket, the repos it
 * touches, its PR titles and its branch slugs. Lifecycles, ahead/behind counts
 * and timestamps churn on every scan, so including them would invalidate the
 * cache constantly and make every rescan cost model calls.
 */
export function clusterInputHash(cluster: Cluster): string {
  const repos = [...new Set(cluster.units.map((unit) => unit.repo ?? unit.dirName))].sort();
  const titles = [
    ...new Set(
      cluster.units.flatMap((unit) => (unit.pr === null ? [] : [unit.pr.title])),
    ),
  ].sort();
  const branches = [
    ...new Set(cluster.units.flatMap((unit) => (unit.branch === null ? [] : [unit.branch]))),
  ].sort();
  // Linear's stable words join the hash only when known, so a board with no
  // Linear detail hashes bit-for-bit as before. Its STATE never does: a ticket
  // moving to Done is not a change in what the work is about.
  const linear = cluster.linear;
  const payload =
    linear === undefined || linear === null
      ? [cluster.ticket, repos, titles, branches]
      : [cluster.ticket, repos, titles, branches, [linear.title, linear.project, linear.parentIdentifier ?? linear.parentTitle]];
  return hashString(JSON.stringify(payload));
}

/**
 * Hash of a group's member set, so a rename is only paid for once. EVERY level
 * caches on its own member hash — that is what makes a semantically unchanged
 * rescan cost zero model calls at every rung of the hierarchy, not just at the
 * bottom one.
 *
 * The effort level's payload is deliberately unchanged from v3, so the names
 * already paid for stay in cache across this migration. The levels above mix
 * their own name into the payload, which keeps two levels from ever colliding
 * on one row.
 */
export function memberHash(level: GroupLevel, childHashes: readonly string[]): string {
  const sorted = [...childHashes].sort();
  return hashString(
    level === "effort" ? JSON.stringify(sorted) : JSON.stringify([level, sorted]),
  );
}

/** Hash of an effort's member set, so a rename is only paid for once. */
export function effortMemberHash(clusters: Cluster[]): string {
  return memberHash("effort", clusters.map(clusterInputHash));
}

/**
 * The phrases a naming call may choose between for a group. The Linear project
 * is offered here as ONE candidate alongside the members' own summaries rather
 * than being installed as the answer — which is the whole of "Linear informs
 * the theme, it does not decide it" on the naming side.
 */
export function namingCandidates(
  summaries: readonly string[],
  linearProjects: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  for (const project of linearProjects) {
    if (typeof project === "string" && project.trim() !== "") seen.add(project.trim());
  }
  for (const summary of summaries) {
    if (summary.trim() !== "") seen.add(summary.trim());
  }
  return [...seen].slice(0, 12);
}

// ---- the status lens ------------------------------------------------------
//
// Status filters and paints the SPATIAL views. It never positions a circle or
// a group, and neither do the two dimensions beside it — which is why all three live in one pure predicate the
// renderer consults AFTER the layout has already been decided.

export const LENSES = ["all", "active", "waiting", "done"] as const;
export type Lens = (typeof LENSES)[number];

/** The lenses ARE the lifecycle groups, so nothing can be filterable twice. */
const LENS_GROUP: Record<Lens, LifecycleGroup | null> = {
  all: null,
  active: "active",
  waiting: "waiting",
  done: "done",
};

export function matchesLens(lifecycle: Lifecycle, lens: Lens): boolean {
  const group = LENS_GROUP[lens];
  return group === null || lifecycleGroup(lifecycle) === group;
}

/**
 * "Needs you" is not a lens — it is a halo the map paints on these states at
 * every zoom, inside whatever lens is active. Waiting on someone ELSE
 * (`awaiting-review`) is deliberately excluded: attention is drawn only to
 * what the reader themself can unblock.
 */
export const ACTIONABLE: readonly Lifecycle[] = [
  "blocked",
  "awaiting-followup",
  "approved-with-comments",
  "awaiting-merge",
];

/**
 * Stuck: work that is expected to move and has not been touched in a month.
 * Every Waiting state counts, and so do the two Active states that mean
 * somebody is on it. `up-next` does not — a parked checkout is not expected to
 * move — and nothing Done can be stuck. `awaiting-review` and dead is the
 * single most useful pairing the two dimensions produce.
 */
export function isStuck(cluster: { lifecycle: Lifecycle; staleness: Staleness }): boolean {
  if (cluster.staleness !== "cold" && cluster.staleness !== "dead") return false;
  return (
    lifecycleGroup(cluster.lifecycle) === "waiting" ||
    cluster.lifecycle === "active" ||
    cluster.lifecycle === "in-progress"
  );
}

export type LensFilters = {
  lens: Lens;
  /** Empty means every bucket, so the two filters compose without a null case. */
  staleness: readonly Staleness[];
  surfaces: readonly string[];
};

export const ALL_LENSES: LensFilters = { lens: "all", staleness: [], surfaces: [] };

/** Composable by construction: "Needs you" ∩ "cold or dead" is just both. */
export function matchesFilters(
  item: { lifecycle: Lifecycle; staleness: Staleness; surfaces: readonly string[] },
  filters: LensFilters,
): boolean {
  if (!matchesLens(item.lifecycle, filters.lens)) return false;
  if (filters.staleness.length > 0 && !filters.staleness.includes(item.staleness)) return false;
  if (
    filters.surfaces.length > 0 &&
    !filters.surfaces.some((surface) => item.surfaces.includes(surface))
  ) {
    return false;
  }
  return true;
}

// ---- rollup sentences -----------------------------------------------------

const BLOCKED_CHECKS = new Set(["FAILURE", "ERROR"]);

function repoOf(unit: Unit): string {
  return unit.repo ?? unit.dirName;
}

function firstUnit(units: Unit[], lifecycle: Lifecycle): Unit | undefined {
  return units.find((unit) => unit.lifecycle === lifecycle);
}

function countOf(units: Unit[], lifecycle: Lifecycle): number {
  return units.filter((unit) => unit.lifecycle === lifecycle).length;
}

function blockedReason(unit: Unit): string {
  const failing =
    unit.pr !== null && unit.pr.checkConclusions.some((value) => BLOCKED_CHECKS.has(value));
  return failing ? "CI" : "review";
}

/**
 * The written half of the board, composed entirely from counts code already
 * has. A model would add nothing here: it cannot be more correct about "5 of 9"
 * than the arithmetic is, and it can be less correct.
 */
export function rollupSentence(clusters: Cluster[]): string {
  const units = clusters.flatMap((cluster) => cluster.units);
  if (units.length === 0) return "No checkouts.";
  // `shipped` is merged work that also reached production, so it counts as
  // merged here: the sentence is about how much of the effort has landed.
  const merged = countOf(units, "merged") + countOf(units, "shipped");
  const head = `${merged} of ${units.length} merged`;

  const blocked = firstUnit(units, "blocked");
  if (blocked !== undefined) {
    return `${head}; ${repoOf(blocked)} blocked on ${blockedReason(blocked)}.`;
  }
  // An approved, green PR at the top of a stack still cannot merge, so it is
  // reported as waiting rather than as the next thing to do. Its own lifecycle
  // stays "awaiting-merge" — the PR really is ready; only the merge order is not.
  const readyUnits = units.filter((unit) => unit.lifecycle === "awaiting-merge");
  const clear = readyUnits.find((unit) => unit.stack?.blockedBelow == null);
  if (clear !== undefined) return `${head}; ${repoOf(clear)} ready to merge.`;
  const stacked = readyUnits[0];
  if (stacked !== undefined) {
    return `${head}; ${repoOf(stacked)} approved, blocked by #${stacked.stack?.blockedBelow} below it.`;
  }

  for (const [lifecycle, phrase] of [
    ["awaiting-followup", "waiting on your changes"],
    ["approved-with-comments", "approved with open comments"],
    ["awaiting-review", "awaiting review"],
    ["active", "being edited"],
    ["in-progress", "in draft"],
    ["up-next", "parked locally"],
    ["shipped", "shipped"],
  ] as const) {
    const count = countOf(units, lifecycle);
    if (count === 0) continue;
    const only = firstUnit(units, lifecycle);
    return count === 1 && only !== undefined
      ? `${head}; ${repoOf(only)} ${phrase}.`
      : `${head}; ${count} ${phrase}.`;
  }
  return `${head}; nothing open.`;
}

// ---- candidate grouping ---------------------------------------------------

const STOPWORDS = new Set([
  "add", "adds", "and", "for", "fix", "fixes", "from", "into", "the", "this",
  "that", "with", "when", "update", "updates", "use", "using", "make", "feat",
  "chore", "refactor", "remove", "removes", "support", "main", "master",
]);

/** Meaningful words from a cluster's branch slugs and PR titles. */
export function clusterVocabulary(cluster: Cluster): Set<string> {
  const words = new Set<string>();
  for (const unit of cluster.units) {
    const sources = [unit.branch ?? "", unit.pr?.title ?? ""];
    for (const source of sources) {
      for (const raw of source.toLowerCase().split(/[^a-z0-9]+/u)) {
        if (raw.length < 4 || /^\d+$/u.test(raw) || STOPWORDS.has(raw)) continue;
        words.add(raw);
      }
    }
  }
  return words;
}

// ---- code areas: where in the code a cluster works --------------------------

/** Directory names that hold code rather than name what it is about. */
const CONTAINER_SEGMENTS = new Set([
  "src", "lib", "app", "apps", "packages", "services", "internal", "pkg", "cmd",
  "test", "tests", "__tests__", "spec", "e2e",
]);
/** Build output and generated code: what changed there says nothing about the work. */
const GENERATED_SEGMENTS = new Set(["dist", "generated", "__generated__", "node_modules", "vendor"]);
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Podfile\.lock|[^/]+\.lock)$/u;
const GENERATED_FILE = /\.(?:generated|gen|pb|min)\.[a-z]+$|_pb2\.py$|\.snap$/u;
/** Meaningful directory segments kept per area. */
const AREA_DEPTH = 2;

/**
 * The code area one changed path belongs to, or null when the path says nothing
 * about the work (a lockfile, generated output).
 *
 * Why areas and not repos: a repo is an artificial grouping input. In a
 * monorepo EVERY pair of clusters shares the repo, so repo overlap would agree
 * for every pair and quietly defeat the two-signal rule; in a polyrepo two
 * unrelated chores in one repo would look like one body of work. Where the code
 * lives inside the repo stays meaningful in both: container segments (src,
 * packages, apps, …) are stripped and the next two named directories are kept,
 * so `packages/reader-web/src/shelves/Form.tsx` is `reader-web/shelves`.
 *
 * The repo is prefixed as a DISAMBIGUATOR, never a signal: identical areas in
 * two repos stay distinct, and in a monorepo the prefix is the same for every
 * cluster, so it can neither create nor block agreement — two clusters in one
 * repo but different areas share nothing.
 */
export function codeArea(repo: string, path: string): string | null {
  const clean = path.replace(/^\.?\/+/u, "");
  if (LOCKFILE.test(clean) || GENERATED_FILE.test(clean)) return null;
  const directories = clean.split("/").slice(0, -1);
  if (directories.some((segment) => GENERATED_SEGMENTS.has(segment))) return null;
  const named = directories.filter((segment) => !CONTAINER_SEGMENTS.has(segment)).slice(0, AREA_DEPTH);
  return `${repo}:${named.length === 0 ? "." : named.join("/")}`;
}

/** Changed files per code area across a cluster's checkouts. Empty when nothing changed. */
export function areaProfile(cluster: Cluster): Map<string, number> {
  const counts = new Map<string, number>();
  for (const unit of cluster.units) {
    for (const path of unit.changedPaths) {
      const area = codeArea(repoOf(unit), path);
      if (area !== null) counts.set(area, (counts.get(area) ?? 0) + 1);
    }
  }
  return counts;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * One thing to be seeded, at whatever level. Clusters seed efforts, efforts
 * seed programs and programs seed domains through the SAME function, because a
 * second grouping mechanism is a second set of bugs and a second thing to tune.
 */
export type SeedItem = {
  key: string;
  /** Changed files per code area; see `codeArea`. */
  areas: ReadonlyMap<string, number>;
  vocab: ReadonlySet<string>;
  /** Linear project names the item touches. */
  projects: ReadonlySet<string>;
  /** Linear parent issues the item's tickets sit under. */
  parents: ReadonlySet<string>;
  /** Strong-linked thread id → its specificity weight; see `threadWeights`. */
  threads: ReadonlyMap<string, number>;
};

/**
 * How much each code area says, over the items being seeded: an area few items
 * touch is specific evidence, one many touch (shared utils, config) is not, and
 * one touched by more than a quarter of them — never fewer than two — says
 * nothing at all.
 */
export const AREA_COMMON_SHARE = 0.25;

export function areaWeights(items: readonly Pick<SeedItem, "areas">[]): Map<string, number> {
  const touched = new Map<string, number>();
  for (const item of items) for (const area of item.areas.keys()) touched.set(area, (touched.get(area) ?? 0) + 1);
  const cutoff = Math.max(2, AREA_COMMON_SHARE * items.length);
  const weights = new Map<string, number>();
  for (const [area, count] of touched) {
    weights.set(area, count > cutoff ? 0 : Math.log(1 + items.length / count));
  }
  return weights;
}

/** Weighted Jaccard over areas: file counts dampened by log, scaled by how specific each area is. */
function areaAgreement(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  weights: ReadonlyMap<string, number>,
): number {
  let shared = 0;
  let total = 0;
  for (const area of new Set([...a.keys(), ...b.keys()])) {
    const weight = weights.get(area) ?? 0;
    if (weight === 0) continue;
    const left = Math.log1p(a.get(area) ?? 0);
    const right = Math.log1p(b.get(area) ?? 0);
    shared += weight * Math.min(left, right);
    total += weight * Math.max(left, right);
  }
  return total === 0 ? 0 : shared / total;
}

/** Summed specificity of the threads both items are strongly linked to, capped at 1. */
function threadAgreement(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const [thread, weight] of a) if (b.has(thread)) sum += weight;
  return Math.min(1, sum);
}

/** The four independent signals, each 0-1. Repo is deliberately not one; see `codeArea`. */
export type Signals = { area: number; vocab: number; linear: number; thread: number };

export function signalsBetween(a: SeedItem, b: SeedItem, weights: ReadonlyMap<string, number>): Signals {
  return {
    area: areaAgreement(a.areas, b.areas, weights),
    vocab: jaccard(a.vocab, b.vocab),
    // One source, one signal: a shared parent is the sharper half of it.
    linear: Math.max(jaccard(a.parents, b.parents), 0.7 * jaccard(a.projects, b.projects)),
    thread: threadAgreement(a.threads, b.threads),
  };
}

/** A signal below this is noise, not agreement. */
export const SIGNAL_FLOOR = 0.1;
/** How many independent signals must agree before two items may merge. */
export const SIGNALS_REQUIRED = 2;
const SIMILARITY_WEIGHTS: Signals = { area: 0.6, vocab: 0.4, linear: 0.3, thread: 0.4 };

/**
 * The merge score, or 0 when the pair may not merge.
 *
 * The general rule is a gate: no single signal can merge two items on its
 * own. At least two must agree, and the weighted sum then ranks the pairs that
 * passed against the merge threshold.
 *
 * The exception is Linear. A pair that shares a Linear parent issue or project
 * may merge when ANY other signal (code area, vocabulary, shared thread) is
 * nonzero, however weak, bypassing both the gate and the threshold. The user
 * chose this knowing that on real data "any other signal" is almost always
 * true, so for Linear-linked clusters Linear effectively decides the group.
 * It deliberately reverses the earlier "Linear informs, it never decides", for
 * the cross-repo groups that rule kept apart: Linear-sharing pairs in an
 * offline replay of live data scored 0.03-0.23 on vocabulary and never cleared
 * two signals. Linear with no other signal at all still merges nothing.
 */
export function similarity(a: SeedItem, b: SeedItem, weights: ReadonlyMap<string, number> = areaWeights([a, b])): number {
  const signals = signalsBetween(a, b, weights);
  const sum = (Object.keys(signals) as (keyof Signals)[]).reduce((total, name) => total + SIMILARITY_WEIGHTS[name] * signals[name], 0);
  if (sharesLinear(a, b) && (signals.area > 0 || signals.vocab > 0 || signals.thread > 0)) {
    // Eligible at any score; still ranked by its sum against other pairs.
    return Math.max(sum, MERGE_THRESHOLD + 1e-9);
  }
  const agreeing = (Object.keys(signals) as (keyof Signals)[]).filter((name) => signals[name] >= SIGNAL_FLOOR).length;
  return agreeing < SIGNALS_REQUIRED ? 0 : sum;
}

function sharesLinear(a: SeedItem, b: SeedItem): boolean {
  return [...a.parents].some((parent) => b.parents.has(parent)) || [...a.projects].some((project) => b.projects.has(project));
}

export const MERGE_THRESHOLD = 0.25;
const MAX_GROUP = 8;

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  return new Set([...a, ...b]);
}

function sumCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [key, value] of b) out.set(key, (out.get(key) ?? 0) + value);
  return out;
}

/**
 * Agglomerative seeding: merge the most similar pair of groups until nothing is
 * similar enough. These are CANDIDATES — a model decides which one each item
 * really belongs to, and code decides whether that decision was confident
 * enough to keep. Comparing unions rather than single links keeps a growing
 * group from chaining every remaining item into one blob.
 *
 * Returns groups of KEYS, sorted, so the same function serves every level.
 */
export function seedItems(items: readonly SeedItem[]): string[][] {
  // Specificity is judged once, over the items as given: merging must not make
  // an area look rarer than it is.
  const weights = areaWeights(items);
  const groups = items.map((item) => ({ members: [item.key], item: { ...item } }));

  for (;;) {
    let best = { score: MERGE_THRESHOLD, left: -1, right: -1 };
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const a = groups[left];
        const b = groups[right];
        if (a === undefined || b === undefined) continue;
        if (a.members.length + b.members.length > MAX_GROUP) continue;
        const score = similarity(a.item, b.item, weights);
        if (score > best.score) best = { score, left, right };
      }
    }
    if (best.left === -1) break;
    const a = groups[best.left];
    const b = groups[best.right];
    if (a === undefined || b === undefined) break;
    a.members.push(...b.members);
    a.item = {
      key: a.item.key,
      areas: sumCounts(a.item.areas, b.item.areas),
      vocab: union(a.item.vocab, b.item.vocab),
      projects: union(a.item.projects, b.item.projects),
      parents: union(a.item.parents, b.item.parents),
      threads: new Map([...a.item.threads, ...b.item.threads]),
    };
    groups.splice(best.right, 1);
  }

  // Ordered by key, never by status: a seed group whose membership order
  // depended on lifecycle would hand a status ordering to every level above it.
  return groups.map((group) => [...group.members].sort((a, b) => a.localeCompare(b)));
}

/** What seeding knows about each ticket beyond its own checkouts and its Linear detail. */
export type SeedContext = {
  /** Ticket → strong-linked thread id → specificity weight. */
  threads?: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

function present(value: string | null | undefined): Set<string> {
  return typeof value === "string" && value.trim() !== "" ? new Set([value.trim()]) : new Set<string>();
}

/** One cluster as a seed item. */
export function clusterSeedItem(cluster: Cluster, context: SeedContext = {}): SeedItem {
  return {
    key: cluster.ticket,
    areas: areaProfile(cluster),
    vocab: clusterVocabulary(cluster),
    projects: present(cluster.linear?.project),
    parents: present(cluster.linear?.parentIdentifier ?? cluster.linear?.parentTitle),
    threads: context.threads?.get(cluster.ticket) ?? new Map(),
  };
}

/** A group of clusters as ONE seed item, for the levels above an effort. */
export function groupSeedItem(key: string, clusters: readonly Cluster[], context: SeedContext = {}): SeedItem {
  const parts = clusters.map((cluster) => clusterSeedItem(cluster, context));
  return {
    key,
    areas: parts.reduce<Map<string, number>>((sum, part) => sumCounts(sum, part.areas), new Map()),
    vocab: new Set(parts.flatMap((part) => [...part.vocab])),
    projects: new Set(parts.flatMap((part) => [...part.projects])),
    parents: new Set(parts.flatMap((part) => [...part.parents])),
    threads: new Map(parts.flatMap((part) => [...part.threads])),
  };
}

/** The cluster level's seeding, expressed through the generic one. */
export function seedGroups(clusters: Cluster[], context: SeedContext = {}): Cluster[][] {
  const byKey = new Map(clusters.map((cluster) => [cluster.ticket, cluster]));
  return seedItems(clusters.map((cluster) => clusterSeedItem(cluster, context))).map((keys) =>
    keys.flatMap((key) => {
      const cluster = byKey.get(key);
      return cluster === undefined ? [] : [cluster];
    }),
  );
}

// ---- effort assembly ------------------------------------------------------

/** What the enrichment step cached for one cluster, if anything. */
export type ClusterDecision = {
  /** Selected summary, or null when only the deterministic fallback exists. */
  summary: string | null;
  /** Effort label a model picked, with its normalized 0-1 fit. */
  assignment: { label: string; fit: number } | null;
};

/**
 * Which effort a cluster belongs to. Resolution order is deliberate:
 * a name the user typed always wins; a low-confidence model assignment is sent
 * to Unsorted rather than force-fitted into a confident-looking effort; and
 * with no model in play the board keeps v1's grouping instead of degrading.
 */
export function effortLabel(options: {
  ticket: string;
  override: string | undefined;
  assignment: { label: string; fit: number } | null;
  threshold: number;
  grouped: boolean;
  fallbackName: string;
}): string {
  const override = options.override;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  if (!options.grouped) return options.fallbackName;
  if (options.assignment === null) return options.fallbackName;
  return options.assignment.fit >= options.threshold ? options.assignment.label : UNSORTED;
}

export function isDone(lifecycle: Lifecycle): boolean {
  return lifecycleGroup(lifecycle) === "done";
}

/**
 * Assemble the effort level. Names come from `names` when a model supplied one
 * and otherwise from the best-fitting member's own summary, so an effort is
 * never nameless and never named by a model that was not asked.
 */
export function buildEfforts(
  labelled: { label: string; cluster: SummarizedCluster; fit: number }[],
  names: Record<string, NamedGroup>,
  /**
   * False when no model grouped anything: the label is then v1's workstream
   * name, which is what the effort should be called. True when the label is
   * only a cache key and the name has to come from a member's own words.
   */
  grouped = true,
  surfaceRules: readonly SurfaceRule[] = parseSurfaceRules(DEFAULT_SURFACE_RULES).rules,
): BoardGroup[] {
  const buckets = new Map<string, { cluster: SummarizedCluster; fit: number }[]>();
  for (const entry of labelled) {
    const bucket = buckets.get(entry.label);
    if (bucket === undefined) buckets.set(entry.label, [entry]);
    else bucket.push(entry);
  }

  const efforts: BoardGroup[] = [];
  for (const [label, members] of buckets) {
    const clusters = members
      .map((member) => member.cluster)
      .sort((a, b) => a.ticket.localeCompare(b.ticket));
    const units = clusters.flatMap((cluster) => cluster.units);
    const best = [...members].sort((a, b) => b.fit - a.fit)[0];
    const named = names[label];
    const surfaces = unionSurfaces(
      clusters.map((cluster) => cluster.surfaces),
      surfaceRules,
    );
    efforts.push({
      level: "effort",
      key: label,
      parentKey: null,
      name:
        label === UNSORTED || !grouped
          ? label
          : (named !== undefined && named.name.trim() !== ""
              ? named.name.trim()
              : (best?.cluster.summary ?? label)),
      rollup: rollupSentence(clusters),
      lifecycle: mostUrgent(clusters.map((cluster) => cluster.lifecycle)),
      // A borrowed name was never judged for cohesion, so there is nothing to
      // report; a synthesized verdict would be worse than none.
      // An empty cached name is a recorded rejection, not a name.
      cohesion: label === UNSORTED || !grouped ? null : (named?.cohesion ?? null),
      clusters,
      repoCount: new Set(units.map(repoOf)).size,
      merged: countOf(units, "merged") + countOf(units, "shipped"),
      total: units.length,
      staleness: freshest(clusters.map((cluster) => cluster.staleness)),
      surfaces,
      risk: riskOf(surfaces),
    });
  }

  return efforts.sort(byGroupOrder);
}

/**
 * The ONE ordering every level uses: name, then key, with the catch-all last.
 * Lifecycle is not an input and must never become one — spatial position (the
 * Map, the group tree) belongs to the grouping hierarchy, and status is a lens
 * painted on top of it. The Board's inbox orders by next action instead; see
 * `byInboxOrder`.
 */
export function byGroupOrder(a: BoardGroup, b: BoardGroup): number {
  const unsortedA = a.key === UNSORTED || a.key.endsWith(`:${UNSORTED}`);
  const unsortedB = b.key === UNSORTED || b.key.endsWith(`:${UNSORTED}`);
  if (unsortedA !== unsortedB) return unsortedA ? 1 : -1;
  return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

// ---- the levels above an effort -------------------------------------------

/** A group with the children it holds, before the tree is flattened. */
type Node = { group: BoardGroup; children: Node[] };

function descendantClusters(node: Node): SummarizedCluster[] {
  if (node.children.length === 0) return node.group.clusters;
  return node.children.flatMap(descendantClusters);
}

/**
 * Build the level above `children` from an assignment of child key to parent
 * label. Identical machinery at every rung: the only things that change are the
 * word budget of the name and how many members there are to compare.
 */
export function rollUp(
  children: Node[],
  level: Exclude<GroupLevel, "effort">,
  parentLabelOf: (child: BoardGroup) => string,
  names: Record<string, NamedGroup>,
  grouped: boolean,
  surfaceRules: readonly SurfaceRule[] = parseSurfaceRules(DEFAULT_SURFACE_RULES).rules,
): Node[] {
  const buckets = new Map<string, Node[]>();
  for (const child of children) {
    const label = parentLabelOf(child.group);
    const bucket = buckets.get(label);
    if (bucket === undefined) buckets.set(label, [child]);
    else bucket.push(child);
  }

  const parents: Node[] = [];
  for (const [label, members] of buckets) {
    const ordered = [...members].sort((a, b) => byGroupOrder(a.group, b.group));
    const clusters = ordered.flatMap(descendantClusters);
    const units = clusters.flatMap((cluster) => cluster.units);
    const named = names[label];
    const surfaces = unionSurfaces(
      ordered.map((member) => member.group.surfaces),
      surfaceRules,
    );
    const key = `${level}:${label}`;
    const group: BoardGroup = {
      level,
      key,
      parentKey: null,
      // With no written name available the level borrows its widest member's
      // name, exactly as an effort borrows a member's selected summary.
      name:
        label === UNSORTED || !grouped
          ? label
          : (named !== undefined && named.name.trim() !== ""
              ? named.name.trim()
              : (ordered[0]?.group.name ?? label)),
      rollup: rollupSentence(clusters),
      lifecycle: mostUrgent(clusters.map((cluster) => cluster.lifecycle)),
      cohesion: label === UNSORTED || !grouped ? null : (named?.cohesion ?? null),
      clusters: [],
      repoCount: new Set(units.map(repoOf)).size,
      merged: countOf(units, "merged") + countOf(units, "shipped"),
      total: units.length,
      staleness: freshest(clusters.map((cluster) => cluster.staleness)),
      surfaces,
      risk: riskOf(surfaces),
    };
    for (const member of ordered) member.group.parentKey = key;
    parents.push({ group, children: ordered });
  }

  return parents.sort((a, b) => byGroupOrder(a.group, b.group));
}

/**
 * Delete every level that did not earn its place.
 *
 * Two rules, and the second turns out to BE the first. A level whose grouping
 * merely restates the level below it — the same membership partition — is
 * noise; and a partition is restated exactly when every group in it holds one
 * child. So collapsing single-child groups everywhere, plus dissolving a single
 * root that holds the whole board, is the complete rule set rather than a
 * first approximation of it.
 */
function collapseNodes(nodes: Node[]): Node[] {
  const collapsed = nodes.map((node) => ({
    group: node.group,
    children: collapseNodes(node.children),
  }));
  return collapsed
    .flatMap((node) =>
      // A group with one child restates that child. The child takes its place;
      // the wrapper is not rendered.
      node.children.length === 1 && node.group.clusters.length === 0
        ? node.children
        : [node],
    )
    .sort((a, b) => byGroupOrder(a.group, b.group));
}

export function collapseGroups(roots: Node[]): Node[] {
  let out = collapseNodes(roots);
  // One group holding everything frames the whole picture and says nothing the
  // board did not already say. This is a ROOT rule and only a root rule: an
  // inner group that happens to be its parent's only child is dissolved by the
  // single-child rule above, which keeps the child and drops the wrapper. Run
  // here it would do the opposite — keep the wrapper and dissolve the child —
  // which silently promotes a domain into the level below it.
  for (;;) {
    const only = out.length === 1 ? out[0] : undefined;
    if (only === undefined || only.children.length === 0) return out;
    out = only.children;
  }
}

/** Depth-first, parents before children — the order the wire list is read in. */
function flatten(nodes: Node[], parentKey: string | null): BoardGroup[] {
  return nodes.flatMap((node) => {
    node.group.parentKey = parentKey;
    return [node.group, ...flatten(node.children, node.group.key)];
  });
}

/**
 * Assemble the whole hierarchy: efforts, then up to two levels above them,
 * then the collapse pass, then a flat wire list.
 *
 * `programOf` and `domainOf` return the label a level assigned a child to, or
 * null when that level was not derived at all — which is what `basic` mode
 * does, and what a board too small to support another level does.
 */
export function buildHierarchy(options: {
  efforts: BoardGroup[];
  programOf?: (effort: BoardGroup) => string;
  programNames?: Record<string, NamedGroup>;
  domainOf?: (program: BoardGroup) => string;
  domainNames?: Record<string, NamedGroup>;
  grouped?: boolean;
  surfaceRules?: readonly SurfaceRule[];
}): BoardGroup[] {
  const grouped = options.grouped ?? true;
  const rules = options.surfaceRules ?? parseSurfaceRules(DEFAULT_SURFACE_RULES).rules;
  let level: Node[] = options.efforts.map((group) => ({ group, children: [] }));

  if (options.programOf !== undefined) {
    level = rollUp(level, "program", options.programOf, options.programNames ?? {}, grouped, rules);
    if (options.domainOf !== undefined) {
      level = rollUp(level, "domain", options.domainOf, options.domainNames ?? {}, grouped, rules);
    }
  }

  return flatten(collapseGroups(level), null);
}

/** Rebuild the tree a flat wire list encodes. Used by the renderer and the CLI. */
export function groupChildren<T extends { key: string; parentKey: string | null }>(
  groups: readonly T[],
): Map<string | null, T[]> {
  const byParent = new Map<string | null, T[]>();
  for (const group of groups) {
    const bucket = byParent.get(group.parentKey);
    if (bucket === undefined) byParent.set(group.parentKey, [group]);
    else bucket.push(group);
  }
  return byParent;
}

/** How many grouping levels the collapsed board actually has: 1, 2 or 3. */
export function hierarchyDepth(groups: readonly { level: GroupLevel }[]): number {
  return new Set(groups.map((group) => group.level)).size;
}

/**
 * Whether a cluster takes part in grouping, keyed on its pull request rather
 * than its ticket:
 * - `grouped`: a ticket, or no ticket but an OPEN pull request (a quick fix, a
 *   dependency bump). Seeded, asked about and placed like any other work.
 * - `finished`: no ticket and a merged or closed pull request. Real work, so
 *   it stays visible, but finished: no model is ever asked about it.
 * - `clone`: no ticket and no pull request, a checkout of some default branch.
 *   Not work; it stays in Unsorted.
 */
export type GroupingRole = "grouped" | "finished" | "clone";

export function groupingRole(cluster: Pick<Cluster, "units">): GroupingRole {
  if (cluster.units.some((unit) => unit.ticket !== null)) return "grouped";
  const prs = cluster.units.flatMap((unit) => (unit.pr === null ? [] : [unit.pr]));
  if (prs.length === 0) return "clone";
  return prs.some((pr) => pr.state !== "MERGED" && pr.state !== "CLOSED") ? "grouped" : "finished";
}

/**
 * Place every cluster on the board: its summary, and the effort it belongs to.
 * Pure, so the three modes — no keys, Jev, Jev plus Claude — are the same code
 * path with different inputs rather than three branches that can drift apart.
 */
export function placeClusters(options: {
  workstreams: Workstream[];
  decisionFor: (cluster: Cluster) => ClusterDecision | undefined;
  overrides: Record<string, string>;
  threshold: number;
  /** True once a model is available to assign clusters to efforts. */
  grouped: boolean;
}): { label: string; cluster: SummarizedCluster; fit: number }[] {
  const placed: { label: string; cluster: SummarizedCluster; fit: number }[] = [];
  for (const workstream of options.workstreams) {
    for (const cluster of workstream.clusters) {
      // A bare clone or a finished ticketless PR was never offered to a model,
      // so any decision cached for it from before is ignored, not trusted.
      const outside = groupingRole(cluster) !== "grouped";
      const decision = options.decisionFor(cluster);
      placed.push({
        label: effortLabel({
          ticket: cluster.ticket,
          override: options.overrides[cluster.ticket],
          assignment: outside ? null : (decision?.assignment ?? null),
          threshold: options.threshold,
          grouped: options.grouped && !outside,
          fallbackName: workstream.name,
        }),
        cluster: { ...cluster, summary: decision?.summary ?? fallbackSummary(cluster) },
        fit: decision?.assignment?.fit ?? 0,
      });
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// The Board's inbox: one row per checkout, sectioned by the NEXT ACTION.
//
// The Map's rule — position never follows status — is a rule about SPATIAL
// layout: a picture you navigate by memory must not reshuffle when a PR turns
// red. The Board is not a picture; it is a list you work through top to
// bottom, so here status is exactly what decides position. Everything below
// is pure and deterministic, so two refreshes that changed no work produce
// the same list in the same order.
// ---------------------------------------------------------------------------

export const INBOX_SECTIONS = [
  "fix",
  "respond",
  "merge",
  "waiting",
  "in-flight",
  "shipped",
  "parked",
] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

export const INBOX_SECTION_LABEL: Record<InboxSection, string> = {
  fix: "Fix",
  respond: "Respond",
  merge: "Merge",
  waiting: "Waiting",
  "in-flight": "In flight",
  shipped: "Recently shipped",
  parked: "Parked",
};

/** The first four are the work; the last three are context, folded away. */
export const INBOX_COLLAPSED: Record<InboxSection, boolean> = {
  fix: false,
  respond: false,
  merge: false,
  waiting: false,
  "in-flight": true,
  shipped: true,
  parked: true,
};

/** How long merged work stays under Recently shipped, in whole days, inclusive. */
export const RECENTLY_SHIPPED_DAYS = 7;

/** The facts section assignment reads. A wire unit and a board unit both fit. */
export type InboxUnitFacts = {
  ticket: string | null;
  lifecycle: Lifecycle;
  stack: { blockedBelow: number | null } | null;
  pr: { mergedAt?: string | null; mergeStateStatus?: MergeStateStatus } | null;
};

/**
 * A ticketless checkout with no pull request: a clone of some repo's default
 * branch. It is not work, so it is parked and hidden unless asked for.
 */
export function isTicketlessClone(unit: Pick<InboxUnitFacts, "ticket" | "pr">): boolean {
  return unit.ticket === null && unit.pr === null;
}

/**
 * The unmerged PR a row is waiting behind, or null. Only live work can be
 * behind something: a merged or closed PR has already left the merge order.
 */
export function waitingBehind(unit: Pick<InboxUnitFacts, "lifecycle" | "stack">): number | null {
  if (isDone(unit.lifecycle)) return null;
  return unit.stack?.blockedBelow ?? null;
}

function mergedWithin(mergedAt: string | null | undefined, now: number): boolean {
  if (mergedAt === null || mergedAt === undefined) return false;
  const at = Date.parse(mergedAt);
  if (Number.isNaN(at)) return false;
  return now - at <= RECENTLY_SHIPPED_DAYS * DAY_MS;
}

/**
 * The lifecycles an open, non-draft pull request can carry — the only ones a
 * merge conflict can pre-empt. `blocked` (red CI) is excluded on purpose:
 * step (b) below already outranks the conflict check in step (c), so a row
 * that is failing CI never needs to ask whether it is also DIRTY.
 */
const OPEN_PR_LIFECYCLES = new Set<Lifecycle>([
  "awaiting-followup",
  "approved-with-comments",
  "awaiting-merge",
  "awaiting-review",
]);

/**
 * Step (c) of the precedence below: GitHub reports a merge conflict. This
 * applies WHATEVER the review state — approved, comments open, changes
 * requested, still in review — because nothing else can happen until the
 * conflict is resolved.
 */
function hasUnresolvedConflict(unit: Pick<InboxUnitFacts, "lifecycle" | "pr">): boolean {
  return OPEN_PR_LIFECYCLES.has(unit.lifecycle) && unit.pr?.mergeStateStatus === "DIRTY";
}

/**
 * Step (d): once a PR is `awaiting-merge` (approved, green checks), GitHub's
 * mergeStateStatus decides whether "one button" really is all that's left.
 * CLEAN, HAS_HOOKS and UNSTABLE all mean nothing blocks the merge button.
 * BEHIND needs a branch update — still Merge, just a different button.
 * BLOCKED means branch protection itself is unsatisfied, which the reader
 * cannot clear by clicking merge, so it waits. UNKNOWN (including a value
 * GitHub hasn't reported yet) must never be read as ready, so it waits too.
 * DIRTY never reaches here: `hasUnresolvedConflict` already claimed it.
 */
function mergeReadiness(status: MergeStateStatus | undefined): { section: InboxSection; verb: string } {
  switch (status) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
      return { section: "merge", verb: "Ready to merge" };
    case "BEHIND":
      return { section: "merge", verb: "Update branch" };
    case "BLOCKED":
      return { section: "waiting", verb: "Blocked by branch rules" };
    case "DIRTY":
    case "UNKNOWN":
    default:
      return { section: "waiting", verb: "Checking mergeability" };
  }
}

/**
 * Which section a checkout is filed under, in PRECEDENCE order for an open,
 * non-draft pull request:
 *   a. stack position (`blockedBelow`) outranks everything else — an
 *      approved, green PR on top of an unmerged one has nothing for the
 *      reader to do yet, whatever its own state.
 *   b. CI failing (`blocked`) — a fix is needed before anything else.
 *   c. a merge conflict (`hasUnresolvedConflict`) — see its own comment.
 *   d. `awaiting-merge` splits by mergeStateStatus (`mergeReadiness`).
 *   e. everything else is unchanged from before mergeStateStatus existed.
 * A ticketless clone is parked whatever it looks like, checked first because
 * none of the above applies to something that is not a pull request.
 */
export function inboxSection(unit: InboxUnitFacts, now: number): InboxSection {
  if (isTicketlessClone(unit)) return "parked";
  if (waitingBehind(unit) !== null) return "waiting";
  if (unit.lifecycle === "blocked") return "fix";
  if (hasUnresolvedConflict(unit)) return "fix";
  switch (unit.lifecycle) {
    case "awaiting-followup":
    case "approved-with-comments":
      return "respond";
    case "awaiting-merge":
      return mergeReadiness(unit.pr?.mergeStateStatus).section;
    case "awaiting-review":
      return "waiting";
    case "active":
    case "in-progress":
      return "in-flight";
    case "shipped":
    case "merged":
      return mergedWithin(unit.pr?.mergedAt, now) ? "shipped" : "parked";
    case "up-next":
    case "closed":
      return "parked";
  }
}

const VERB: Partial<Record<Lifecycle, string>> = {
  blocked: "CI failing",
  "awaiting-followup": "Changes requested",
  "approved-with-comments": "Approved, comments open",
  "awaiting-review": "In review",
  active: "Editing",
  "in-progress": "In progress",
  shipped: "Shipped",
  merged: "Merged",
};

/**
 * The row's action verb, in the words of the section it sits in. Parked rows
 * get none: there is nothing to do with them, and a verb would say otherwise.
 * Mirrors the precedence in `inboxSection`: stack position, then a conflict,
 * then (for `awaiting-merge`) `mergeReadiness`, then the plain lifecycle verb.
 */
export function inboxVerb(unit: InboxUnitFacts, section: InboxSection): string | null {
  if (section === "parked") return null;
  const behind = waitingBehind(unit);
  if (behind !== null) return `Behind #${behind}`;
  if (hasUnresolvedConflict(unit)) return "Resolve conflicts";
  if (unit.lifecycle === "awaiting-merge") return mergeReadiness(unit.pr?.mergeStateStatus).verb;
  return VERB[unit.lifecycle] ?? null;
}

// ---- age in state ----------------------------------------------------------

/** One unit's row in the persisted transition table. */
export type Transition = {
  lifecycle: Lifecycle;
  /**
   * When the unit was SEEN to enter `lifecycle`, or null when it was already
   * there the first time it was scanned. Null is an honest "unknown", never a
   * guess: the first scan cannot know how long a PR had been red.
   */
  enteredAt: number | null;
};

/**
 * Advance the transition table by one scan. Entering a state records the
 * time; staying keeps it; changing resets it. A unit seen for the first time
 * is recorded with an unknown entry time, and a unit that left the scan drops
 * out of the table.
 */
export function trackTransitions(
  previous: ReadonlyMap<string, Transition>,
  current: readonly { path: string; lifecycle: Lifecycle }[],
  now: number,
): Map<string, Transition> {
  const next = new Map<string, Transition>();
  for (const unit of current) {
    const before = previous.get(unit.path);
    if (before === undefined) next.set(unit.path, { lifecycle: unit.lifecycle, enteredAt: null });
    else if (before.lifecycle === unit.lifecycle) next.set(unit.path, before);
    else next.set(unit.path, { lifecycle: unit.lifecycle, enteredAt: now });
  }
  return next;
}

/**
 * How long a row has been where it is, and on what evidence. `state` is an
 * observed transition (or, for merged work, GitHub's own merge time);
 * `last-commit` is a PROXY and is always labelled as one. `since` is null only
 * when there is no evidence at all.
 */
export type StateAge = { since: number | null; basis: "state" | "last-commit" };

export function stateAge(
  unit: {
    lifecycle: Lifecycle;
    lastCommitAt: string | null;
    enteredAt: string | null;
    pr: { mergedAt?: string | null } | null;
  },
): StateAge {
  const parse = (value: string | null | undefined) => {
    if (value === null || value === undefined) return null;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  };
  const entered = parse(unit.enteredAt);
  if (entered !== null) return { since: entered, basis: "state" };
  // The merge time IS the moment a PR entered `merged`. It is not when a
  // release tag later made it `shipped`, so it is used for `merged` alone.
  const merged = unit.lifecycle === "merged" ? parse(unit.pr?.mergedAt) : null;
  if (merged !== null) return { since: merged, basis: "state" };
  return { since: parse(unit.lastCommitAt), basis: "last-commit" };
}

/** Compact whole units: "45m", "5h", "12d". Never negative. */
export function compactAge(since: number, now: number): string {
  const ms = Math.max(0, now - since);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/** The age as the row prints it. A proxy says so in words. */
export function ageLabel(age: StateAge, now: number): string {
  if (age.since === null) return age.basis === "state" ? "" : "no commit date";
  const text = compactAge(age.since, now);
  return age.basis === "state" ? text : `last commit ${text}`;
}

/**
 * "scanned 3m ago" for the header: under a minute is "just now", then the
 * same whole units as `compactAge`. An unreadable time says so rather than
 * inventing one; a time in the future (clock skew) reads as just now.
 */
export function relativeTime(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "unknown";
  return now - at < 60_000 ? "just now" : `${compactAge(at, now)} ago`;
}

// ---- rows and ordering -----------------------------------------------------

/** What ordering and search read about a row. */
export type InboxOrderFacts = {
  repo: string;
  prNumber: number | null;
  path: string;
  since: number | null;
};

/**
 * Oldest in state first — the most stuck on top — then repo, then PR number,
 * then path, so the order is total and a refresh that changed nothing moves
 * nothing. A row with no evidence of age at all is treated as the oldest,
 * the same way `stalenessOf` reads an unreadable date as dead.
 */
export function byInboxOrder(a: InboxOrderFacts, b: InboxOrderFacts): number {
  const since = (value: number | null) => value ?? Number.NEGATIVE_INFINITY;
  return (
    since(a.since) - since(b.since) ||
    a.repo.localeCompare(b.repo) ||
    (a.prNumber ?? Number.POSITIVE_INFINITY) - (b.prNumber ?? Number.POSITIVE_INFINITY) ||
    a.path.localeCompare(b.path)
  );
}

/** Case-insensitive substring over ticket, title, repo and effort. */
export function matchesInboxQuery(
  row: { ticket: string | null; title: string; repo: string; effort: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [row.ticket ?? "", row.title, row.repo, row.effort].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

// ---- starting a thread -----------------------------------------------------

/** The facts a thread prompt is written from. */
export type PromptFacts = {
  repo: string;
  prNumber: number | null;
  title: string | null;
  branch: string | null;
  path: string;
};

/**
 * The prefilled prompt for "start a thread", by section. The user edits it
 * before anything runs; a missing PR or branch is said plainly rather than
 * leaving a hole in the sentence.
 */
export function threadPrompt(section: InboxSection, facts: PromptFacts): string {
  const pr = facts.prNumber === null ? `${facts.repo} (no pull request)` : `${facts.repo} #${facts.prNumber}`;
  const title = facts.title === null || facts.title.trim() === "" ? "" : ` (${facts.title.trim()})`;
  const branch = facts.branch === null ? "no branch checked out" : `branch ${facts.branch}`;
  const where = `${pr}${title}, ${branch}, checkout ${facts.path}`;
  if (section === "fix") return `CI is failing on ${where}. Investigate the failure and propose a fix.`;
  if (section === "respond") {
    return `Review feedback is waiting on ${where}. Read the review comments and address them.`;
  }
  return `Pick up ${where}.`;
}
