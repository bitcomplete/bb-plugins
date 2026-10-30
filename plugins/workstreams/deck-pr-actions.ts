import type { LiveItems } from "./deck-flow";
import type { CardScreen, Tone } from "./deck-view-model";
import { sendable, type ActionId, type InventoryLine } from "./inventory-view-model";

export type CardPrActionId = "restart" | "address" | "merge" | "confirm" | "nudge" | "request" | "ready" | "release" | "fix"
  | "hold" | "move" | "dismiss" | "undismiss" | "refresh" | "revoke";
export type CardPrAction = { id: CardPrActionId; label: string; enabled: boolean; why: string | null; title: string; tone: Tone; secondary: boolean };
export type CardPrContext = { live?: LiveItems; working?: ReadonlySet<string>; reading?: ReadonlySet<string> };
const FROM_INVENTORY: Partial<Record<ActionId, CardPrActionId>> = {
  "mark-ready": "ready", "request-review": "request", "confirm-handled": "confirm", nudge: "nudge", merge: "merge", revoke: "revoke",
};

/** The PR view supplies eligibility, labels and disabled reasons; the deck adds its existing per-PR workflows. */
export function cardPrActions(screen: CardScreen, prUrl: string, inventory: InventoryLine | undefined, context: CardPrContext = {}): CardPrAction[] {
  const line = screen.lines.find((line) => line.prUrl === prUrl && line.row && !line.ghost);
  if (!line?.row || !inventory || inventory.prUrl !== prUrl) return [];
  const row = line.row;
  const live = context.live?.get(prUrl);
  const writing = context.working?.has(prUrl) || live && ["pending", "sending", "sent"].includes(live.state);
  const busy = writing || line.dim ? "Another action on this PR is running or awaiting a fresh read" : null;
  const stopped = screen.card.pile !== "active" ? "Resume this effort before acting on its PRs" : null;
  const held = !!row.hold;
  const blocked = stopped ?? busy ?? (held ? "Release this PR's hold first" : null);
  const actions: CardPrAction[] = [];
  const add = (id: CardPrActionId, label: string, why: string | null, title: string, tone: Tone = "blue", secondary = false) =>
    actions.push({ id, label, enabled: why === null, why, title, tone, secondary });
  if (!held && !stopped && (row.turn.list !== "turn" || inventory.sent?.state === "idle" || inventory.sent?.state === "failed"))
    add("restart", "Start fresh thread", writing ? "Another action on this PR is starting" : null, `Start a new conversation to advance ${line.ref}; previous threads stay as they are`, "blue");
  if (!held && !stopped && row.turn.list === "turn") add("address", "Address feedback", busy ?? (!sendable(inventory) ? "This feedback cannot be addressed yet" : null),
    `Address feedback on ${line.ref} in one worker thread, with Undo`, "amber");
  if (held && !stopped) add("release", "Release hold…", busy, `Review and release the hold on ${line.ref}`, "gray");
  if (!held && !stopped && row.section === "work" && row.turn.list !== "turn" && row.thread) add("fix", "Ask thread to fix…", busy,
    `Ask ${row.thread.title} to fix ${line.ref}`);
  for (const item of inventory.actions) {
    const id = FROM_INVENTORY[item.id];
    if (!id || held && id !== "revoke" || stopped && id !== "revoke") continue;
    add(id, item.label, id === "revoke" ? busy ?? item.why ?? (!item.enabled ? "This action is unavailable" : null) : blocked ?? item.why ?? (!item.enabled ? "This action is unavailable" : null), item.title, id === "merge" || id === "confirm" ? "green" : "blue", id === "revoke");
  }
  if (!held && !stopped && inventory.authored) add("hold", "Hold…", busy, `Hold ${line.ref} and exclude it from action plans`, "gray", true);
  add("move", "Move…", stopped ?? busy, `Move ${line.ref} to another effort`, "gray", true);
  if (!held && !stopped && inventory.yourTurn && row.turn.list === "turn") add("dismiss", "Dismiss", busy,
    `Hide ${line.ref} from Your turn until its head moves or someone says something new`, "gray", true);
  if (!held && !stopped && row.turn.list === "dismissed") add("undismiss", "Undismiss", busy, `Put ${line.ref} back on Your turn`, "gray", true);
  const refresh = inventory.actions.find((action) => action.id === "refresh");
  if (refresh) add("refresh", context.reading?.has(prUrl) ? "Reading…" : "Refresh", context.reading?.has(prUrl) ? "Reading GitHub now" : refresh.why ?? (!refresh.enabled ? "Refresh is unavailable" : null),
    refresh.title, "gray", true);
  // The first enabled next action leads; other eligible actions remain beside it, and disabled merge gates explain stack order.
  const primary = FROM_INVENTORY[inventory.primary ?? "thread"];
  return actions.sort((a, b) => Number(a.secondary) - Number(b.secondary)
    || Number(b.id === "address" || b.id === "release") - Number(a.id === "address" || a.id === "release")
    || Number(b.id === primary) - Number(a.id === primary));
}

export type CardPrIntent =
  | { kind: "restart"; prUrl: string }
  | { kind: "batch"; action: "nudge" | "request" | "ready" | "release" | "fix"; effortId: string; prUrls: string[] }
  | { kind: "address"; effortId: string; prUrls: string[] }
  | { kind: "merge"; prUrl: string }
  | { kind: "notes"; effortId: string; prUrl: string; ref: string }
  | { kind: "hold"; prUrl: string; ref: string }
  | { kind: "move"; prUrls: string[]; refs: string[] }
  | { kind: "refresh"; prUrls: string[] }
  | { kind: "revoke"; prUrl: string }
  | { kind: "dismiss"; prUrl: string; dismiss: boolean };

/** Recheck the owning card and PR before dispatch. An Overview click never borrows the focused card or its selection. */
export function cardPrIntent(screen: CardScreen, prUrl: string, id: CardPrActionId, inventory: InventoryLine | undefined,
  context: CardPrContext = {}): CardPrIntent | null {
  if (!cardPrActions(screen, prUrl, inventory, context).some((action) => action.id === id && action.enabled)) return null;
  const line = screen.lines.find((line) => line.prUrl === prUrl)!;
  const effortId = screen.card.id;
  switch (id) {
    case "nudge": case "request": case "ready": case "release": case "fix": return { kind: "batch", action: id, effortId, prUrls: [prUrl] };
    case "restart": return { kind: "restart", prUrl };
    case "address": return { kind: "address", effortId, prUrls: [prUrl] };
    case "merge": return { kind: "merge", prUrl };
    case "confirm": return { kind: "notes", effortId, prUrl, ref: line.ref };
    case "hold": return { kind: "hold", prUrl, ref: line.ref };
    case "move": return { kind: "move", prUrls: [prUrl], refs: [line.ref] };
    case "refresh": return { kind: "refresh", prUrls: [prUrl] };
    case "revoke": return { kind: "revoke", prUrl };
    case "dismiss": case "undismiss": return { kind: "dismiss", prUrl, dismiss: id === "dismiss" };
  }
}
