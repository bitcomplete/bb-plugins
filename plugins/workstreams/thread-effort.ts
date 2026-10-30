import { z } from "zod";
import { serviceId, serviceName } from "./deck-shared.js";

export const threadEffortSourceSchema = z.object({
  id: z.string(), kind: z.enum(["ticket", "pr"]), label: z.string(), ticket: z.string().nullable(),
  prUrls: z.array(z.string()), checkoutPaths: z.array(z.string()), effortKey: z.string().nullable(),
  effortName: z.string().nullable(), explicit: z.boolean(), scope: z.string(),
});
/**
 * What the composer's effort chip and its popover show (plan amendment A17.2), read with the context. The chip names the effort the
 * thread is in; each choice is an effort the deck draws a card for, with the strongest signal when one points the thread at it; and
 * `linked` lists the PRs the thread links through its own work: its recorded PRs and the PR in its exact checkout, which its effort takes
 * in, never one it reaches only by branch name or worked path.
 */
export const threadEffortPickerSchema = z.object({
  chip: z.object({
    /**
     * An effort: the thread's own, the one it coordinates, or the one its own PRs are in. A service: no effort, so its repository's service
     * card, as the deck places it (deck-homes.ts). None: a loose thread.
     */
    kind: z.enum(["effort", "service", "none"]),
    effortId: z.string().nullable(), name: z.string(), oneOff: z.boolean(),
    /** Your turn on its card, as the deck's strip chip counts it: an effort's, or a service's, whose PRs count as any effort's do. */
    yourTurn: z.number(),
    /** The deck card it opens: an effort's id, a repository's service card, or null. */
    card: z.string().nullable(),
  }).strict(),
  choices: z.array(z.object({ key: z.string(), id: z.string(), name: z.string(), oneOff: z.boolean(), held: z.boolean(), yourTurn: z.number(),
    /** The strongest signal that points the thread at it, and the signals' summed weight; null and 0 when none does. */
    signal: z.string().nullable(), score: z.number() }).strict()),
  linked: z.array(z.object({ url: z.string(), ref: z.string(), title: z.string(), effortId: z.string().nullable(), effortName: z.string().nullable(),
    /** The linked work a move takes along: the PR's ticket, and any ticket that shares one of its PRs. */
    sourceIds: z.array(z.string()),
    /** What else that move takes, for its confirm: the other PRs and tickets, and "N checkouts" an effort has. Empty when it takes only the PR and its tickets. */
    also: z.array(z.string()) }).strict()),
  /** A TypeSafe key is set, so Jev can suggest on request. */
  jev: z.boolean(),
}).strict();
export type ThreadEffortPicker = z.infer<typeof threadEffortPickerSchema>;
export const threadEffortContextSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({ ok: z.literal(true), sources: z.array(threadEffortSourceSchema),
    efforts: z.array(z.object({ key: z.string(), name: z.string(), scope: z.string() })),
    linkablePrs: z.array(z.object({ url: z.string(), label: z.string() })), linkedPrUrl: z.string().nullable(),
    threadEffort: z.object({ key: z.string(), name: z.string() }).nullable(),
    inheritanceNotice: z.string().nullable(),
    /** Reads and successful changes include the picker, so a save immediately updates the chip. */
    picker: threadEffortPickerSchema.optional(),
    /** What a change returns for thread_effort_undo to take it back. */
    undoId: z.string().optional() }),
]);
export type ThreadEffortContext = z.infer<typeof threadEffortContextSchema>;
export type ThreadEffortReady = Extract<ThreadEffortContext, { ok: true }>;

/** Scope only the selected work and destination; unrelated scans do not invalidate a move. */
export function threadEffortMoveScope(context: ThreadEffortReady, sourceIds: readonly string[], destinationKey: string): string {
  const destination = context.efforts.find((effort) => effort.key === destinationKey);
  const ids = [...new Set(sourceIds)].sort();
  if (!destination || ids.length === 0 || ids.some((id) => !context.sources.some((source) => source.id === id))) return "";
  return JSON.stringify({ sources: ids.map((id) => [id, context.sources.find((source) => source.id === id)!.scope]),
    destination: [destination.key, destination.scope] });
}

/** A thread assignment changes only when its selected destination or previous intent changes. */
export function threadEffortAssignmentScope(context: ThreadEffortReady, destinationKey: string | null): string {
  const destination = destinationKey === null ? null : context.efforts.find((effort) => effort.key === destinationKey);
  if (destinationKey !== null && !destination) return "";
  return JSON.stringify({ prior: context.threadEffort?.key ?? null,
    destination: destination === null ? null : [destination!.key, destination!.scope] });
}

