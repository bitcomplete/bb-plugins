/**
 * The two pin controls and the labelled field, shared by the Brief panel and the
 * board's expanded card.
 *
 * Extracted out of `app.tsx` when the board arrived, and given props rather than
 * a whole {@link ResolvedBrief}: the board holds a card, not a resolved brief,
 * and these only ever read four values. It is also the board's answer to touch
 * — drag-and-drop is a pointer affordance, so the expanded card has to offer the
 * same two writes as a tappable control, and the honest way to do that is the
 * control the panel already uses rather than a second one that looks different.
 */
import { useEffect, useState } from "react";
import {
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type {
  BlockReason,
  BriefStage,
  BriefStatus,
  StoredBriefStatus,
} from "./contract.js";
import { BRIEF_STAGES, STORED_BRIEF_STATUSES } from "./shared.js";
import { STAGE_LABELS, STATUS_LABELS, stageRingIcon } from "./brief.js";

/**
 * The longest a reason may be, mirrored from the contract so the input can
 * stop at the limit rather than let the server refuse the write. Kept as a
 * literal because `contract.ts` cannot be imported for its values here — see
 * the note at the top of `shared.ts`.
 */
const MAX_REASON_LENGTH = 240;

export function Field({ label, value }: { label: string; value: string }) {
  if (value.trim() === "") return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm leading-snug text-foreground">{value}</div>
    </div>
  );
}

/** The note under a control saying a pin is in force and how it ends. */
function PinNote() {
  return (
    <div className="text-[11px] text-muted-foreground">
      Set by hand · clears on the next turn
    </div>
  );
}

