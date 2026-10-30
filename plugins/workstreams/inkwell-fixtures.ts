// Fictional Inkwell bookstore data. The shapes copy recorded Workstreams state
// (batch sizes, overlaps, statuses, checkouts, and ownership); every name,
// number, path, and thread id is invented.
import { feedbackVerificationState, userConfirmation, type ApprovalFeedbackRecord } from "./approval-feedback.js";
import { prSchema, type Pr } from "./contract.js";
import { deckView, type DeckInput, type DeckRowInput, type DeckView } from "./deck.js";
import type { ThreadEvidence } from "./deck-homes.js";
import type { SuggestionGroup } from "./effort-classify.js";
import { suggestReviewers } from "./inventory-actions.js";
import { inventoryRow, inventoryView, type InventoryView, type ThreadRef } from "./inventory-view.js";
import { DEFAULT_ATTENTION_THRESHOLDS, prAttention, type StateSince } from "./pr-attention.js";
import { stackParent } from "./pr-backlog.js";
import type { ResolvedThreadLink } from "./work-context.js";

const HOUR = 3_600_000;

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;

/**
 * The PR inventory's acceptance shape (plan amendment A13): the 17 open PRs behind a live board's 14 "needs you" items, with Inkwell
 * names, as inventory_get returns them. The rows come through the functions the server composes (attention, stack parents, suggested
 * reviewers, rows, and the view), not written by hand, so a change to any of them that reclassifies a row fails the acceptance test.
 * - Approval comments to address, with no reply: folio #301 and #318, ready to merge once `feedback` holds your confirmation for each.
 * - Ready to merge: the approved stack folio #340 → #341 → #342 → #343.
 * - Needs a nudge: catalog #96, asked of two reviewers on Monday.
 * - Waiting on parents: quill #212 on #210 (changes requested and conflicting), and spine #156 on #155 (changes requested).
 * - Code work, each with its thread except catalog #97: quill #210 and #211, spine #155, folio #330 (approved but conflicting),
 *   atlas #410, catalog #97, folio #325 (conflicting), and folio #305 (red checks).
 * - Missing a reviewer as well: atlas #410, folio #325, and folio #305.
 */
