// Review uncertain membership separately from naming. Shared context is sent
// once per bounded neighborhood; models judge relationships, code partitions.
import { ZERO_USAGE, type JevClient, type JevQuestion, type ModelUsage } from "./enrich.js";
import { areaProfile, clusterInputHash, groupingRole, hashString, type Cluster, type SeedContext } from "./workstreams.js";

export type RepairGroup = { id: string; members: Cluster[]; mixed: boolean; locked: boolean };
export type PathThread = { id: string; title: string; clusters: readonly string[] };
type RepairItem = {
  id: string;
  titles: string[];
  linear: { title: string | null; parent: string | null; project: string | null } | null;
  areas: string[];
  threads: string[];
  pathThreads: { id: string; title: string }[];
};
export type RepairJob = { revision: string; items: RepairItem[]; evidence: Record<string, string> };
export type RepairPartition = { revision: string; members: string[][]; evidence: Record<string, string> };
export const REPAIR_LIMITS = { members: 12, jobs: 4, pathThreadSpan: 8 } as const;
const VERSION = "outcome-membership-v2";
const GENERIC_WORDS = new Set(["work", "working", "changes", "change", "project", "issue", "ticket", "address", "ensure", "review", "bump", "update", "updates", "support", "build", "builds", "setup", "from", "with", "when", "that", "this", "into", "using", "allow", "prevent", "across"]);
const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => (word.length >= 4 || word === "ci" || word === "ota") && !/^\d+$/u.test(word) && !GENERIC_WORDS.has(word)));
const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].filter((word) => b.has(word)).length;

