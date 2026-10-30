/**
 * The Stage and Status entries in bb's thread menus.
 *
 * The same two pins the Brief panel offers, reachable from every thread actions
 * menu — the header's, the sidebar row's and its right-click menu, the compact
 * long-press drawer — and, when the user picks them, as a row's quick-action
 * button. Without these, correcting what the summarizer concluded means opening
 * the thread and then its Brief tab, on exactly the thread you had just decided
 * was finished with.
 *
 * Pure: `item` in a thread action registration must be synchronous and derive
 * everything from the thread and the registration's data, so the builders here
 * take the row signal and the two writes and return the action. The data side —
 * where the signals come from — is in `app.tsx`.
 */
import type { PluginThreadAction } from "@get-bb/plugin-sdk/app";
// Types only, for the same reason as in `app.tsx`: `contract.ts` reaches the
// SDK root, which the app build cannot resolve.
import type { RowSignal } from "./contract.js";
import {
  BRIEF_STAGES,
  STORED_BRIEF_STATUSES,
  type BriefStage,
  type StoredBriefStatus,
} from "./shared.js";
import { STAGE_LABELS, STATUS_LABELS, stageRingIcon } from "./brief.js";

/** The two writes the actions make; each re-announces, so no reply is needed. */
export interface PinWrites {
  setStage(threadId: string, stage: BriefStage | null): Promise<void>;
  setStatus(threadId: string, status: StoredBriefStatus | null): Promise<void>;
}

/** The panel's own pin note, so a pin reads the same wherever it was made. */
const PIN_HINT =
  "Set by hand · clears on the next turn. Pick it again to hand it back to the summary.";

/** Suffix for the value on the action's second line when a human chose it. */
const BY_HAND = " · set by hand";

function isStage(value: string | undefined): value is BriefStage {
  return (BRIEF_STAGES as readonly string[]).includes(value ?? "");
}

function isStoredStatus(value: string | undefined): value is StoredBriefStatus {
  return (STORED_BRIEF_STATUSES as readonly string[]).includes(value ?? "");
}

/**
 * The Stage action for one thread, or null when it has no brief.
 *
 * Hidden rather than disabled on a thread with no brief: the server ignores a
 * pin on a brief that does not exist, and an action that can do nothing on most
 * new threads is noise in a menu bb shares with its own actions.
 */
export function stageAction(
  signal: RowSignal | undefined,
  writes: PinWrites,
): PluginThreadAction | null {
  if (signal === undefined) return null;
  const { threadId, stage, stageOverride } = signal;
  return {
    label: "Stage",
    detail: `${STAGE_LABELS[stage]}${stageOverride === null ? "" : BY_HAND}`,
    // The bare ring: no project colour and no live marks, because this is the
    // stage itself rather than the row it decorates.
    icon: stageRingIcon(stage),
    choices: {
      ...(stageOverride === null ? {} : { hint: PIN_HINT }),
      items: BRIEF_STAGES.map((option) => ({
        id: option,
        label: STAGE_LABELS[option],
        icon: stageRingIcon(option),
        selected: option === stage,
      })),
    },
    run: async ({ value }) => {
      if (!isStage(value)) return;
      // As in the panel: picking the stage already pinned clears the pin and
      // hands the judgement back to the summarizer.
      await writes.setStage(threadId, value === stageOverride ? null : value);
    },
  };
}

/**
 * The Status action for one thread, or null when it has no brief.
 *
 * `working` is the live fold the row glyph makes: while the agent runs the
 * thread *is* working, whatever its last brief concluded, so that is what the
 * action says and what it marks selected. It is never offered as a choice —
 * pinning a thread to "working" would be pinning it to a fact about right now.
 */
export function statusAction(
  signal: RowSignal | undefined,
  working: boolean,
  writes: PinWrites,
): PluginThreadAction | null {
  if (signal === undefined) return null;
  const { threadId, statusOverride } = signal;
  const status = working ? "working" : signal.status;
  return {
    label: "Status",
    detail: `${STATUS_LABELS[status]}${statusOverride === null ? "" : BY_HAND}`,
    icon: "CircleDot",
    choices: {
      ...(statusOverride === null ? {} : { hint: PIN_HINT }),
      items: STORED_BRIEF_STATUSES.map((option) => ({
        id: option,
        label: STATUS_LABELS[option],
        selected: option === status,
      })),
    },
    run: async ({ value }) => {
      if (!isStoredStatus(value)) return;
      await writes.setStatus(threadId, value === statusOverride ? null : value);
    },
  };
}