export const INVENTORY_NOW = Date.UTC(2026, 8, 30, 15);
export const INVENTORY_EFFORTS = { shelf: { id: "effort-shelf-order", name: "Shelf order" }, pickup: { id: "effort-store-pickup", name: "Store pickup" } };
export function inkwellInventory(feedback: ApprovalFeedbackRecords = () => null): InventoryView {
  return inventoryCase(feedback).view;
}
/** The approval feedback store's verification for a PR, as the server reads it: none until someone verifies it. */
type ApprovalFeedbackRecords = (prUrl: string) => ApprovalFeedbackRecord | null;
/** The case's 17 PRs as a fresh GitHub read returns them to the server, with approval feedback checked against `feedback`. */
export function inkwellInventoryPrs(feedback: ApprovalFeedbackRecords = () => null): Pr[] {
  return inventoryCase(feedback).entries.map((entry) => entry.pr);
}
function inventoryCase(feedback: ApprovalFeedbackRecords) {
  const day = 24 * HOUR;
  const iso = (at: number) => new Date(at).toISOString();
  const approved = (login = "mira-l"): Partial<Pr> => ({ reviewDecision: "APPROVED", latestReviewStates: ["APPROVED"],
    latestReviews: [{ login, state: "APPROVED", submittedAt: iso(INVENTORY_NOW - 2 * day) }] });
  const changes = (login: string): Partial<Pr> => ({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED", latestReviewStates: ["CHANGES_REQUESTED"],
    latestReviews: [{ login, state: "CHANGES_REQUESTED", submittedAt: iso(INVENTORY_NOW - day) }] });
  const asked = (hoursAgo: number, ...logins: string[]): Partial<Pr> => ({ reviewRequests: logins,
    reviewRequestedAt: logins.map((reviewer) => ({ reviewer, at: iso(INVENTORY_NOW - hoursAgo * HOUR) })) });
  const conflicting: Partial<Pr> = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
  // The approval left comments, and nothing since answered them.
  const commented = (number: number): Partial<Pr> => ({ approvalFeedback: { status: "present", fingerprint: number.toString(16).padStart(64, "f"),
    sourceIds: [`review-${number}`] }, reviewFeedback: { openThreads: 0, comment: null, repliedAt: null, noteAt: iso(INVENTORY_NOW - 2 * day), followUpAt: null } });
  const since = (state: keyof StateSince): StateSince => ({ [state]: INVENTORY_NOW - 2 * day });
  type Spec = { repo: string; number: number; title: string; base?: number; effort?: keyof typeof INVENTORY_EFFORTS; facts?: Partial<Pr>; since?: StateSince;
    thread?: boolean; started?: boolean };
  const specs: Spec[] = [
    { repo: "folio", number: 301, title: "ABC-350 Show spine labels on shelf cards", facts: { ...approved(), ...commented(301) } },
    { repo: "folio", number: 318, title: "ABC-351 Keep the reading list sort", facts: { ...approved("theo-k"), ...commented(318) } },
    { repo: "folio", number: 340, title: "ABC-360 Store shelf order", effort: "shelf", facts: approved() },
    { repo: "folio", number: 341, title: "ABC-361 Read shelf order back", base: 340, effort: "shelf", facts: approved() },
    { repo: "folio", number: 342, title: "ABC-362 Drag to reorder shelves", base: 341, effort: "shelf", facts: approved() },
    { repo: "folio", number: 343, title: "ABC-363 Undo a shelf move", base: 342, effort: "shelf", facts: approved() },
    { repo: "catalog", number: 96, title: "ABC-121 Show series order on catalog pages", facts: asked(48, "mira-l", "theo-k") },
    { repo: "quill", number: 210, title: "ABC-370 Hold books at the counter", effort: "pickup", facts: { ...changes("otto-v"), ...conflicting },
      since: since("conflicting"), thread: true, started: true },
    { repo: "quill", number: 211, title: "ABC-371 Print hold slips", effort: "pickup", facts: changes("otto-v"), thread: true },
    { repo: "quill", number: 212, title: "ABC-372 Email when a hold is ready", base: 210, effort: "pickup", facts: approved("otto-v") },
    { repo: "spine", number: 155, title: "ABC-335 Remind readers before holds expire", effort: "pickup", facts: changes("ines-v"), thread: true },
    { repo: "spine", number: 156, title: "ABC-336 Release expired holds", base: 155, effort: "pickup", facts: approved("ines-v") },
    { repo: "folio", number: 330, title: "ABC-364 Keep shelf filters in the link", effort: "shelf", facts: { ...approved(), ...conflicting },
      since: since("conflicting"), thread: true },
    { repo: "atlas", number: 410, title: "ABC-210 Show delivery windows at checkout", facts: conflicting, since: since("conflicting"), thread: true },
    { repo: "catalog", number: 97, title: "ABC-122 Merge duplicate author records", facts: { ...asked(2, "ines-v"), ...conflicting }, since: since("conflicting") },
    { repo: "folio", number: 325, title: "ABC-355 Remember the last shelf you browsed", facts: conflicting, since: since("conflicting"), thread: true },
    { repo: "folio", number: 305, title: "ABC-352 Load cover images lazily", facts: { checkConclusions: ["FAILURE"], mergeStateStatus: "UNSTABLE" },
      since: since("ci-red"), thread: true },
  ];
  const branch = (number: number) => `abc-${number}-work`;
  const entries = specs.map((spec) => {
    const pr = prSchema.parse({
      number: spec.number, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", checkConclusions: ["SUCCESS"], url: url(spec.repo, spec.number),
      title: spec.title, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: spec.base ? branch(spec.base) : "main", headRefName: branch(spec.number),
      headRefOid: spec.number.toString(16).padStart(40, "c"), latestReviewStates: [], createdAt: iso(INVENTORY_NOW - 6 * day),
      headCommittedAt: iso(INVENTORY_NOW - 3 * day), reviewRequestedAt: [], unresolvedReviewThreads: 0, resolvedReviewThreads: 0,
      approvalFeedback: { status: "none", fingerprint: null, sourceIds: [] }, ...spec.facts });
    // As the server checks it: verified when the approval left no comments, or the store holds a verification for this head and these comments.
    const verification = feedbackVerificationState(pr.approvalFeedback, pr.headRefOid ?? null, feedback(pr.url));
    return { repo: `inkwell/${spec.repo}`, pr: { ...pr, approvalFeedbackVerification: verification,
      approvalFeedbackVerified: verification === "none" || verification === "verified",
      approvalFeedbackConfirmed: userConfirmation(feedback(pr.url), pr.approvalFeedback, pr.headRefOid ?? null)?.current === true } };
  });
  const threads = new Map<string, ThreadRef>(specs.flatMap((spec): [string, ThreadRef][] => [
    ...spec.thread ? [[`thr_${spec.repo}_${spec.number}`, { title: `Work on ${spec.repo} #${spec.number}`, titleFallback: null, status: "idle", updatedAt: 2 }] as [string, ThreadRef]] : [],
    ...spec.started ? [[`thr_${spec.repo}_${spec.number}_plan`, { title: `Plan ${spec.title.slice(8)}`, titleFallback: null, status: "idle", updatedAt: 1 }] as [string, ThreadRef]] : []]));
  const link = (prUrl: string, threadId: string, sources: ResolvedThreadLink["sources"]): ResolvedThreadLink =>
    ({ prUrl, threadId, role: "pr", title: threads.get(threadId)!.title!, tier: "started", direct: true, sources });
  const checkedAt = iso(INVENTORY_NOW - 25_000);
  const rows = specs.map((spec, index) => {
    const entry = entries[index]!;
    const stackedOn = stackParent(entry, entries)?.pr.number ?? null;
    const { reasons } = prAttention({ ...entry.pr, stackedOn }, { holds: {}, effort: null, since: spec.since ?? {} },
      { now: INVENTORY_NOW, thresholds: DEFAULT_ATTENTION_THRESHOLDS, utcOffsetMinutes: 0 });
    const links = [...spec.thread ? [link(entry.pr.url, `thr_${spec.repo}_${spec.number}`, ["advance"])] : [],
      ...spec.started ? [link(entry.pr.url, `thr_${spec.repo}_${spec.number}_plan`, ["cluster"])] : []];
    const repository = entries.filter((other) => other.repo === entry.repo && other !== entry).map((other) => other.pr);
    return { effort: spec.effort ? INVENTORY_EFFORTS[spec.effort] : null, ...inventoryRow({ prUrl: entry.pr.url, pr: entry.pr, authored: true, stale: false,
      reasons, hold: null, observation: { checkedAt, failedAt: null, error: null }, stackedOn, links, threads,
      suggestedReviewers: suggestReviewers(entry.pr, repository), lastAction: null,
      confirmation: userConfirmation(feedback(entry.pr.url), entry.pr.approvalFeedback, entry.pr.headRefOid ?? null) }) };
  });
  return { entries, view: inventoryView(rows, { checkedAt, attemptedAt: checkedAt, refreshing: false, rateLimitedUntil: null, warnings: [] }) };
}

