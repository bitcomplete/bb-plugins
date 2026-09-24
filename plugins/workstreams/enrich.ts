// The one place a model is allowed to decide anything.
//
// Two jobs, both of them judgment calls code cannot make:
//   1. Jev picks which of a cluster's own pull request titles best represents
//      it, and which candidate effort it belongs to, and scores that fit.
//   2. Claude renames an effort with a written category name.
//
// Everything else — counting, sorting, rollup sentences, candidate grouping,
// hashing, the confidence cut — is deterministic and lives in workstreams.ts.
// This module is written against narrow interfaces rather than the SDKs so the
// decision logic can be tested without a network or an API key.
import type { GroupNaming, GroupLevel } from "./contract.js";
import {
  NAME_WORDS,
  clusterInputHash,
  memberHash,
  fallbackSummary,
  groupingRole,
  normalizeSummary,
  seedGroups,
  seedItems,
  namingCandidates as namingCandidatesFor,
  summaryChoices,
  wordCount,
  type Cluster,
  type ClusterDecision,
  type Cohesion,
  type NamedGroup,
  type SeedContext,
  type SeedItem,
} from "./workstreams.js";

/** Only the answer shapes this plugin asks for. */
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "noul"; noul: number };

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: readonly [string, string, ...string[]] };

/** The slice of `TypeSafeClient` this plugin uses. */
export type JevClient = {
  ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
  ): Promise<{
    answers: Record<string, JevAnswer>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
};