/** A date for the note's byline, short enough to sit on the same line. */
function noteDate(recordedAt: number): string {
  return new Date(recordedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The user's own reason for a block: shown as theirs, editable, clearable.
 *
 * It is drawn as *a note from you* and not in the Blocked-on slot, because the
 * two are different things. The slot is what the model made of the thread —
 * including of this note, which it is handed as a fact — and the note is what
 * you typed. Showing the note verbatim where the model's words go would claim
 * the brief said it; hiding it would leave something steering every summary
 * with no way to see or stop it.
 *
 * Under the status buttons rather than beside the field, because this is where
 * a block is set by hand: pick Blocked, say why. The editor opens on its own
 * when Blocked is pinned with no reason yet, so the gesture is one click and
 * a line of typing, and the reason is optional — closing the editor leaves a
 * plain pin.
 */
export function BlockReasonControl({
  status,
  statusOverride,
  blockReason,
  onSet,
}: {
  status: BriefStatus;
  statusOverride: StoredBriefStatus | null;
  blockReason: BlockReason | null;
  onSet: (text: string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // A Blocked pin just placed, with nothing said yet, is the moment to ask.
  // Keyed on the pin rather than the status so a model-read Blocked does not
  // open an editor nobody asked for.
  const invite = statusOverride === "waiting-on-other" && blockReason === null;
  useEffect(() => {
    if (invite) setDraft((current) => current ?? "");
  }, [invite]);

  const editing = draft !== null;
  if (!editing && blockReason === null && status !== "waiting-on-other") {
    return null;
  }

  const save = () => {
    const text = (draft ?? "").trim();
    setDraft(null);
    if (text === "" && blockReason === null) return;
    onSet(text === "" ? null : text);
  };

  if (editing) {
    return (
      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="block text-[11px] text-muted-foreground">
          Why is it blocked? The summary will carry it until it is resolved.
          <input
            autoFocus
            value={draft}
            maxLength={MAX_REASON_LENGTH}
            placeholder="waiting on the design review · not before the release"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
            }}
            className="mt-1 w-full rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
          />
        </label>
        <div className="flex gap-1">
          <button
            type="submit"
            className="rounded border border-border px-1.5 py-0.5 text-xs text-foreground hover:bg-card"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setDraft(null)}
            className="rounded border border-transparent px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-card"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (blockReason === null) {
    return (
      <button
        type="button"
        onClick={() => setDraft("")}
        className="text-[11px] text-muted-foreground hover:text-foreground"
      >
        Add a reason…
      </button>
    );
  }

  return (
    <div className="space-y-0.5 rounded border border-border bg-card/50 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>Your note · {noteDate(blockReason.recordedAt)}</span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => setDraft(blockReason.text)}
            className="hover:text-foreground"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onSet(null)}
            className="hover:text-foreground"
          >
            Clear
          </button>
        </span>
      </div>
      <div className="text-sm leading-snug text-foreground">{blockReason.text}</div>
      <div className="text-[11px] text-muted-foreground">
        Guides every summary until you clear it, or write to the thread and it
        reads as resolved.
      </div>
    </div>
  );
}

export function StageControl({
  stage,
  stageOverride,
  onPick,
}: {
  /** The effective stage — the pin if one holds, else the model's judgement. */
  stage: BriefStage;
  /** The pin, only while it is still in force. */
  stageOverride: BriefStage | null;
  onPick: (stage: BriefStage | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Stage
      </div>
      <div className="flex flex-wrap gap-1">
        {BRIEF_STAGES.map((option) => {
          const isActive = stage === option;
          const isManual = stageOverride === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isActive}
              // Picking the stage that is already manually set clears the
              // override and hands the judgement back to the summarizer.
              onClick={() => onPick(isManual ? null : option)}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {/*
                Each option next to its own ring, which is where the sidebar's
                glyph is learned: four labelled rings in a row say what a single
                ring on a row cannot.
              */}
              <Icon
                name={stageRingIcon(option)}
                className="h-3 w-3 shrink-0"
                aria-hidden
              />
              {STAGE_LABELS[option]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {stageOverride !== null ? <PinNote /> : null}
    </div>
  );
}

/**
 * The manual status, in the same shape as the stage control beside it.
 *
 * Status is otherwise derived from the brief's own prose, which has no way to
 * learn that a `nextStep` addressed to you was carried out somewhere the
 * transcript cannot see — reload a client, confirm a rollout, check a glyph.
 * Doing it leaves no trace to summarize, so without this the thread is
 * "Waiting on you" for good. Dragging its sidebar row elsewhere does not help:
 * sections are keyed on this status, so the next reconcile files it straight
 * back.
 *
 * No rings beside the options, unlike the stage control. The row glyph draws
 * the *stage*, and only `done` gets a status treatment at all (tone, and the
 * closed ring in place of the stage), so three labelled rings here would be two
 * identical glyphs and a claim that status is what the row shows.
 *
 * `status` is the full union rather than the three a pin may take, because the
 * live `working` is a thing this control has to be able to *display* as active
 * without offering it: pinning a thread to "working" would be pinning it to a
 * fact about right now.
 */
export function StatusControl({
  status,
  statusOverride,
  blockReason,
  onPick,
  onSetBlockReason,
}: {
  status: BriefStatus;
  statusOverride: StoredBriefStatus | null;
  blockReason: BlockReason | null;
  onPick: (status: StoredBriefStatus | null) => void;
  onSetBlockReason: (text: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Status
      </div>
      <div className="flex flex-wrap gap-1">
        {STORED_BRIEF_STATUSES.map((option) => {
          const isActive = status === option;
          const isManual = statusOverride === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isActive}
              // Picking the status that is already pinned clears the override
              // and hands the judgement back to the derivation.
              onClick={() => onPick(isManual ? null : option)}
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-card"
              }`}
            >
              {STATUS_LABELS[option]}
              {isManual ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {statusOverride !== null ? <PinNote /> : null}
      <BlockReasonControl
        status={status}
        statusOverride={statusOverride}
        blockReason={blockReason}
        onSet={onSetBlockReason}
      />
    </div>
  );
}