/**
 * Threads for the deck case, with the evidence the server gathers for each (deck-homes.ts), one per A17.1 case. Three run in the shared
 * folio clone, whose checkout has folio #325's branch now, and link nothing of their own. One runs alone in a quill worktree with no PR.
 * One works folio #325. One spans atlas and catalog evenly from a catalog checkout, and one spans atlas and folio from nowhere. One has
 * Shelf order as its effort, and one links a merged Shelf order PR. Its threads include Store pickup's parent thread, which the deck case has.
 */
export function inkwellThreads(): Pick<DeckInput, "threads" | "homes"> {
  const pr = (repo: string, number: number, effortId: string | null = null) => ({ url: url(repo, number), repo: `inkwell/${repo}`, effortId });
  const shelf = INVENTORY_EFFORTS.shelf.id;
  const specs: [id: string, title: string, hoursAgo: number, evidence: Omit<ThreadEvidence, "id">][] = [
    ["thr_clone_footer", "Check the footer year", 30, { effortId: null, prs: [], checkout: null, environment: "inkwell/folio" }],
    ["thr_clone_flaky", "Look at a flaky test", 5, { effortId: null, prs: [], checkout: null, environment: "inkwell/folio" }],
    ["thr_clone_question", "How do shelves sort?", 50, { effortId: null, prs: [], checkout: null, environment: "inkwell/folio" }],
    ["thr_quill_try", "Try a quieter quill layout", 8, { effortId: null, prs: [], checkout: "inkwell/quill", environment: "inkwell/quill" }],
    ["thr_folio_recall", "Recall the last shelf", 3, { effortId: null, prs: [pr("folio", 325)], checkout: null, environment: null }],
    ["thr_author_rename", "Rename the author field", 4, { effortId: null, prs: [pr("atlas", 410), pr("catalog", 97)], checkout: null, environment: "inkwell/catalog" }],
    ["thr_audit_logs", "Audit request logs", 6, { effortId: null, prs: [pr("atlas", 410), pr("folio", 305)], checkout: null, environment: null }],
    ["thr_shelf_notes", "Shelf order notes", 7, { effortId: shelf, prs: [], checkout: null, environment: null }],
    ["thr_shelf_ship", "Ship the shelf fix", 9, { effortId: null, prs: [pr("folio", 290, shelf)], checkout: null, environment: null }],
  ];
  return {
    threads: new Map([["thr_pickup", { title: "Store pickup", status: "idle", updatedAt: INVENTORY_NOW - 2 * HOUR }],
      ...specs.map(([id, title, hoursAgo]) => [id, { title, status: "idle", updatedAt: INVENTORY_NOW - hoursAgo * HOUR }] as const)]),
    homes: specs.map(([id, , , evidence]) => ({ id, ...evidence })),
  };
}

