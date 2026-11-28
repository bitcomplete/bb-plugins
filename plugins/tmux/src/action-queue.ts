import { getBridge } from "./bridge";
import { ATTRIBUTES } from "./constants";
import { getFocusedPaneElement, isPaneZoomed } from "./dom-actions";
import { hasFocusWaitGivenUp, isFocusPending } from "./pane-focus";
import type { Action, ActionType } from "./types";

const SETTLE_TIMEOUT_MS = 1000;

// The actions that move the focus to another pane or change what a pane
// shows. bb follows them a moment later: it marks the focused pane in a later
// task, and the layout that plugins get comes later still.
const PANE_CHANGING_ACTIONS: ReadonlySet<ActionType> = new Set([
  "pane.focus",
  "pane.neighbour",
  "pane.next",
  "pane.previous",
  "pane.last",
  "pane.close",
  "thread.jump",
  "thread.end",
  "thread.cycle",
  "thread.last",
]);

const PANE_MOVES: ReadonlySet<ActionType> = new Set([
  "pane.focus",
  "pane.neighbour",
  "pane.next",
  "pane.previous",
  "pane.last",
]);

// The moves that are an error in tmux when they find nothing to go to: no
// pane on that side, no last pane, no such window, no other window. An error
// ends the command sequence there.
const MOVES_WITH_ERROR: ReadonlySet<ActionType> = new Set([
  "pane.neighbour",
  "pane.last",
  "thread.jump",
  "thread.end",
  "thread.cycle",
  "thread.last",
]);

let cancelWaiting: (() => void) | null = null;

// Drops the actions of a key that still wait for bb.
export function cancelQueuedActions(): void {
  cancelWaiting?.();
  cancelWaiting = null;
}

// The page and the layout that plugins get name the same focused pane, and
// nothing of this plugin still waits for bb to show a pane or a thread.
function hasBbCaughtUp(): boolean {
  if (isFocusPending()) return false;
  const layout = getBridge()?.layout ?? null;
  if (layout === null) return true;
  const focused = layout.panes.find((pane) => pane.isFocused);
  if (focused === undefined) return false;
  const shown = getFocusedPaneElement()?.getAttribute(ATTRIBUTES.paneId);
  return shown === focused.paneId;
}

// The rest is dropped when bb does not get there in time: the pane that the
// next action would act on is then not known.
function resumeOnceBbHasCaughtUp(resume: () => void): void {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let frame = 0;
  const poll = (): void => {
    if (Date.now() >= deadline || hasFocusWaitGivenUp()) {
      cancelWaiting = null;
      return;
    }
    if (!hasBbCaughtUp()) {
      frame = requestAnimationFrame(poll);
      return;
    }
    cancelWaiting = null;
    resume();
  };
  cancelWaiting = () => cancelAnimationFrame(frame);
  frame = requestAnimationFrame(poll);
}

function focusedPaneId(): string | null {
  const panes = getBridge()?.layout?.panes ?? [];
  return panes.find((pane) => pane.isFocused)?.paneId ?? null;
}

// Runs the actions of one key in their order, as tmux runs the commands of a
// binding: each one acts on what the one before it left behind. So after an
// action that bb needs a moment to follow, the next one waits for bb. run
// says whether the action found something to act on. A move that is an error
// in tmux then ends the sequence, and onFailure is called for every other
// action that found nothing.
// tmux removes the zoom when a pane move goes to another pane, so a zoom
// behind such a move always leaves that pane zoomed. bb's zoom follows the
// focus, so the pane is zoomed already then and the zoom is left as it is.
export function runActionsInOrder(
  actions: readonly Action[],
  run: (action: Action) => boolean,
  onFailure: () => void,
): void {
  cancelQueuedActions();
  const runFrom = (start: number, hasMovedBefore: boolean): void => {
    let hasMoved = hasMovedBefore;
    for (let at = start; at < actions.length; at += 1) {
      const action = actions[at];
      const paneBefore = focusedPaneId();
      const isZoomDone = action.type === "pane.zoom" && hasMoved && isPaneZoomed();
      if (action.type === "pane.zoom") hasMoved = false;
      if (!isZoomDone && !run(action)) {
        if (MOVES_WITH_ERROR.has(action.type)) return;
        onFailure();
      }
      const isLast = at === actions.length - 1;
      const mustWait =
        !isLast && PANE_CHANGING_ACTIONS.has(action.type) && isFocusPending();
      if (!mustWait) continue;
      const hadMoved = hasMoved;
      const isMove = PANE_MOVES.has(action.type);
      resumeOnceBbHasCaughtUp(() =>
        runFrom(at + 1, hadMoved || (isMove && focusedPaneId() !== paneBefore)),
      );
      return;
    }
  };
  runFrom(0, false);
}
