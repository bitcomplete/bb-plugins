// Presentational pieces of the PR board. They draw the view model and markers; they decide nothing.
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Action, MarkerView, Stop, ViewModel } from "./board";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

export type Section = ViewModel["sections"][number];
export type Row = Section["groups"][number]["rows"][number];
export type Train = ViewModel["trains"][number];
export type Load = ViewModel["reviewer_load"];

// Host theme tokens, read from the variables bb defines in plugin panels; fallbacks for older themes.
export const MUTED = "text-[color:var(--subtle-foreground,var(--muted-foreground))]";
const LINK = "text-[color:var(--file-accent,var(--primary))]";
const WARN = "text-[color:var(--warning-text,var(--warning))]";
const SMALL_BUTTON = "h-[18px] px-1.5 text-[11px]";
// Area hues (simple.py assigns `tone`), toned down toward the muted text colour.
const TONE_HUES = ["var(--file-accent,#6a9fd8)", "var(--pr-merged,#a98bd6)", "var(--success,#5fae8a)",
  "var(--ansi-6,#5aaab5)", "var(--ansi-5,#c87ac8)", "var(--attention,#c8a24a)"];
const mix = (hue: string, amount = 75) => `color-mix(in oklch, ${hue} ${amount}%, var(--subtle-foreground,#888))`;
// Train dot colours by the PR's next move; the letter carries the meaning.
const DOT_HUES: Record<string, string> = {
  F: "var(--destructive-text,#e5534b)", C: "var(--destructive-text,#e5534b)", R: "var(--warning,#d4883a)",
  A: "var(--attention,#c8a24a)", W: "var(--pr-merged,#a98bd6)", "✓": "var(--success,#5fae8a)", D: "var(--subtle-foreground,#888)",
};
const REVIEW_MARK: Record<Row["reviewers"][number]["state"], [string, string]> = {
  requested: ["", "review requested"],
  approved: [" ✓", "approved the current head"],
  approved_old: [" ✓ old", "approved an older commit"],
  changes: [" ✗", "requested changes"],
};
export const ACTION_VERB: Record<Action, string> = {
  "fix-feedback": "fix the review feedback",
  rebase: "resolve the conflicts with main",
  "fix-ci": "fix the failing checks",
};
const MAX_START = 5;

export function ago(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

export function PrLink({ url, number, className }: { url: string; number: number; className?: string }) {
  const navigate = useBbNavigate();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Opens in bb's side panel; when bb declines, the anchor's own navigation (new tab) proceeds.
    if (navigate.openUrl(url)) event.preventDefault();
  };
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={onClick} className={cn("hover:underline", className)}>
      #{number}
    </a>
  );
}

function Reviewers({ reviewers }: { reviewers: Row["reviewers"] }) {
  if (reviewers.length === 0) return null;
  return (
    <span className={MUTED}>
      {reviewers.map((r, i) => {
        const [mark, meaning] = REVIEW_MARK[r.state];
        return (
          <span key={r.name} title={`${r.name} ${meaning}`} aria-label={`${r.name} ${meaning}`}>
            {i > 0 ? ", " : ""}
            {r.name}
            {mark}
          </span>
        );
      })}
    </span>
  );
}

function Size({ size, className }: { size: Row["size"]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", MUTED, className)} title={`${size.lines} lines changed in ${size.files} files`}>
      <span className="whitespace-nowrap">{size.label}</span>
      <span aria-hidden className="h-[3px] w-10 shrink-0 rounded-full bg-[color:var(--border,#8884)]">
        <span className="block h-full rounded-full bg-[color:var(--subtle-foreground,#888)]" style={{ width: `${Math.max(4, size.bar * 100)}%` }} />
      </span>
    </span>
  );
}

function MarkerLine({ marker }: { marker: MarkerView }) {
  const navigate = useBbNavigate();
  const open = marker.threadId
    ? (label: ReactNode) => (
        <button type="button" className={cn("hover:underline", LINK)} onClick={() => navigate.toThread(marker.threadId!)}>
          {label}
        </button>
      )
    : () => null;
  if (marker.status === "starting") return <span className={MUTED}>starting an agent…</span>;
  if (marker.status === "refused") return <span className={WARN}>not started: {marker.reason}</span>;
  if (marker.status === "live") return <span className={MUTED}>being worked on · {open(marker.title)}</span>;
  return <span className={MUTED}>worked on {ago(marker.at)} · {open("see thread")}</span>;
}

