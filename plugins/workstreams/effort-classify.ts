// Suggestions for the open PRs no effort owns: an effort, a new effort, or
// One-offs, with the signals behind each and a confidence. Pure: the server
// gathers the facts. A suggestion never moves anything; your click does, or a
// standing rule you added.
//
// PRs that belong together are suggested together: two unowned PRs join one
// cohort when they share a ticket, stack on each other, or sit in one board
// group. Each signal from owned work points the cohort at an effort, and each
// kind counts once per effort:
//   ticket 3  a ticket in the title or branch (any case) that an effort or one of its PRs carries
//   project 3 a ticket in the Linear project the effort was seeded from, or that most of its tickets are in
//   stack  3  stacked on a PR the effort owns
//   thread 2  a linked thread also works on the effort's PRs
//   group  2  the board's derived group also holds the effort's PRs
//   prefix 1  every owned PR with this ticket prefix is in the effort
//   area   1  the only effort whose PRs change this code area
// A ticket prefix names a team, not a piece of work, so it only adds weight
// to a signal of weight 2 or more for the same effort; alone or beside a code
// area it counts nothing (a standing rule can still name a prefix). The best
// effort wins by its margin over the next: high at 3 or more, medium at 2,
// low at 1; a tie suggests nothing. A cohort with no effort signal and two or
// more PRs is proposed as a new effort, and a lone PR whose ticket nothing
// else carries, under a prefix other work uses, as a one-off: so a lone PR
// tied to an effort only by its prefix is a low one-off.
import { z } from "zod";
import { stackParent } from "./pr-backlog.js";
import { ticketsIn } from "./threads.js";
import { displayTitle } from "./workstreams.js";

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];
const WEIGHT = { ticket: 3, project: 3, stack: 3, thread: 2, group: 2, prefix: 1, area: 1 } as const;
export const SIGNAL_KINDS = Object.keys(WEIGHT) as (keyof typeof WEIGHT)[];
type SignalKind = keyof typeof WEIGHT;
/** A thread linking more PRs than this is a hub, such as a housekeeping thread, and says nothing about any one of them. */
export const MAX_THREAD_PRS = 4;

/** `effortId` is the effort a signal points at; null for what ties a proposed effort's PRs together. */
const signalSchema = z.object({ kind: z.enum(SIGNAL_KINDS as [SignalKind, ...SignalKind[]]), effortId: z.string().nullable(), text: z.string() }).strict();
export type Signal = z.infer<typeof signalSchema>;
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effort"), effortId: z.string(), name: z.string() }).strict(),
  z.object({ kind: z.literal("new"), name: z.string() }).strict(),
  z.object({ kind: z.literal("one-off") }).strict(),
]);
export const suggestionGroupSchema = z.object({
  key: z.string(),
  /** Null: no clear signal, or signals that disagree. */
  target: targetSchema.nullable(),
  /** One group per effort and confidence, so accepting a group never trusts a PR more than its own signals earned. */
  confidence: z.enum(CONFIDENCES).nullable(),
  reason: z.string(),
  /** The specific signals behind its target, strongest kind first, for you to check before you accept it; empty without a target. */
  signals: z.array(z.string()),
  /** Tickets its PRs carry that no effort owns: accepting may add them, so later PRs on them join too. */
  tickets: z.array(z.string()),
  prs: z.array(z.object({ prUrl: z.string(), repo: z.string(), number: z.number(), title: z.string(), signals: z.array(signalSchema) }).strict()),
}).strict();
export type SuggestionGroup = z.infer<typeof suggestionGroupSchema>;