/** The slice of the host's Claude call this plugin uses. */
export type NamingClient = {
  name(
    level: GroupLevel,
    groups: GroupNaming[],
  ): Promise<{
    names: { label: string; name: string; cohesion: Cohesion["verdict"]; reason: string | null }[];
    warnings: string[];
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
};

export type ModelUsage = { calls: number; inputTokens: number; outputTokens: number };

export const ZERO_USAGE: ModelUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/**
 * A five-level rubric, normalized to the 0-1 range the threshold setting is
 * expressed in. Levels, not a free-form number, because that is the only shape
 * Jev's `score` takes.
 */
const FIT_RUBRIC = [
  "Unrelated. The cluster shares no subject with the effort.",
  "Weak. It touches an adjacent area but is a different piece of work.",
  "Plausible. It could belong, but the connection is incidental.",
  "Good. It is part of the same body of work.",
  "Certain. It is unmistakably one piece of this effort.",
] as const satisfies readonly [string, string, ...string[]];

function normalizeFit(score: number): number {
  const top = FIT_RUBRIC.length - 1;
  return Math.max(0, Math.min(1, score / top));
}

/** Candidate efforts, keyed by a label stable across rescans. */
export type Candidate = { label: string; description: string; members: Cluster[] };

/**
 * Turn the deterministic seed groups into labelled candidates. The label is a
 * cache key, not a display name: it only has to be stable and unique, so it is
 * derived from a member's own pull request title rather than invented.
 */
export function candidatesFrom(clusters: Cluster[], context: SeedContext = {}): Candidate[] {
  const used = new Set<string>();
  // Only what can be placed in an effort seeds one: a bare clone or a finished
  // ticketless PR would hold a candidate slot nothing could ever be placed in.
  const grouped = clusters.filter((cluster) => groupingRole(cluster) === "grouped");
  return seedGroups(grouped, context).map((members) => {
    const base = fallbackSummary(members[0] as Cluster);
    let label = base;
    for (let suffix = 2; used.has(label); suffix += 1) label = `${base} (${suffix})`;
    used.add(label);
    return {
      label,
      description: members
        .map((cluster) => `${cluster.ticket}: ${fallbackSummary(cluster)}`)
        .join("; ")
        .slice(0, 500),
      members,
    };
  });
}

function clusterState(cluster: Cluster) {
  const linear = cluster.linear;
  return {
    ticket: cluster.ticket,
    repos: [...new Set(cluster.units.map((unit) => unit.repo ?? unit.dirName))],
    prTitles: cluster.units.flatMap((unit) => (unit.pr === null ? [] : [unit.pr.title])),
    // Only when known, so a board with no Linear sends exactly what it always did.
    ...(linear === undefined || linear === null
      ? {}
      : { linear: { title: linear.title, project: linear.project, parent: linear.parentTitle ?? linear.parentIdentifier } }),
  };
}

const BATCH = 8;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export type JevRequest = {
  /** Clusters whose cached decision is missing or stale. Others cost nothing. */
  pending: Cluster[];
  candidates: Candidate[];
  jev: JevClient;
};

export type JevOutcome = {
  decisions: Map<string, ClusterDecision>;
  warnings: string[];
  usage: ModelUsage;
};

/**
 * Ask Jev about every stale cluster, batched. One call per cluster would
 * multiply the cost of a board by its size for no extra signal, so a batch
 * shares one state payload and carries one question set per cluster.
 */
export async function decideWithJev(request: JevRequest): Promise<JevOutcome> {
  const decisions = new Map<string, ClusterDecision>();
  const warnings: string[] = [];
  const usage: ModelUsage = { ...ZERO_USAGE };
  if (request.pending.length === 0 || request.candidates.length === 0) {
    return { decisions, warnings, usage };
  }

  const labels = Object.fromEntries(
    request.candidates.map((candidate) => [candidate.label, candidate.description]),
  );

  for (const batch of chunk(request.pending, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    const slots = batch.map((cluster, index) => {
      const key = `c${index}`;
      const titles = summaryChoices(cluster);
      // With one candidate there is nothing to choose; code already has the
      // answer, so asking would be spending a model call on a known result.
      if (titles.length > 1) {
        questions[`${key}_summary`] = {
          type: "choice",
          instructions: `Which title best describes all of the work in ${cluster.ticket}?`,
          criteria: Object.fromEntries(titles.map((title) => [title, null])),
        };
      }
      if (request.candidates.length > 1) {
        questions[`${key}_effort`] = {
          type: "choice",
          instructions: `Which effort does ${cluster.ticket} belong to?`,
          criteria: labels,
        };
      }
      questions[`${key}_fit`] = {
        type: "score",
        instructions: `How well does ${cluster.ticket} fit the effort you chose for it?`,
        criteria: FIT_RUBRIC,
      };
      return { key, cluster, titles };
    });

    let answers: Record<string, JevAnswer>;
    try {
      const result = await request.jev.ask(
        {
          clusters: batch.map(clusterState),
          efforts: request.candidates.map((candidate) => ({
            label: candidate.label,
            members: candidate.members.map((cluster) => cluster.ticket),
          })),
        },
        questions,
      );
      answers = result.answers;
      usage.calls += 1;
      usage.inputTokens += result.usage.input_tokens;
      usage.outputTokens += result.usage.output_tokens;
    } catch (error) {
      // A Jev outage keeps every previous decision; it never fails a scan.
      warnings.push(`Jev grouping failed: ${String(error).slice(0, 200)}`);
      usage.calls += 1;
      return { decisions, warnings, usage };
    }

    for (const slot of slots) {
      const chosen = answers[`${slot.key}_summary`];
      const picked =
        chosen?.type === "choice" && slot.titles.includes(chosen.choice)
          ? normalizeSummary(chosen.choice)
          : null;
      const effort = answers[`${slot.key}_effort`];
      const label =
        effort?.type === "choice" && effort.choice in labels
          ? effort.choice
          : (request.candidates[0]?.label ?? null);
      const fit = answers[`${slot.key}_fit`];
      decisions.set(clusterInputHash(slot.cluster), {
        summary: picked ?? (slot.titles.length === 1 ? (slot.titles[0] ?? null) : null),
        assignment:
          label === null || fit?.type !== "score"
            ? null
            : { label, fit: normalizeFit(fit.score) },
      });
    }
  }

  return { decisions, warnings, usage };
}

// ---- assignment one rung up -----------------------------------------------
//
// Efforts into programs, programs into domains. The SAME two questions Jev
// already answers for clusters — which candidate, and how well does it fit —
// asked over a different set of members. Reusing the machinery is what keeps
// the third level from becoming a second grouping mechanism with its own bugs.

/** One thing to be placed, at whatever level. */
export type Assignable = { key: string; name: string; description: string };

export type AssignRequest = {
  /** Items whose cached assignment is missing or stale. Others cost nothing. */
  pending: Assignable[];
  candidates: { label: string; members: string[] }[];
  jev: JevClient;
  /** Only for the log line, so per-level spend is reportable separately. */
  level: GroupLevel;
};

export type AssignOutcome = {
  /** item key → the label it was assigned to, with its normalized 0-1 fit. */
  assignments: Map<string, { label: string; fit: number }>;
  warnings: string[];
  usage: ModelUsage;
};

export async function assignToCandidates(
  request: AssignRequest,
): Promise<AssignOutcome> {
  const assignments = new Map<string, { label: string; fit: number }>();
  const warnings: string[] = [];
  const usage: ModelUsage = { ...ZERO_USAGE };
  // With one candidate there is nothing to choose, so asking would be spending
  // a model call on a known result.
  if (request.pending.length === 0 || request.candidates.length < 2) {
    return { assignments, warnings, usage };
  }

  const labels = Object.fromEntries(
    request.candidates.map((candidate) => [
      candidate.label,
      candidate.members.join("; ").slice(0, 500),
    ]),
  );

  for (const batch of chunk(request.pending, BATCH)) {
    const questions: Record<string, JevQuestion> = {};
    const slots = batch.map((item, index) => {
      const key = `g${index}`;
      questions[`${key}_group`] = {
        type: "choice",
        instructions: `Which ${request.level} does "${item.name}" belong to?`,
        criteria: labels,
      };
      questions[`${key}_fit`] = {
        type: "score",
        instructions: `How well does "${item.name}" fit the ${request.level} you chose for it?`,
        criteria: FIT_RUBRIC,
      };
      return { key, item };
    });

    let answers: Record<string, JevAnswer>;
    try {
      const result = await request.jev.ask(
        {
          items: batch.map((item) => ({ name: item.name, contains: item.description })),
          [`${request.level}s`]: request.candidates,
        },
        questions,
      );
      answers = result.answers;
      usage.calls += 1;
      usage.inputTokens += result.usage.input_tokens;
      usage.outputTokens += result.usage.output_tokens;
    } catch (error) {
      // An outage keeps every previous assignment; it never fails a scan.
      warnings.push(`Jev ${request.level} grouping failed: ${String(error).slice(0, 200)}`);
      usage.calls += 1;
      return { assignments, warnings, usage };
    }

    for (const slot of slots) {
      const chosen = answers[`${slot.key}_group`];
      const fit = answers[`${slot.key}_fit`];
      if (chosen?.type !== "choice" || !(chosen.choice in labels)) continue;
      if (fit?.type !== "score") continue;
      assignments.set(slot.item.key, {
        label: chosen.choice,
        fit: normalizeFit(fit.score),
      });
    }
  }

  return { assignments, warnings, usage };
}

/** One member of a level that is about to be seeded and assigned. */
export type LevelMember = {
  /** The member hash this level's assignment and name cache under. */
  key: string;
  /**
   * The member's STABLE identity (its group key), which candidate labels are
   * built from. Never its display name: a rename one level down must not make
   * a label vanish one level up and force every member under it to be re-asked.
   */
  id: string;
  /** Display name, which is also what the model is shown. */
  name: string;
  item: SeedItem;
  description: string;
};

/**
 * Deterministic candidate groups for the level ABOVE these members, using the
 * same agglomerative seeding the cluster level uses. The label is a cache key
 * rather than a display name: it only has to be stable and unique, so it is the
 * smallest stable id among the candidate's members — unique because candidate
 * groups are disjoint, and unchanged by any rename.
 */
export function seedAssignables(
  members: readonly LevelMember[],
): { label: string; members: string[] }[] {
  const byKey = new Map(members.map((member) => [member.item.key, member]));
  const used = new Set<string>();
  return seedItems(members.map((member) => member.item)).map((keys) => {
    const found = keys.flatMap((key) => {
      const member = byKey.get(key);
      return member === undefined ? [] : [member];
    });
    const base = found.map((member) => member.id).sort((a, b) => a.localeCompare(b))[0] ?? keys[0] ?? "Group";
    let label = base;
    for (let suffix = 2; used.has(label); suffix += 1) label = `${base} (${suffix})`;
    used.add(label);
    return { label, members: found.map((member) => member.name) };
  });
}

// ---- naming, with the cohesion verdict that rides along --------------------

export type GroupNameRequest = {
  level: GroupLevel;
  /** label → the members currently assigned to it. */
  groups: Map<string, { ticket: string; summary: string; repos: string[] }[]>;
  /** label → the member hash its name and verdict are cached under. */
  hashOf: (label: string) => string;
  /** Member hash → name and verdict already paid for. */
  cached: (memberHash: string) => NamedGroup | undefined;
  /** Phrases the name may be drawn from, Linear projects among them. */
  candidatesFor: (label: string) => string[];
  /** Context for the name, never a name: Linear titles, parents, projects, thread titles. */
  contextFor?: (label: string) => string[];
  naming: NamingClient;
};

export type GroupNameOutcome = {
  /** Member hash → what the caller should persist. */
  names: Map<string, NamedGroup>;
  warnings: string[];
  usage: ModelUsage;
};

/**
 * Name only the groups whose member set changed. A group that gained and lost
 * nothing since the last scan is already named AND already judged, so it costs
 * nothing — which is what keeps an unchanged rescan free at every level, not
 * just at the bottom one. The verdict is cached beside the name and therefore
 * goes stale at exactly the moment the name does.
 */
export async function nameGroups(
  request: GroupNameRequest,
): Promise<GroupNameOutcome> {
  const names = new Map<string, NamedGroup>();
  const stale: GroupNaming[] = [];
  const hashes = new Map<string, string>();

  for (const [label, members] of request.groups) {
    const hash = request.hashOf(label);
    hashes.set(label, hash);
    if (request.cached(hash) !== undefined) continue;
    const context = request.contextFor?.(label) ?? [];
    stale.push({
      label,
      members: members.slice(0, 30),
      candidates: request.candidatesFor(label),
      // Omitted when empty, so a board with no Linear and no threads sends what it always did.
      ...(context.length === 0 ? {} : { context }),
    });
  }

  if (stale.length === 0) return { names, warnings: [], usage: { ...ZERO_USAGE } };

  const result = await request.naming.name(request.level, stale);
  const budget = NAME_WORDS[request.level];
  for (const entry of result.names) {
    const hash = hashes.get(entry.label);
    if (hash === undefined) continue;
    const name = normalizeSummary(entry.name);
    const words = name === null ? 0 : wordCount(name);
    const usable = name !== null && words >= budget.min && words <= budget.max;
    names.set(hash, {
      // A name outside this level's word window is worse than the phrase it
      // would replace, so it is dropped — but the ANSWER is still cached, as
      // an empty name that callers fall back from. Caching only the successes
      // would re-ask about every rejected group on every single scan, which is
      // precisely the "unchanged rescan costs nothing" promise it would break.
      name: usable && name !== null ? name : "",
      cohesion: {
        verdict: entry.cohesion,
        reason: entry.cohesion === "mixed" ? entry.reason : null,
      },
    });
  }
  // A label the call omitted entirely was still paid for. Record it, so the
  // next scan does not pay for it again on the chance of a different answer.
  for (const group of stale) {
    const hash = hashes.get(group.label);
    if (hash !== undefined && !names.has(hash)) names.set(hash, { name: "", cohesion: null });
  }
  return {
    names,
    warnings: result.warnings,
    usage: {
      calls: result.calls,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
  };
}

/** v3's effort-level entry point, expressed through the generic one. */
export type EffortNameRequest = {
  efforts: Map<string, Cluster[]>;
  cachedName: (memberHash: string) => NamedGroup | undefined;
  summaryOf: (cluster: Cluster) => string;
  linearProjectOf?: (cluster: Cluster) => string | null;
  /** Per-cluster naming context; see `GroupNameRequest.contextFor`. */
  contextOf?: (cluster: Cluster) => string[];
  naming: NamingClient;
};

export async function nameEfforts(
  request: EffortNameRequest,
): Promise<GroupNameOutcome> {
  const clustersOf = new Map(request.efforts);
  return nameGroups({
    level: "effort",
    groups: new Map(
      [...clustersOf].map(([label, clusters]) => [
        label,
        clusters.map((cluster) => ({
          ticket: cluster.ticket,
          summary: request.summaryOf(cluster),
          repos: [...new Set(cluster.units.map((unit) => unit.repo ?? unit.dirName))],
        })),
      ]),
    ),
    hashOf: (label) =>
      memberHash("effort", (clustersOf.get(label) ?? []).map(clusterInputHash)),
    cached: request.cachedName,
    candidatesFor: (label) => {
      const clusters = clustersOf.get(label) ?? [];
      return namingCandidatesFor(
        clusters.map((cluster) => request.summaryOf(cluster)),
        clusters.map((cluster) => request.linearProjectOf?.(cluster) ?? null),
      );
    },
    contextFor: (label) => namingContext((clustersOf.get(label) ?? []).flatMap((cluster) => request.contextOf?.(cluster) ?? [])),
    naming: request.naming,
  });
}


/** The most context lines one group's naming call carries. */
export const CONTEXT_LINES = 20;

/** Unique, trimmed, bounded naming context lines. */
export function namingContext(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.replace(/\s+/gu, " ").trim().slice(0, 300);
    if (text !== "") seen.add(text);
  }
  return [...seen].slice(0, CONTEXT_LINES);
}

/**
 * One cluster's naming context: its Linear ticket title, parent and project,
 * and the titles of the threads strongly linked to it. Labelled, so the model
 * reads each as what it is rather than as a candidate name.
 */
export function clusterContext(cluster: Cluster, threadTitles: readonly string[] = []): string[] {
  const linear = cluster.linear;
  const lines: string[] = [];
  if (linear !== undefined && linear !== null) {
    if (linear.title !== null) lines.push(`Linear ${cluster.ticket}: ${linear.title}`);
    const parent = linear.parentTitle ?? linear.parentIdentifier;
    if (parent !== null) lines.push(`Linear parent: ${parent}`);
    if (linear.project !== null) lines.push(`Linear project: ${linear.project}`);
  }
  for (const title of threadTitles) lines.push(`Thread: ${title}`);
  return lines;
}