/** Inline confirmation for starting agents: which PRs, and where they stop. Never offers merge. */
export function Confirm({ action, rows, onStart, onCancel }: {
  action: Action;
  rows: { key: string; number: number; title: string }[];
  onStart: (keys: string[], stop: Stop) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(() => new Set(rows.map((r) => r.key)));
  const [stop, setStop] = useState<Stop>("publish");
  const chosen = rows.filter((r) => checked.has(r.key)).map((r) => r.key);
  const starting = chosen.slice(0, MAX_START);
  return (
    <div role="group" aria-label="Start agents" className="my-1.5 rounded-md border border-border p-2.5 text-[13px]">
      <p>
        Starts one agent thread per checked PR to {ACTION_VERB[action]}.{" "}
        {stop === "publish"
          ? "Each one pushes, replies on the review threads and re-requests review."
          : "Each one commits locally in its own worktree and reports; nothing is pushed or posted."}{" "}
        No agent merges.
      </p>
      <ul className="my-2 space-y-0.5">
          {rows.map((r) => (
            <li key={r.key}>
              <label className="flex items-baseline gap-2">
                <input
                  type="checkbox"
                  checked={checked.has(r.key)}
                  onChange={(event) => {
                    const next = new Set(checked);
                    if (event.target.checked) next.add(r.key);
                    else next.delete(r.key);
                    setChecked(next);
                  }}
                />
                <span className="font-mono text-[12px]">#{r.number}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{r.title}</span>
              </label>
            </li>
          ))}
      </ul>
      <fieldset className="my-2 flex flex-wrap gap-x-4 gap-y-1">
        <legend className={cn("mb-1 text-xs", MUTED)}>Stop at</legend>
        <label className="flex items-baseline gap-1.5">
          <input type="radio" name="stop" checked={stop === "prepare"} onChange={() => setStop("prepare")} />
          Prepare <span className={cn("text-xs", MUTED)}>commit locally and report</span>
        </label>
        <label className="flex items-baseline gap-1.5">
          <input type="radio" name="stop" checked={stop === "publish"} onChange={() => setStop("publish")} />
          Publish <span className={cn("text-xs", MUTED)}>push, reply, re-request review</span>
        </label>
      </fieldset>
      {chosen.length > MAX_START ? (
        <p className={cn("mb-2 text-xs", WARN)}>
          {chosen.length} selected; the first {MAX_START} will start ({starting.map((k) => `#${k.split("#")[1]}`).join(", ")}).
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={starting.length === 0} onClick={() => onStart(starting, stop)}>
          Start {starting.length}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function PrRow({ row, marker, confirming, onStart, renderConfirm }: {
  row: Row;
  marker: MarkerView | undefined;
  confirming: boolean;
  onStart: () => void;
  renderConfirm: () => ReactNode;
}) {
  const busy = marker !== undefined && marker.status !== "refused";
  const canStart = row.action !== null && !busy;
  return (
    <li className="py-[5px]" style={{ paddingLeft: `${row.depth * 16}px` }}>
      <div className="flex items-baseline gap-1">
        {row.depth > 0 ? <span aria-hidden className={cn("-ml-4 w-4 shrink-0 text-center", MUTED)}>└</span> : null}
        <PrLink url={row.url} number={row.number} className={cn("w-10 shrink-0 font-mono text-[12.5px]", LINK)} />
        <div className="flex min-w-0 flex-1 flex-col @min-[440px]:flex-row @min-[440px]:items-baseline @min-[440px]:gap-3">
          <span title={row.area} className="truncate text-[11px] @min-[440px]:w-[80px] @min-[440px]:shrink-0 @min-[600px]:w-[92px]" style={{ color: mix(TONE_HUES[row.tone % TONE_HUES.length]!) }}>
            {row.area}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {row.title}
                <span className={MUTED}> — {row.sentence}</span>
                {row.after ? (
                  <span className={cn("text-xs", MUTED)}>
                    {" "}· after <PrLink url={row.after.url} number={row.after.number} />
                  </span>
                ) : null}
                {canStart && !confirming ? (
                  <Button size="sm" variant="outline" className={cn(SMALL_BUTTON, "ml-2 align-baseline")} aria-label={`Start an agent on #${row.number}`} onClick={onStart}>
                    Start
                  </Button>
                ) : null}
              </span>
              <span className="hidden w-[132px] shrink-0 flex-col items-end text-right text-xs @min-[600px]:flex">
                <Reviewers reviewers={row.reviewers} />
                <Size size={row.size} />
              </span>
            </div>
            <div className={cn("flex flex-wrap items-center gap-x-2 text-xs @min-[600px]:hidden", MUTED)}>
              {row.reviewers.length > 0 ? <><Reviewers reviewers={row.reviewers} /><span aria-hidden>·</span></> : null}
              <Size size={row.size} />
            </div>
            {row.blocked ? <div className={cn("text-[12.5px]", WARN)}>Blocked by: {row.blocked}</div> : null}
            {marker ? <div className="mt-0.5 text-xs"><MarkerLine marker={marker} /></div> : null}
            {confirming ? renderConfirm() : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/** One line per stack: name, then lettered dots in merge order. Clicking filters the list to the stack. */
export function Trains({ trains, selected, onSelect }: { trains: Train[]; selected: string | null; onSelect: (train: Train) => void }) {
  const [focus, setFocus] = useState<{ train: string; key: string } | null>(null);
  return (
    <div className="space-y-1">
      <p className={cn("mb-1.5 flex flex-wrap gap-x-3 text-[11px]", MUTED)}>
        {[["F", "fix feedback"], ["C", "fix CI"], ["R", "rebase"], ["A", "ask for review"], ["W", "waiting"], ["✓", "ready"], ["D", "draft"]].map(([letter, label]) => (
          <span key={letter} className="inline-flex items-center gap-1">
            <Dot letter={letter!} /> {label}
          </span>
        ))}
      </p>
      {trains.map((train) => {
        const shown = focus?.train === train.id ? train.prs.find((p) => p.key === focus.key) : undefined;
        return (
          <div key={train.id} className={cn("rounded-md px-1.5 py-0.5", selected === train.id && "bg-[color:var(--state-active,#8883)]")}>
            <div className="flex flex-wrap items-start gap-x-3">
            <button type="button" aria-pressed={selected === train.id} onClick={() => onSelect(train)} title={train.name}
              className="mt-px w-full truncate text-left text-[13px] hover:underline @min-[440px]:w-[46%]">
              {train.name}
            </button>
            <div className="flex flex-wrap items-start">
              {train.prs.map((pr, i) => (
                <div key={pr.key} className="flex items-start">
                  {i > 0 ? <span aria-hidden className="mt-[9px] h-px w-3 bg-[color:var(--border,#8884)]" /> : null}
                  <button type="button" className="flex flex-col items-center" aria-label={`#${pr.number} ${pr.title}: ${pr.state}`}
                    onMouseEnter={() => setFocus({ train: train.id, key: pr.key })} onFocus={() => setFocus({ train: train.id, key: pr.key })}
                    onMouseLeave={() => setFocus(null)} onBlur={() => setFocus(null)} onClick={() => onSelect(train)}>
                    <Dot letter={pr.letter} big />
                    <span className={cn("font-mono text-[10.5px]", MUTED)}>#{pr.number}</span>
                  </button>
                </div>
              ))}
            </div>
            </div>
            {shown ? (
              <p className={cn("text-xs", MUTED)}>
                <span className="text-foreground">#{shown.number} {shown.title}</span> — {shown.sentence}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Dot({ letter, big = false }: { letter: string; big?: boolean }) {
  const hue = DOT_HUES[letter] ?? "var(--subtle-foreground,#888)";
  return (
    <span aria-hidden className={cn("inline-flex items-center justify-center rounded-full border font-semibold leading-none",
      big ? "size-[19px] text-[10px]" : "size-[13px] text-[8px]")} style={{ color: hue, borderColor: hue }}>
      {letter}
    </span>
  );
}

/** Appendix: one bar per reviewer (first review vs re-review), count and oldest wait. Clicking filters. */
export function ReviewerLoad({ load, selected, onSelect }: {
  load: Load;
  selected: string | null;
  onSelect: (label: string, keys: string[]) => void;
}) {
  const max = Math.max(1, ...load.reviewers.map((r) => r.count));
  return (
    <div className="space-y-1 pt-1">
      <p className={cn("flex flex-wrap gap-x-3 text-[11px]", MUTED)}>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-3 rounded-sm bg-[color:var(--file-accent,#6a9fd8)]" /> first review</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden className="h-2 w-3 rounded-sm bg-[color:var(--warning,#d4883a)]" /> re-review</span>
        <span>days since the request; ~ means since the last push</span>
      </p>
      {load.reviewers.map((r) => (
        <button key={r.name} type="button" aria-pressed={selected === r.name} onClick={() => onSelect(r.name, r.keys)}
          className={cn("flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] hover:bg-[color:var(--state-hover,#8882)]",
            selected === r.name && "bg-[color:var(--state-active,#8883)]")}>
          <span className="w-24 shrink-0 truncate">{r.name}</span>
          <span aria-hidden className="flex h-2.5 min-w-0 flex-1">
            <span className="flex h-full" style={{ width: `${(r.count / max) * 100}%` }}>
              <span className="h-full rounded-l-sm bg-[color:var(--file-accent,#6a9fd8)]" style={{ width: `${(r.first / r.count) * 100}%` }} />
              <span className="h-full rounded-r-sm bg-[color:var(--warning,#d4883a)]" style={{ width: `${(r.re / r.count) * 100}%` }} />
            </span>
          </span>
          <span className={cn("shrink-0 text-xs", MUTED)}>
            <b className="text-foreground">{r.count}</b> · {r.first} first, {r.re} re · oldest {r.approx ? "~" : ""}{r.oldest_days} d
          </span>
        </button>
      ))}
      {load.none.count > 0 ? (
        <button type="button" aria-pressed={selected === "No reviewer"} onClick={() => onSelect("No reviewer", load.none.keys)}
          className={cn("w-full rounded-md px-1 py-0.5 text-left text-[13px] hover:bg-[color:var(--state-hover,#8882)]", MUTED)}>
          No reviewer requested: <b className="text-foreground">{load.none.count}</b> PRs
        </button>
      ) : null}
    </div>
  );
}