/** Only supported, uncertain work enters a review; established membership is locked. */
export function planGroupingRepair(input: {
  groups: readonly RepairGroup[];
  context?: SeedContext;
  pathThreads?: readonly PathThread[];
  reviewed?: ReadonlyMap<string, string>;
}): { jobs: RepairJob[]; warnings: string[] } {
  const groups = input.groups.filter((group) => !group.locked).map((group) => ({ ...group, members: group.members.filter((cluster) => groupingRole(cluster) === "grouped") }));
  const clusters = new Map(groups.flatMap((group) => group.members.map((cluster) => [cluster.ticket, cluster] as const)));
  const meaningful = new Set(input.groups.flatMap((group) => group.members.filter((cluster) => groupingRole(cluster) === "grouped").map((cluster) => cluster.ticket)));
  const vocabulary = new Map([...clusters].map(([id, cluster]) => [id, words([cluster.linear?.title ?? "", ...cluster.units.map((unit) => unit.pr?.title ?? "")].join(" "))]));
  const pathLinks = new Map<string, PathThread[]>();
  for (const thread of input.pathThreads ?? []) {
    const members = [...new Set(thread.clusters)].filter((id) => meaningful.has(id));
    if (members.length < 2 || members.length > REPAIR_LIMITS.pathThreadSpan) continue;
    const subject = words(thread.title);
    for (const id of members) {
      if (!clusters.has(id)) continue;
      if (overlap(subject, vocabulary.get(id) ?? new Set()) === 0) continue;
      pathLinks.set(id, [...(pathLinks.get(id) ?? []), thread]);
    }
  }
  const items = new Map([...clusters].map(([id, cluster]): [string, RepairItem] => [id, {
    id,
    titles: [...new Set(cluster.units.flatMap((unit) => unit.pr === null ? [] : [unit.pr.title]))].sort().slice(0, 4).map((title) => title.slice(0, 180)),
    linear: cluster.linear == null ? null : { title: cluster.linear.title?.slice(0, 180) ?? null, parent: cluster.linear.parentIdentifier ?? cluster.linear.parentTitle, project: cluster.linear.project },
    areas: [...areaProfile(cluster).keys()].sort().slice(0, 6),
    threads: [...(input.context?.threads?.get(id) ?? new Map()).keys()].sort(),
    pathThreads: (pathLinks.get(id) ?? []).map(({ id: threadId, title }) => ({ id: threadId, title: title.slice(0, 180) })).sort((a, b) => a.id.localeCompare(b.id)),
  }]));
  const related = (a: string, b: string): boolean => {
    const left = items.get(a)!;
    const right = items.get(b)!;
    if (left.linear?.parent != null && left.linear.parent === right.linear?.parent) return true;
    if (left.threads.some((id) => right.threads.includes(id))) return true;
    if (left.pathThreads.some(({ id }) => right.pathThreads.some((thread) => thread.id === id))) return true;
    const av = vocabulary.get(a)!;
    const bv = vocabulary.get(b)!;
    const shared = overlap(av, bv);
    return shared >= 2 && shared / (av.size + bv.size - shared) >= 0.3;
  };
  const ordered = [...clusters.keys()].sort();
  // A repaired partition changes presentation, not the evidence. Fingerprints
  // deliberately exclude group identity and mixed/cohesive verdicts.
  const fingerprints = new Map(ordered.map((id) => [id, hashString(JSON.stringify([
    VERSION,
    clusterInputHash(clusters.get(id)!),
    items.get(id),
    ordered.filter((other) => other !== id && related(id, other)).map((other) => [clusterInputHash(clusters.get(other)!), items.get(other)]),
  ]))]));
  const singles = new Set(groups.filter((group) => group.members.length === 1).flatMap((group) => group.members.map((cluster) => cluster.ticket)));
  const seeds = groups.filter((group) => group.mixed && group.members.length > 1).sort((a, b) => a.id.localeCompare(b.id)).map((group) => group.members.map((cluster) => cluster.ticket).sort());
  seeds.push(...ordered.filter((id) => singles.has(id)).map((id) => [id]));
  const neighborhood = (seed: string[], unavailable: ReadonlySet<string>) => {
    const found = new Set(seed);
    for (;;) {
      const next = ordered.filter((id) => singles.has(id) && !found.has(id) && !unavailable.has(id) && [...found].some((member) => related(member, id)));
      if (next.length === 0) return [...found].sort();
      for (const id of next) found.add(id);
    }
  };
  const openCount = (seed: string[]) => neighborhood(seed, new Set()).reduce((sum, id) => sum + (clusters.get(id)?.units.filter((unit) => unit.pr?.state === "OPEN").length ?? 0), 0);
  const priority = new Map(seeds.map((seed) => [seed, openCount(seed)]));
  seeds.sort((a, b) => priority.get(b)! - priority.get(a)!);
  const used = new Set<string>();
  const jobs: RepairJob[] = [];
  const warnings: string[] = [];
  let deferred = 0;
  for (const seed of seeds) {
    if (seed.some((id) => used.has(id))) continue;
    if (seed.length > REPAIR_LIMITS.members) {
      warnings.push(`Membership review deferred for ${seed.length} items: the neighborhood limit is ${REPAIR_LIMITS.members}.`);
      for (const id of seed) used.add(id);
      continue;
    }
    const ids = neighborhood(seed, used);
    if (ids.length > REPAIR_LIMITS.members) {
      warnings.push(`Membership review deferred a ${ids.length}-item neighborhood; no partial review was marked complete.`);
      for (const id of ids) used.add(id);
      continue;
    }
    if (ids.length < 2 || ids.every((id) => input.reviewed?.get(id) === fingerprints.get(id))) continue;
    if (jobs.length >= REPAIR_LIMITS.jobs) { for (const id of ids) used.add(id); deferred += 1; continue; }
    for (const id of ids) used.add(id);
    const evidence = Object.fromEntries(ids.map((id) => [id, fingerprints.get(id)!]));
    jobs.push({ revision: hashString(JSON.stringify([VERSION, evidence])), items: ids.map((id) => items.get(id)!), evidence });
  }
  if (deferred > 0) warnings.push(`Membership review deferred ${deferred} neighborhoods after the ${REPAIR_LIMITS.jobs}-job limit.`);
  return { jobs, warnings };
}

const RUBRIC = [
  "Unrelated goals.",
  "Only the same broad area, repository, project, or thread; the work advances separate goals.",
  "Possibly related, but a shared bounded goal or coordinated improvement is not established.",
  "Good evidence of one bounded goal or improvement campaign. Matching PR purposes corroborate a focused thread goal, including complementary or repeated changes across repositories.",
  "Explicitly one coordinated improvement campaign or exact issue, with matching implementation purposes across its parts.",
] as const;