/** How much each kind of signal weighs, as the classifier weighs its own (effort-classify.ts); a classifier suggestion weighs its confidence. */
const WEIGHT = { work: 3, title: 3, parent: 2 } as const;
const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const KIND_ORDER = ["work", "title", "classifier", "parent"] as const;

/**
 * Why a thread belongs to each effort, from what the board already knows: an effort holds a PR the thread links through its own work, a
 * ticket the thread's title names, or the thread's parent, or the classifier suggests the effort for one of its linked PRs no effort has.
 * Each kind counts once per effort. The most weight first, then the strongest one signal, then by name; nothing here moves anything.
 */
export function threadEffortSignals(input: {
  efforts: readonly { id: string; name: string }[];
  /** PRs the thread links through its own work, with the effort each is in. */
  linked: readonly { ref: string; effortId: string | null }[];
  /** Tickets the thread's title names, with the effort that has each or its PRs. */
  titleTickets: readonly { ticket: string; effortId: string | null }[];
  /** The effort the thread's parent thread is in. */
  parentEffortId: string | null;
  /** The classifier's suggestion for each linked PR no effort has, with its strongest signal. */
  classified: readonly { effortId: string; confidence: keyof typeof CONFIDENCE_WEIGHT; signal: string }[];
}): { id: string; score: number; signal: string }[] {
  const found = new Map<string, Map<(typeof KIND_ORDER)[number], { weight: number; text: string }>>();
  const add = (effortId: string | null, kind: (typeof KIND_ORDER)[number], weight: number, text: string) => {
    if (!effortId) return;
    const kinds = found.get(effortId) ?? new Map();
    if ((kinds.get(kind)?.weight ?? 0) < weight) kinds.set(kind, { weight, text });
    found.set(effortId, kinds);
  };
  const owned = new Map<string, string[]>();
  for (const pr of input.linked) if (pr.effortId) owned.set(pr.effortId, [...owned.get(pr.effortId) ?? [], pr.ref]);
  for (const [id, refs] of owned) add(id, "work", WEIGHT.work, refs.length === 1 ? `has ${refs[0]}` : `has ${refs.length} linked PRs`);
  for (const { ticket, effortId } of input.titleTickets) add(effortId, "title", WEIGHT.title, `${ticket} in the title`);
  add(input.parentEffortId, "parent", WEIGHT.parent, "parent thread's effort");
  for (const item of input.classified) add(item.effortId, "classifier", CONFIDENCE_WEIGHT[item.confidence], item.signal);
  const names = new Map(input.efforts.map((effort) => [effort.id, effort.name]));
  return [...found].flatMap(([id, kinds]) => {
    if (!names.has(id)) return [];
    const strongest = KIND_ORDER.flatMap((kind) => kinds.get(kind) ?? []).sort((a, b) => b.weight - a.weight)[0]!;
    return [{ id, score: [...kinds.values()].reduce((sum, item) => sum + item.weight, 0), signal: strongest.text, top: strongest.weight }];
  }).sort((a, b) => b.score - a.score || b.top - a.top || names.get(a.id)!.localeCompare(names.get(b.id)!)).map(({ top: _, ...item }) => item);
}

/** A repository's service effort, where its PRs and threads that no effort has fall back to (A17.1). */
export { serviceName };

/**
 * The effort a thread's chip names. Explicit efforts win: the thread's own, then the one whose parent thread it is. Without either, the
 * card the deck places the thread on (deck-homes.ts): the effort its own PRs are in, or its repository's service card.
 */
export function threadEffortChip(input: {
  own: { id: string; name: string; oneOff: boolean } | null;
  coordinates: { id: string; name: string; oneOff: boolean } | null;
  /** Where the deck places the thread; null for a loose thread, or an effort the deck no longer has. */
  home: { kind: "effort"; effort: { id: string; name: string; oneOff: boolean } } | { kind: "service"; repo: string } | null;
  /** Your turn on the effort's or service's card; null when the deck draws no card for it. */
  yourTurn: (cardId: string) => number | null;
}): ThreadEffortPicker["chip"] {
  const effort = input.own ?? input.coordinates ?? (input.home?.kind === "effort" ? input.home.effort : null);
  if (effort) {
    const turn = input.yourTurn(effort.id);
    return { kind: "effort", effortId: effort.id, name: effort.name, oneOff: effort.oneOff, yourTurn: turn ?? 0, card: turn === null ? null : effort.id };
  }
  if (input.home?.kind === "service") {
    const turn = input.yourTurn(serviceId(input.home.repo));
    return { kind: "service", effortId: null, name: serviceName(input.home.repo), oneOff: false, yourTurn: turn ?? 0,
      card: turn === null ? null : serviceId(input.home.repo) };
  }
  return { kind: "none", effortId: null, name: "No effort", oneOff: false, yourTurn: 0, card: null };
}