/**
 * The classifier's suggestions for the deck case's four PRs no effort owns: folio #325 for Shelf order, atlas #410 and catalog #97, in two
 * repositories, as a new effort, and folio #305 with no clear signal.
 */
export function inkwellSuggestions(): SuggestionGroup[] {
  const pr = (repo: string, number: number, title: string, signals: { kind: "ticket" | "stack" | "thread" | "group" | "prefix" | "area"; text: string }[], effortId: string | null) =>
    ({ prUrl: url(repo, number), repo: `inkwell/${repo}`, number, title, signals: signals.map((signal) => ({ ...signal, effortId })) });
  const shelf = INVENTORY_EFFORTS.shelf.id;
  return [
    { key: `effort:${shelf}:high`, target: { kind: "effort", effortId: shelf, name: "Shelf order" }, confidence: "high", reason: "Shared ticket · same ticket prefix",
      signals: ["ticket ABC-355", "prefix ABC"], tickets: [], prs: [pr("folio", 325, "Remember the last shelf you browsed", [{ kind: "ticket", text: "ticket ABC-355" }, { kind: "prefix", text: "prefix ABC" }], shelf)] },
    { key: "new:ABC-210", target: { kind: "new", name: "Delivery windows" }, confidence: "medium", reason: "Shared ticket ABC-210, no effort yet",
      signals: ["ticket ABC-210", "board group “Checkout”"], tickets: ["ABC-210"],
      prs: [pr("atlas", 410, "Show delivery windows at checkout", [{ kind: "ticket", text: "ticket ABC-210" }], null),
        pr("catalog", 97, "Merge duplicate author records", [{ kind: "group", text: "board group “Checkout”" }], null)] },
    { key: "none", target: null, confidence: null, reason: "No clear signal. Pick an effort for each PR.", signals: [], tickets: [],
      prs: [pr("folio", 305, "Load cover images lazily", [], null)] }];
}

/**
 * The deck case's suggestions as classify_get hands All PRs the inventory case's: folio #325 for Shelf order (high), and at medium folio
 * #301 for Shelf order and catalog #96 for Store pickup; folio #318 for Shelf order only at low, atlas #410 and catalog #97 as a new
 * effort, and folio #305 with no clear signal, none of which shows.
 */