function repairQuestions(items: readonly RepairItem[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (let a = 0; a < items.length; a += 1) for (let b = a + 1; b < items.length; b += 1) {
    questions[`p${a}_${b}`] = { type: "score", instructions: `Do ${items[a]!.id} and ${items[b]!.id} advance the same bounded user goal or coordinated improvement? Repeating matching changes across repositories can be one effort even when each PR delivers a different implementation. A focused thread's stated goal, corroborated by matching PR purposes, is positive evidence. Shared areas, projects, or thread mentions without matching purpose are insufficient.`, criteria: RUBRIC };
  }
  return questions;
}

/** Request size is inspectable before spending any tokens. */
export function repairRequestEstimate(jobs: readonly RepairJob[]) {
  return {
    calls: jobs.length,
    scoreQuestions: jobs.reduce((sum, job) => sum + job.items.length * (job.items.length - 1) / 2, 0),
    contextBytes: jobs.reduce((sum, job) => sum + new TextEncoder().encode(JSON.stringify(job.items)).length, 0),
    requestJsonBytes: jobs.reduce((sum, job) => sum + new TextEncoder().encode(JSON.stringify({ state: { items: job.items }, questions: repairQuestions(job.items) })).length, 0),
  };
}

export async function reviewGroupingRepair(input: { jobs: readonly RepairJob[]; jev: JevClient }): Promise<{ partitions: RepairPartition[]; usage: ModelUsage; warnings: string[] }> {
  const partitions: RepairPartition[] = [];
  const usage = { ...ZERO_USAGE };
  const warnings: string[] = [];
  for (const job of input.jobs.slice(0, REPAIR_LIMITS.jobs)) {
    const ids = job.items.map((item) => item.id);
    if (ids.length < 2 || ids.length > REPAIR_LIMITS.members || new Set(ids).size !== ids.length) {
      warnings.push("Membership review skipped an invalid neighborhood.");
      continue;
    }
    const pairs: { key: string; left: string; right: string }[] = [];
    const questions = repairQuestions(job.items);
    for (let a = 0; a < ids.length; a += 1) for (let b = a + 1; b < ids.length; b += 1) {
      const key = `p${a}_${b}`;
      pairs.push({ key, left: ids[a]!, right: ids[b]! });
    }
    try {
      usage.calls += 1;
      const response = await input.jev.ask({ items: job.items }, questions);
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      // Jev returns the expected value across rubric levels, not a selected
      // integer level. Fractional scores are valid; malformed/out-of-range ones
      // must still leave the entire previous partition intact.
      if (pairs.some(({ key }) => { const answer = response.answers[key]; return answer?.type !== "score" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4; })) {
        warnings.push("Membership review returned incomplete scores; previous membership was retained.");
        continue;
      }
      const scores = new Map(pairs.map(({ key, left, right }) => { const answer = response.answers[key]!; return [JSON.stringify([left, right].sort()), answer.type === "score" ? answer.score : 0] as const; }));
      const members = ids.map((id) => [id]).sort((a, b) => a[0]!.localeCompare(b[0]!));
      for (;;) {
        let best: { left: number; right: number; score: number } | undefined;
        for (let a = 0; a < members.length; a += 1) for (let b = a + 1; b < members.length; b += 1) {
          const score = Math.min(...members[a]!.flatMap((left) => members[b]!.map((right) => scores.get(JSON.stringify([left, right].sort())) ?? 0)));
          if (score >= 3 && (best === undefined || score > best.score)) best = { left: a, right: b, score };
        }
        if (best === undefined) break;
        members[best.left] = [...members[best.left]!, ...members[best.right]!].sort();
        members.splice(best.right, 1);
      }
      // Construction preserves every input exactly once; validate at the boundary
      // too, so future partition changes cannot silently drop or duplicate work.
      const output = members.flat().sort();
      if (JSON.stringify(output) !== JSON.stringify([...ids].sort())) throw new Error("Invalid membership partition");
      partitions.push({ revision: job.revision, members, evidence: job.evidence });
    } catch {
      warnings.push("Membership review failed; previous membership was retained.");
    }
  }
  return { partitions, usage, warnings };
}