export type ClassifyPr = {
  /** Canonical PR URL. */
  url: string; repo: string; number: number; title: string; headRefName: string | null; baseRefName: string | null;
  /** The effort that owns it now; null for a PR to sort. */
  effortId: string | null;
  /** Code areas its checkout changes (see `codeArea`); empty without a checkout. */
  areas: readonly string[];
};
export type ClassifyInput = {
  prs: readonly ClassifyPr[];
  /**
   * Efforts a PR may join: not done, archived, or One-offs. A PR another effort owns gives no signal. `seededFrom` is the Linear project
   * the effort was seeded from.
   */
  efforts: readonly { id: string; name: string; tickets: readonly string[]; seededFrom?: { id: string; name: string } | null }[];
  /** The board's derived effort-level groups that no saved effort backs. */
  groups: readonly { key: string; name: string; prUrls: readonly string[] }[];
  /** Each thread with the PRs it links through its own work, not through a checkout it shares with other branches. */
  threads: readonly { id: string; title: string; prUrls: readonly string[] }[];
  /** Linear titles by ticket, to name a proposed effort. */
  ticketTitles: ReadonlyMap<string, string>;
  /** Each ticket's Linear project, where a key read named it. */
  projects?: ReadonlyMap<string, { id: string; name: string }>;
  pattern: RegExp;
};

const REASONS: Record<SignalKind, string> = { ticket: "shared ticket", project: "Linear project", stack: "stacked on its PRs", thread: "linked thread",
  group: "board group", prefix: "same ticket prefix", area: "same code area" };
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Tickets a PR's title or branch names, in any case: branches carry lowercase keys. */
export function prTickets(pr: Pick<ClassifyPr, "title" | "headRefName">, pattern: RegExp): string[] {
  return ticketsIn(`${pr.title}\n${pr.headRefName ?? ""}`, new RegExp(pattern.source, pattern.flags.includes("i") ? pattern.flags : `${pattern.flags}i`));
}

/**
 * Standing rules you add: a ticket prefix, part of a branch name (`*` for any text), a repository, or a Linear project by name names an
 * effort; a stack rule files a stacked PR with its base.
 */
export const RULE_KINDS = ["ticket-prefix", "branch", "repo", "stack", "linear-project"] as const;
export const ruleSchema = z.object({ id: z.string(), kind: z.enum(RULE_KINDS), value: z.string(), effortId: z.string().nullable(), createdAt: z.number() }).strict();
export type Rule = z.infer<typeof ruleSchema>;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** What a rule reads of a PR: `projects` names the Linear projects of its tickets. */
export type RulePr = Pick<ClassifyPr, "repo" | "title" | "headRefName"> & { projects?: readonly string[] };
function ruleMatches(rule: Rule, pr: RulePr, baseEffortId: string | null): boolean {
  const branch = (pr.headRefName ?? "").toLowerCase();
  switch (rule.kind) {
    // `OPS` matches OPS-43 and ops43 in any case, but not the "ops2" inside "stops2".
    case "ticket-prefix": return new RegExp(`(?<![\\p{L}\\p{N}])${escape(rule.value)}-?\\d`, "iu").test(`${pr.title}\n${branch}`);
    case "branch": return rule.value.includes("*") ? new RegExp(`^${rule.value.split("*").map(escape).join(".*")}$`, "iu").test(branch) : branch.includes(rule.value.toLowerCase());
    case "repo": return rule.value.includes("/") ? pr.repo.toLowerCase() === rule.value : pr.repo.toLowerCase().split("/")[1] === rule.value;
    case "stack": return baseEffortId !== null;
    case "linear-project": return (pr.projects ?? []).some((name) => name.toLocaleLowerCase() === rule.value.toLocaleLowerCase());
  }
}

/** The rule that places one PR: the first match when every matching rule names the same effort (a stack rule names its base's), else null. */
export function ruleFor(rules: readonly Rule[], pr: RulePr, baseEffortId: string | null): Rule | null {
  const matches = rules.filter((rule) => ruleMatches(rule, pr, baseEffortId));
  return new Set(matches.map((rule) => rule.effortId ?? baseEffortId)).size === 1 ? matches[0]! : null;
}

function index<T>(entries: Iterable<readonly [string, T]>): Map<string, Set<T>> {
  const map = new Map<string, Set<T>>();
  for (const [key, value] of entries) map.set(key, (map.get(key) ?? new Set()).add(value));
  return map;
}