export function inkwellInventorySuggestions(): SuggestionGroup[] {
  const pr = (repo: string, number: number, title: string, text: string, effortId: string) =>
    ({ prUrl: url(repo, number), repo: `inkwell/${repo}`, number, title, signals: [{ kind: text.startsWith("thread") ? "thread" as const : "group" as const, effortId, text }] });
  const { shelf, pickup } = INVENTORY_EFFORTS;
  const [high, ...rest] = inkwellSuggestions();
  return [high!,
    { key: `effort:${shelf.id}:medium`, target: { kind: "effort", effortId: shelf.id, name: shelf.name }, confidence: "medium", reason: "Board group",
      signals: ["board group “Shelves”"], tickets: [], prs: [pr("folio", 301, "Show spine labels on shelf cards", "board group “Shelves”", shelf.id)] },
    { key: `effort:${pickup.id}:medium`, target: { kind: "effort", effortId: pickup.id, name: pickup.name }, confidence: "medium", reason: "Linked thread",
      signals: ["thread “Store pickup”"], tickets: [], prs: [pr("catalog", 96, "Show series order on catalog pages", "thread “Store pickup”", pickup.id)] },
    { key: `effort:${shelf.id}:low`, target: { kind: "effort", effortId: shelf.id, name: shelf.name }, confidence: "low", reason: "Board group",
      signals: ["board group “Shelves”"], tickets: [], prs: [pr("folio", 318, "Keep the reading list sort", "board group “Shelves”", shelf.id)] },
    ...rest];
}

/**
 * The inventory case as the effort deck serves it: Shelf order (the approved folio stack and the conflicting #330) and Store pickup (three
 * PRs to fix and two stacked on them) on the active pile, One-offs holding the two approvals with comments and the overdue catalog
 * review, Gift cards on hold, Store hours done, and four PRs no effort owns on their service cards: folio #325 suggested for Shelf order,
 * atlas #410 and catalog #97 proposed as a new effort, and folio #305 with no clear signal. `row` patches one row as the server hands it over.
 */
export function inkwellDeck(patch: Partial<DeckInput> = {}, row: (row: DeckRowInput) => Partial<DeckRowInput> = () => ({})): DeckView {
  const day = 24 * HOUR;
  const oneOffs = { id: "effort-one-offs", name: "One-offs" };
  const loose = new Set([301, 318, 96]);
  const prs = new Map(inkwellInventoryPrs().map((pr) => [pr.url, pr]));
  const rows = inkwellInventory().groups.flatMap((group) => group.rows.map((entry): DeckRowInput => {
    const base: DeckRowInput = { ...entry, effort: loose.has(entry.number) ? oneOffs : group.effort, pr: prs.get(entry.prUrl) ?? null,
      tickets: entry.title.match(/ABC-\d+/gu) ?? [], acted: null };
    return { ...base, ...row(base) };
  }));
  const effort = (id: string, name: string, pile: "active" | "held" | "done" = "active", extra: Partial<DeckInput["efforts"][number]> = {}) => ({ id, key: id, name,
    goal: `${name} for every reader.`, oneOff: false, archived: false, pile: { effortId: id, pile, reason: pile === "held" ? "Waiting on the card vendor" : "",
      since: pile === "active" ? 1 : INVENTORY_NOW - day }, parentThreadId: null, tickets: [], ...extra });
  const shelf = INVENTORY_EFFORTS.shelf.id;
  return deckView({ now: INVENTORY_NOW, rows,
    efforts: [effort(shelf, "Shelf order"), effort(INVENTORY_EFFORTS.pickup.id, "Store pickup", "active", { parentThreadId: "thr_pickup" }),
      { ...effort(oneOffs.id, "One-offs"), oneOff: true }, effort("effort-gift-cards", "Gift cards", "held"), effort("effort-store-hours", "Store hours", "done")],
    merges: [{ url: url("folio", 290), at: INVENTORY_NOW - day, effortId: shelf }],
    linear: new Map([["ABC-360", { identifier: "ABC-360", title: "Store shelf order", description: null, state: { name: "In Review", type: "started" },
      project: { id: "p1", name: "Shelf redesign" }, parent: null, labels: ["shelves"], url: null, updatedAt: null, source: "agent" }]]), linearReadAt: new Map(),
    threads: new Map([["thr_pickup", { title: "Store pickup", status: "idle", updatedAt: INVENTORY_NOW - 2 * HOUR }]]), homes: [],
    classify: { oneOffsId: oneOffs.id, groups: inkwellSuggestions() },
    read: { checkedAt: new Date(INVENTORY_NOW - 25_000).toISOString(), refreshing: false, limitedUntil: null }, seen: new Map(), ...patch });
}