export function suggestEfforts(input: ClassifyInput): SuggestionGroup[] {
  const efforts = new Map(input.efforts.map((effort) => [effort.id, effort]));
  const prs = new Map(input.prs.map((pr) => [pr.url, pr]));
  const tickets = new Map(input.prs.map((pr) => [pr.url, prTickets(pr, input.pattern)]));
  const open = input.prs.map((pr) => ({ repo: pr.repo, pr }));
  const base = new Map(input.prs.map((pr) => [pr.url, stackParent({ repo: pr.repo, pr }, open)?.pr ?? null]));
  const owner = (pr: ClassifyPr) => pr.effortId !== null && efforts.has(pr.effortId) ? pr.effortId : null;
  const ref = (pr: ClassifyPr) => `${pr.repo.split("/").pop()} #${pr.number}`;
  const prefix = (ticket: string) => ticket.slice(0, ticket.lastIndexOf("-"));

  const owned = input.prs.flatMap((pr) => { const id = owner(pr); return id ? [[pr, id] as const] : []; });
  const byTicket = index([...input.efforts.flatMap((effort) => effort.tickets.map((ticket) => [ticket, effort.id] as const)),
    ...owned.flatMap(([pr, id]) => tickets.get(pr.url)!.map((ticket) => [ticket, id] as const))]);
  const prefixEfforts = index(owned.flatMap(([pr, id]) => tickets.get(pr.url)!.map((ticket) => [prefix(ticket), id] as const)));
  const prefixPrs = index(owned.flatMap(([pr]) => tickets.get(pr.url)!.map((ticket) => [prefix(ticket), pr.url] as const)));
  const byArea = index(owned.flatMap(([pr, id]) => pr.areas.map((area) => [area, id] as const)));
  const threadsOf = index(input.threads.filter((thread) => thread.prUrls.length <= MAX_THREAD_PRS).flatMap((thread) => thread.prUrls.map((url) => [url, thread] as const)));
  const groupsOf = index(input.groups.flatMap((group) => group.prUrls.map((url) => [url, group] as const)));
  const ownersOf = (urls: readonly string[]) => new Set(urls.flatMap((url) => { const other = prs.get(url); const id = other && owner(other); return id ? [id] : []; }));
  // An effort's Linear project: the one it was seeded from, else the one more than half of its tickets with a known project are in.
  const projects = input.projects ?? new Map<string, { id: string; name: string }>();
  const byProject = index(input.efforts.flatMap((effort) => {
    if (effort.seededFrom) return [[effort.seededFrom.id, effort.id] as const];
    const known = [...new Set([...effort.tickets, ...owned.flatMap(([pr, id]) => id === effort.id ? tickets.get(pr.url)! : [])])]
      .flatMap((ticket) => projects.get(ticket)?.id ?? []);
    const top = [...new Set(known)].find((id) => known.filter((other) => other === id).length * 2 > known.length);
    return top ? [[top, effort.id] as const] : [];
  }));

  function signals(pr: ClassifyPr): Signal[] {
    const out: Signal[] = [];
    const push = (kind: SignalKind, effortId: string, text: string) => {
      if (!out.some((signal) => signal.kind === kind && signal.effortId === effortId)) out.push({ kind, effortId, text });
    };
    for (const ticket of tickets.get(pr.url)!) for (const id of byTicket.get(ticket) ?? []) push("ticket", id, `ticket ${ticket}`);
    for (const ticket of tickets.get(pr.url)!) {
      const project = projects.get(ticket);
      for (const id of project ? byProject.get(project.id) ?? [] : []) push("project", id, `Linear project “${project!.name}”`);
    }
    const parent = base.get(pr.url);
    const parentOwner = parent && owner(parent);
    if (parent && parentOwner) push("stack", parentOwner, `stacked on ${ref(parent)}`);
    for (const thread of threadsOf.get(pr.url) ?? []) for (const id of ownersOf(thread.prUrls)) push("thread", id, `thread “${thread.title}”`);
    for (const group of groupsOf.get(pr.url) ?? []) for (const id of ownersOf(group.prUrls)) push("group", id, `board group “${group.name}”`);
    for (const ticket of tickets.get(pr.url)!) {
      const ids = prefixEfforts.get(prefix(ticket));
      if (ids?.size === 1 && prefixPrs.get(prefix(ticket))!.size >= 2) push("prefix", [...ids][0]!, `prefix ${prefix(ticket)}`);
    }
    for (const area of pr.areas) {
      const ids = byArea.get(area);
      if (ids?.size === 1) push("area", [...ids][0]!, `area ${area}`);
    }
    return out;
  }

  // Cohorts: unowned PRs that share a ticket, stack on each other, or sit in one board group.
  const loose = input.prs.filter((pr) => pr.effortId === null);
  const root = new Map(loose.map((pr) => [pr.url, pr.url]));
  const find = (url: string): string => { let at = url; while (root.get(at) !== at) at = root.get(at)!; return at; };
  const join = (a: string, b: string) => root.set(find(a), find(b));
  const looseTickets = index(loose.flatMap((pr) => tickets.get(pr.url)!.map((ticket) => [ticket, pr.url] as const)));
  for (const urls of looseTickets.values()) for (const url of urls) join([...urls][0]!, url);
  for (const pr of loose) { const parent = base.get(pr.url); if (parent && root.has(parent.url)) join(pr.url, parent.url); }
  for (const group of input.groups) { const members = group.prUrls.filter((url) => root.has(url)); for (const url of members) join(members[0]!, url); }
  const cohorts = index(loose.map((pr) => [find(pr.url), pr] as const));
  const allTickets = index(input.prs.flatMap((pr) => tickets.get(pr.url)!.map((ticket) => [ticket, pr.url] as const)));
  // A prefix no other PR or effort uses is likelier a word ("utf-8") than a ticket, and makes no PR standalone.
  const prefixUsers = index([...allTickets].flatMap(([ticket, urls]) => [...urls].map((url) => [prefix(ticket), url] as const)));
  const known = (ticket: string, url: string) => input.efforts.some((effort) => effort.tickets.some((other) => prefix(other) === prefix(ticket))) ||
    [...prefixUsers.get(prefix(ticket)) ?? []].some((other) => other !== url);

  type Placed = { target: SuggestionGroup["target"]; key: string; confidence: Confidence | null; reason: string; prs: { pr: ClassifyPr; signals: Signal[] }[] };
  const placed: Placed[] = [];
  for (const members of cohorts.values()) {
    const list = [...members];
    const raw = new Map(list.map((pr) => [pr.url, signals(pr)]));
    // A prefix counts only for an effort that a signal of weight 2 or more in the cohort points at too.
    const backed = new Set([...raw.values()].flat().flatMap((signal) => WEIGHT[signal.kind] >= 2 ? [signal.effortId] : []));
    const found = new Map([...raw].map(([url, own]) => [url, own.filter((signal) => signal.kind !== "prefix" || backed.has(signal.effortId))]));
    const score = new Map<string, number>();
    for (const kind of SIGNAL_KINDS) for (const id of new Set(list.flatMap((pr) => found.get(pr.url)!.flatMap((signal) => signal.kind === kind ? [signal.effortId!] : []))))
      score.set(id, (score.get(id) ?? 0) + WEIGHT[kind]);
    const [best, next] = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const margin = best ? best[1] - (next?.[1] ?? 0) : 0;
    const rows = (extra: (pr: ClassifyPr) => Signal[] = () => []) => list.map((pr) => ({ pr, signals: [...found.get(pr.url)!, ...extra(pr)] }));
    const baseInside = (pr: ClassifyPr) => { const parent = base.get(pr.url); return parent && members.has(parent) ? parent : null; };
    if (best && margin > 0) {
      const confidence = margin >= 3 ? "high" : margin >= 2 ? "medium" : "low";
      placed.push({ target: { kind: "effort", effortId: best[0], name: efforts.get(best[0])!.name }, key: `effort:${best[0]}:${confidence}`, confidence, reason: "", prs: rows() });
    } else if (!best && list.length > 1) {
      // What ties them together, most specific first, names the proposal.
      const shared = [...new Set(list.flatMap((pr) => tickets.get(pr.url)!))].filter((ticket) => looseTickets.get(ticket)!.size > 1)
        .sort((a, b) => looseTickets.get(b)!.size - looseTickets.get(a)!.size || a.localeCompare(b))[0];
      const group = input.groups.find((candidate) => list.some((pr) => candidate.prUrls.includes(pr.url)));
      const top = list.find((pr) => !baseInside(pr)) ?? list[0]!;
      const stacked = list.some(baseInside);
      const name = group?.name ?? (shared ? `${input.ticketTitles.get(shared) ?? displayTitle(top.title)} (${shared})` : displayTitle(top.title));
      placed.push({ target: { kind: "new", name }, key: `new:${shared ?? group?.key ?? top.url}`, confidence: shared || stacked ? "medium" : "low",
        reason: `${shared ? `Shared ticket ${shared}` : stacked ? "Stacked PRs" : "Board group"}, no effort yet`, prs: rows((pr) => [
          ...tickets.get(pr.url)!.filter((ticket) => looseTickets.get(ticket)!.size > 1).map((ticket) => ({ kind: "ticket" as const, effortId: null, text: `ticket ${ticket}` })),
          ...baseInside(pr) ? [{ kind: "stack" as const, effortId: null, text: `stacked on ${ref(baseInside(pr)!)}` }] : [],
          ...[...groupsOf.get(pr.url) ?? []].map((candidate) => ({ kind: "group" as const, effortId: null, text: `board group “${candidate.name}”` }))]) });
    } else if (!best && tickets.get(list[0]!.url)!.length > 0 && tickets.get(list[0]!.url)!.every((ticket) =>
      allTickets.get(ticket)!.size === 1 && !byTicket.has(ticket) && known(ticket, list[0]!.url))) {
      placed.push({ target: { kind: "one-off" }, key: "one-off", confidence: "low", reason: "Standalone ticket that nothing else carries",
        prs: rows((pr) => tickets.get(pr.url)!.map((ticket) => ({ kind: "ticket" as const, effortId: null, text: `standalone ticket ${ticket}` }))) });
    } else placed.push({ target: null, key: "none", confidence: null, reason: "No clear signal. Pick an effort for each PR.", prs: rows() });
  }

  const groups = new Map<string, SuggestionGroup>();
  const rank = (confidence: Confidence | null) => confidence === null ? -1 : CONFIDENCES.indexOf(confidence);
  const owners = new Set(input.efforts.flatMap((effort) => effort.tickets));
  for (const item of placed) {
    const group = groups.get(item.key) ?? { key: item.key, target: item.target, confidence: item.confidence, reason: item.reason, signals: [], tickets: [], prs: [] };
    for (const { pr, signals: found } of item.prs) {
      group.prs.push({ prUrl: pr.url, repo: pr.repo, number: pr.number, title: displayTitle(pr.title), signals: found });
      for (const ticket of tickets.get(pr.url)!) if (!owners.has(ticket) && !group.tickets.includes(ticket)) group.tickets.push(ticket);
    }
    groups.set(item.key, group);
  }
  for (const group of groups.values()) {
    group.prs.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    group.tickets.sort();
    // An effort's reason names the two strongest kinds of signal that point its PRs at it.
    const target = group.target;
    if (target?.kind === "effort") group.reason = capitalize(SIGNAL_KINDS.filter((kind) => group.prs.some((pr) =>
      pr.signals.some((signal) => signal.kind === kind && signal.effortId === target.effortId))).slice(0, 2).map((kind) => REASONS[kind]).join(" · "));
    const aim = target?.kind === "effort" ? target.effortId : null;
    if (target) group.signals = [...new Set(SIGNAL_KINDS.flatMap((kind) => group.prs.flatMap((pr) =>
      pr.signals.flatMap((signal) => signal.kind === kind && signal.effortId === aim ? [signal.text] : []))))];
  }
  return [...groups.values()].sort((a, b) => Number(a.target === null) - Number(b.target === null) || rank(b.confidence) - rank(a.confidence) ||
    b.prs.length - a.prs.length || a.key.localeCompare(b.key));
}
