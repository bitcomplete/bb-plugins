import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@ui-sdk/react/collapsible";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Action, CalmRow, MarkerView, Stop, ViewModel } from "./board";

export type MineSegment =
  "on-you" | "agent" | "on-reviewers" | "drafts" | "ready";
export type MinePr = {
  row: CalmRow;
  marker: MarkerView | undefined;
  segment: MineSegment;
  needsInput: boolean;
};
export type AgentQuestionGroup = [MinePr, ...MinePr[]];
export function hasAgentQuestion(pr: MinePr): boolean {
  return pr.needsInput || (pr.marker?.status === "asking" && pr.marker.question !== null);
}
export function groupAgentQuestions(prs: MinePr[]): AgentQuestionGroup[] {
  const groups = new Map<string, AgentQuestionGroup>();
  for (const pr of prs) {
    const marker = pr.marker;
    if (!hasAgentQuestion(pr)) continue;
    const key = JSON.stringify([
      marker?.threadId ?? pr.row.key,
      marker?.question?.id ?? "pending-input",
    ]);
    const group = groups.get(key);
    if (group) group.push(pr);
    else groups.set(key, [pr]);
  }
  return [...groups.values()];
}
export const MINE_SEGMENTS: { id: MineSegment; label: string; tone: string }[] =
  [
    { id: "on-you", label: "on you", tone: "amber" },
    { id: "agent", label: "agent", tone: "blue" },
    { id: "on-reviewers", label: "on reviewers", tone: "purple" },
    { id: "drafts", label: "drafts", tone: "gray" },
    { id: "ready", label: "ready", tone: "green" },
  ];
export const ACTION_LABEL: Record<Action, string> = {
  "fix-feedback": "Fix feedback",
  "fix-ci": "Fix CI",
  rebase: "Rebase",
};

export function minePrs(
  view: ViewModel | null,
  markers: MarkerView[],
  pendingInput: Record<string, boolean> = {},
): MinePr[] {
  const byKey = new Map(markers.map((marker) => [marker.key, marker]));
  return (view?.prs ?? []).map((row) => {
    const marker = byKey.get(row.key);
    const needsInput = !!(marker?.threadId && pendingInput[marker.threadId]);
    const segment =
      needsInput ? "on-you" : marker?.status === "live" || marker?.status === "starting"
        ? "agent"
        : marker?.status === "asking" && marker.question
          ? "on-you"
          : row.segment;
    return { row, marker, segment, needsInput };
  });
}
export function isStartable(
  pr: MinePr,
): pr is MinePr & { row: CalmRow & { action: Action } } {
  return (
    pr.row.action !== null &&
    !pr.row.gate_blocked &&
    pr.segment === "on-you" &&
    (!pr.marker || pr.marker.status === "refused")
  );
}
export function sizeDiameter(lines: number): number {
  return (
    6 + 16 * Math.min(1, Math.max(0, (Math.log10(Math.max(1, lines)) - 1) / 3))
  );
}
export function compactLines(lines: number) {
  return lines >= 1000
    ? `${Number((lines / 1000).toFixed(1))}k`
    : String(lines);
}
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
}
export function rowTone(pr: MinePr): string {
  if (pr.segment === "agent") return "blue";
  if (hasAgentQuestion(pr)) return "question";
  if (pr.segment === "drafts") return "gray";
  if (pr.row.gate_blocked) return "gated";
  if (pr.segment === "on-reviewers") return "purple";
  if (pr.segment === "ready") return "green";
  if (pr.row.action === "rebase") return "orange";
  if (pr.row.action === "fix-ci") return "red";
  if (pr.row.action === "fix-feedback") return "coral";
  return "amber";
}
export function SizeDot({
  lines,
  tone,
  title,
  ring = false,
}: {
  lines: number | null;
  tone: string;
  title?: string;
  ring?: boolean;
}) {
  const diameter = lines === null ? 10 : sizeDiameter(lines);
  return (
    <span
      aria-hidden
      title={title}
      className={`calm-size-dot tone-${tone}${ring ? " ringed" : ""}`}
      style={{ width: diameter, height: diameter }}
    />
  );
}
export function CalmButton({
  children,
  primary,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={`calm-button${primary ? " primary" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function CalmDialog({
  title,
  description,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  busy?: boolean;
}) {
  const [opener] = useState(() => ({
    element: document.activeElement,
    url: window.location.href,
  }));
  const [open, setOpen] = useState(true);
  const finalFocus = (() => {
    const element = opener.element;
    if (
      busy ||
      window.location.href !== opener.url ||
      !(element instanceof HTMLElement) ||
      !element.isConnected
    )
      return "none";
    const visible =
      typeof element.checkVisibility === "function"
        ? element.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        : element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible";
    return visible ? element : "none";
  })();
  return (
    <Dialog
      open={open}
      dismissible={!busy}
      onOpenChange={(open, details) => {
        if (busy) details.cancel();
        else setOpen(open);
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogBackdrop className="calm-dialog-overlay" />
      <DialogContent className="calm-dialog" finalFocus={finalFocus}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children(() => {
          if (!busy) setOpen(false);
        })}
      </DialogContent>
    </Dialog>
  );
}
export function UnitBar<S extends string>({
  segments,
  items,
  selected,
  onSelect,
}: {
  segments: { id: S; label: string; tone: string }[];
  items: {
    key: string;
    segment: S;
    tone: string;
    label: string;
    outlined?: boolean;
  }[];
  selected: S;
  onSelect: (segment: S) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const nonempty = segments.filter((segment) =>
    items.some((item) => item.segment === segment.id),
  ).length;
  const minimumWidth = 4 * items.length + 4 * nonempty - 6;
  const proportional =
    items.length > 120 || (width > 0 && minimumWidth > width);
  return (
    <>
      <div
        ref={bar}
        className={`calm-unit-bar${proportional ? " proportional" : ""}`}
        aria-label={`${items.length} pull requests by status`}
      >
        {segments.map((segment) => {
          const members = items.filter((item) => item.segment === segment.id);
          return members.length === 0 ? null : (
            <button
              type="button"
              key={segment.id}
              className="calm-unit-segment"
              style={{
                flexGrow: members.length,
                opacity: selected === segment.id ? 1 : 0.32,
              }}
              title={`${members.length} ${segment.label}`}
              aria-label={`Show ${members.length} ${segment.label}`}
              aria-pressed={selected === segment.id}
              onClick={() => onSelect(segment.id)}
            >
              {proportional ? (
                <span className={`calm-unit-cell tone-${segment.tone}`} />
              ) : (
                members.map((item) => (
                  <span
                    key={item.key}
                    className={`calm-unit-cell tone-${item.tone}${item.outlined ? " outlined" : ""}`}
                    title={item.label}
                  />
                ))
              )}
            </button>
          );
        })}
      </div>
      <SegmentedControl
        data-prs-agent-local=""
        className="calm-counters"
        aria-label="Pull request status"
        value={selected}
        onValueChange={(next) => {
          if (next !== null) onSelect(next);
        }}
      >
        {segments.map((segment) => {
          const count = items.filter(
            (item) => item.segment === segment.id,
          ).length;
          return (
            <SegmentedControlItem
              key={segment.id}
              value={segment.id}
              disabled={count === 0}
              aria-label={`${count} ${segment.label}`}
              className="calm-counter"
            >
              <strong>{count}</strong>
              <span>
                <i className={`tone-${segment.tone}`} />
                {segment.label}
              </span>
            </SegmentedControlItem>
          );
        })}
      </SegmentedControl>
    </>
  );
}
export function SizeLegend({
  caption = "Easiest first",
}: {
  caption?: string;
}) {
  return (
    <div className="calm-legend">
      <span>{caption}</span>
      <span className="calm-size-key" aria-label="Dot size: 10 to 10,000 lines">
        {[10, 100, 1000, 10000].map((lines) => (
          <SizeDot key={lines} lines={lines} tone="gray" />
        ))}
        <span>10 → 10k lines</span>
      </span>
    </div>
  );
}
export function EffortGroup({
  title,
  count,
  tone = "amber",
  effort,
  action,
  children,
  folded,
  onToggle,
  dots,
}: {
  title: string;
  count: number;
  tone?: string;
  effort?: string;
  action?: ReactNode;
  children?: ReactNode;
  folded?: boolean;
  onToggle?: () => void;
  dots?: ReactNode;
}) {
  if (count === 0) return null;
  const header = (
    <div className="calm-group-header">
      <span className={`calm-group-count text-${tone}`}>{count}</span>
      {onToggle ? (
        <CollapsibleTrigger className="calm-group-toggle">
          <h2>{title}</h2>
          {folded ? <span className="calm-fold-dots">{dots}</span> : null}
          <span className="calm-chevron">{folded ? "›" : "⌄"}</span>
        </CollapsibleTrigger>
      ) : (
        <h2>{title}</h2>
      )}
      <span className="calm-effort">{effort}</span>
      {action}
    </div>
  );
  return onToggle ? (
    <Collapsible
      data-prs-agent-local=""
      render={<section />}
      className="calm-effort-group"
      aria-label={title}
      open={!folded}
      onOpenChange={onToggle}
    >
      {header}
      <CollapsiblePanel>{children}</CollapsiblePanel>
    </Collapsible>
  ) : (
    <section className="calm-effort-group" aria-label={title}>
      {header}
      {children}
    </section>
  );
}
export const Later = () => (
  <div className="calm-later">
    <span>Later</span>
    <span />
  </div>
);

function PrContext({
  pr,
  all,
  view,
  onStart,
  onReview,
  onConversation,
  startDisabled,
}: {
  pr: MinePr;
  all: MinePr[];
  view: ViewModel;
  onStart: (rows: CalmRow[], stop: Stop) => void;
  onReview: (key: string) => void;
  onConversation: (threadId: string) => void;
  startDisabled: boolean;
}) {
  const { row, marker } = pr;
  const threadId = marker?.threadId;
  const navigate = useBbNavigate();
  const train = view.trains.find((candidate) =>
    candidate.prs.some((member) => member.key === row.key),
  );
  const failCount = row.checks.filter((check) => check.state === "fail").length;
  const pendingCount = row.checks.filter(
    (check) => check.state === "pending",
  ).length;
  const canStart = isStartable(pr) ? row.action : null;
  return (
    <div
      className="calm-context"
      role="region"
      aria-label={`Context for ${row.title}`}
    >
      {train ? (
        <>
          <span className="calm-context-label">Stack</span>
          <div>
            <div className="calm-stack">
              {train.prs.map((member, index) => {
                const match = all.find(
                  (candidate) => candidate.row.key === member.key,
                );
                return (
                  <span key={member.key} className="calm-stack-part">
                    {index > 0 ? (
                      <i
                        className={match?.row.gate_blocked ? "gated-link" : ""}
                      />
                    ) : null}
                    <UrlLink
                      href={member.url}
                      title={`${member.number}: ${member.title}`}
                      className={`calm-stack-pr${member.key === row.key ? " current" : ""}${index === 0 ? " front" : ""}`}
                    >
                      <SizeDot
                        lines={match?.row.size.lines ?? null}
                        tone={match ? rowTone(match) : "gray"}
                      />
                      <span>#{member.number}</span>
                    </UrlLink>
                  </span>
                );
              })}
            </div>
            <p>
              {train.name}
              {train.prs[0] ? ` · ${train.prs[0].sentence}` : ""}
            </p>
          </div>
        </>
      ) : null}
      <span className="calm-context-label">Checks</span>
      <div>
        <div className="calm-checks">
          {row.checks.map((check, index) => (
            <span
              key={`${check.name}:${index}`}
              title={`${check.name}: ${check.state}`}
              aria-label={`${check.name}: ${check.state}`}
              className={`calm-check ${check.state}`}
            />
          ))}
        </div>
        <p className={failCount ? "text-red" : ""}>
          {row.checks.length === 0
            ? "No check results reported"
            : failCount
              ? `${failCount} of ${row.checks.length} failing`
              : pendingCount
                ? `${pendingCount} of ${row.checks.length} pending`
                : `${row.checks.length} checks complete`}
        </p>
      </div>
      <span className="calm-context-label">Review</span>
      <p>{row.review_summary || row.sentence}</p>
      <span className="calm-context-label">Size</span>
      <p>
        {compactLines(row.size.lines)} lines · {row.size.files} files
      </p>
      {row.gate_links.length ? (
        <>
          <span className="calm-context-label">Gate</span>
          <div>
            {row.gate_links.map((gate, index) => (
              <p key={index}>
                {gate.label}
                {gate.cleared_by ? (
                  <>
                    {" "}
                    ·{" "}
                    <button
                      type="button"
                      className="calm-link"
                      onClick={() => onReview(gate.cleared_by!)}
                    >
                      Review {gate.cleared_by.split("#").pop()} →
                    </button>
                  </>
                ) : null}
              </p>
            ))}
          </div>
        </>
      ) : null}
      {marker?.status === "refused" ? (
        <>
          <span className="calm-context-label">Agent</span>
          <p className="text-orange">Not started: {marker.reason}</p>
        </>
      ) : null}
      <span className="calm-context-label">Actions</span>
      <div className="calm-actions">
        {canStart ? (
          <CalmButton
            disabled={startDisabled}
            onClick={() =>
              onStart([row], row.group === "large" ? "prepare" : "publish")
            }
          >
            <span aria-hidden>▸</span>{" "}
            {row.group === "large" ? "Prepare fix" : ACTION_LABEL[canStart]}
          </CalmButton>
        ) : null}
        {threadId ? (
          marker?.status === "asking" && marker.question ? (
            <CalmButton onClick={() => navigate.toThread(threadId)}>Open thread</CalmButton>
          ) : (
            <CalmButton onClick={() => onConversation(threadId)}>Open conversation</CalmButton>
          )
        ) : null}
        <UrlLink href={row.url} className="calm-button">
          Open PR
        </UrlLink>
        <UrlLink href={`${row.url}/files`} className="calm-button">
          Diff
        </UrlLink>
      </div>
    </div>
  );
}
export function MineRow({
  pr,
  all,
  view,
  expanded,
  onExpand,
  onStart,
  onReview,
  onConversation,
  answer,
  busy,
  startDisabled,
  questionGroup,
}: {
  pr: MinePr;
  all: MinePr[];
  view: ViewModel;
  expanded: boolean;
  onExpand: () => void;
  onStart: (rows: CalmRow[], stop: Stop) => void;
  onReview: (key: string) => void;
  onConversation: (threadId: string) => void;
  answer: (pr: MinePr, option: string) => void;
  busy: boolean;
  startDisabled: boolean;
  questionGroup?: AgentQuestionGroup;
}) {
  const { row, marker } = pr;
  const threadId = marker?.threadId;
  const navigate = useBbNavigate();
  const question = marker?.status === "asking" ? marker.question : null;
  const displayedQuestion =
    questionGroup && questionGroup[0].row.key !== row.key ? null : question;
  const linkedPrCount = displayedQuestion
    ? (groupAgentQuestions(all).find((group) =>
        group.some((member) => member.row.key === row.key),
      )?.length ?? 1)
    : 0;
  const startable = isStartable(pr) ? row.action : null;
  const meta = pr.needsInput ? "Agent needs your input" :
    question && !displayedQuestion
      ? "Waiting on shared agent question"
      : pr.segment === "agent"
        ? marker?.status === "starting"
          ? "starting…"
          : `working · ${marker ? age(marker.at) : ""}`
        : pr.segment === "on-reviewers"
          ? row.waiting
              .map(
                (person) =>
                  `${person.name}${person.days === null ? "" : ` · ${person.approx ? "~" : ""}${person.days}d`}`,
              )
              .join(", ")
          : row.repo === "parsleyhealth/parsley-monorepo"
            ? ""
            : row.repo;
  const cleared = row.gate_links.find((gate) => gate.cleared_by)?.cleared_by;
  return (
    <Collapsible
      data-prs-agent-local=""
      render={<li />}
      open={expanded}
      onOpenChange={onExpand}
      aria-label={`Context for ${row.title} #${row.number}`}
      className={`calm-pr${expanded ? " expanded" : ""}${displayedQuestion || pr.needsInput ? " question-row" : ""}`}
      data-pr-key={row.key}
    >
      <div className="calm-row">
        <span className="calm-dot-column">
          <SizeDot
            lines={row.size.lines}
            tone={rowTone(pr)}
            ring={pr.segment === "agent"}
          />
          {startable ? (
            <Checkbox
              data-prs-agent-local=""
              className="calm-row-checkbox"
              value={row.key}
              aria-label={`Select ${row.title} #${row.number}`}
            >
              <CheckboxIndicator aria-hidden>✓</CheckboxIndicator>
            </Checkbox>
          ) : null}
        </span>
        <div className="calm-row-content">
          <div className="calm-row-line">
            <CollapsibleTrigger
              className="calm-title"
              title={`${compactLines(row.size.lines)} lines · #${row.number}`}
            >
              {displayedQuestion?.prompt ?? row.title}
            </CollapsibleTrigger>
            <UrlLink
              href={row.url}
              className="calm-pr-number"
              title={`${row.title} #${row.number}`}
            >
              #{row.number}
            </UrlLink>
            {meta ? <span className="calm-row-meta">{meta}</span> : null}
            {cleared ? (
              <button
                type="button"
                className="calm-link calm-gate-review"
                onClick={() => onReview(cleared)}
              >
                Review #{cleared.split("#").pop()} →
              </button>
            ) : null}
            <span className="calm-row-actions">
              {startable ? (
                <CalmButton
                  disabled={busy || startDisabled}
                  onClick={() =>
                    onStart(
                      [row],
                      row.group === "large" ? "prepare" : "publish",
                    )
                  }
                  aria-label={`${row.group === "large" ? "Prepare" : ACTION_LABEL[startable]} agent for ${row.title} #${row.number}`}
                >
                  <span aria-hidden>▸</span>{" "}
                  {row.group === "large" ? "Prepare" : ACTION_LABEL[startable]}
                </CalmButton>
              ) : threadId ? (
                <button
                  type="button"
                  className="calm-link"
                  onClick={() => onConversation(threadId)}
                >
                  Open conversation →
                </button>
              ) : null}
            </span>
          </div>
          {marker?.report ? (
            <div className="calm-agent-report">
              <span className="calm-agent-report-label">
                Agent reported{marker.report.kind === "result" ? ` · ${marker.report.outcome}` : " · progress"}
              </span>
              <p>{marker.report.summary}</p>
              {marker.report.kind === "result" && marker.report.detail ? <p>{marker.report.detail}</p> : null}
            </div>
          ) : null}
          {displayedQuestion && questionGroup && linkedPrCount > 1 ? (
            <p className="calm-question-scope">
              {linkedPrCount === questionGroup.length
                ? `${linkedPrCount} linked PRs · agent thread`
                : `${linkedPrCount} PRs in shared thread · ${questionGroup.length} shown`}
            </p>
          ) : null}
          {displayedQuestion ? (
            <div className="calm-question-options">
              {displayedQuestion.options.map((option) => (
                <CalmButton
                  key={option.id}
                  disabled={busy || marker?.answering}
                  onClick={() => answer(pr, option.id)}
                >
                  {option.label}
                </CalmButton>
              ))}
            </div>
          ) : null}
          {displayedQuestion && marker?.answerError ? (
            <p role="alert" className="calm-answer-error">
              {marker.answerError}
              {threadId ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="calm-link"
                    onClick={() => navigate.toThread(threadId)}
                  >
                    Open thread →
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
      <CollapsiblePanel>
        <PrContext
          pr={pr}
          all={all}
          view={view}
          onStart={onStart}
          onReview={onReview}
          onConversation={onConversation}
          startDisabled={busy || startDisabled}
        />
      </CollapsiblePanel>
    </Collapsible>
  );
}
export function ReviewersView({
  rows,
  renderRow,
}: {
  rows: MinePr[];
  renderRow: (pr: MinePr) => ReactNode;
}) {
  const [person, setPerson] = useState<string | null>(null);
  const people = new Map<
    string,
    { name: string; prs: MinePr[]; oldest: number | null; approx: boolean }
  >();
  for (const pr of rows)
    for (const waiting of pr.row.waiting) {
      const entry = people.get(waiting.login) ?? {
        name: waiting.name,
        prs: [],
        oldest: null,
        approx: false,
      };
      entry.prs.push(pr);
      if (
        waiting.days !== null &&
        (entry.oldest === null || waiting.days >= entry.oldest)
      ) {
        entry.oldest = waiting.days;
        entry.approx = waiting.approx;
      }
      people.set(waiting.login, entry);
    }
  const fronts = rows.filter(
    (pr) => pr.row.stack_front && pr.row.stack !== null,
  );
  const covered = new Set(
    [...people.values()].flatMap((entry) => entry.prs.map((pr) => pr.row.key)),
  );
  return (
    <>
      <p className="calm-view-caption">
        Each dot is a PR waiting on them · bright = 4 days or more
      </p>
      <EffortGroup
        title={`Waiting on ${people.size} ${people.size === 1 ? "person" : "people"}`}
        count={rows.length}
        tone="purple"
      >
        {[...people]
          .sort((a, b) => (b[1].oldest ?? -1) - (a[1].oldest ?? -1))
          .map(([login, entry]) => (
            <Collapsible
              data-prs-agent-local=""
              key={login}
              open={person === login}
              onOpenChange={(open) => setPerson(open ? login : null)}
              aria-label={`Pull requests waiting on ${entry.name}`}
            >
              <CollapsibleTrigger className="calm-person-row">
                <span className="calm-dot-column">
                  <SizeDot lines={30} tone="purple" />
                </span>
                <span className="calm-person-name">{entry.name}</span>
                <span className="calm-person-dots">
                  {entry.prs.map((pr) => (
                    <i
                      key={pr.row.key}
                      className={
                        pr.row.waiting.some(
                          (waiting) =>
                            waiting.login === login && (waiting.days ?? 0) >= 4,
                        )
                          ? "bright"
                          : ""
                      }
                      title={`#${pr.row.number}: ${pr.row.title}`}
                    />
                  ))}
                </span>
                <span
                  className={`calm-person-age${(entry.oldest ?? 0) >= 4 ? " text-amber" : ""}`}
                >
                  {entry.oldest === null
                    ? "age unknown"
                    : `oldest ${entry.approx ? "~" : ""}${entry.oldest}d`}
                </span>
              </CollapsibleTrigger>
              <CollapsiblePanel render={<ul />}>
                {entry.prs.map(renderRow)}
              </CollapsiblePanel>
            </Collapsible>
          ))}
        <ul>{rows.filter((pr) => !covered.has(pr.row.key)).map(renderRow)}</ul>
      </EffortGroup>
      <EffortGroup
        title="Holding the front of a stack"
        count={fronts.length}
        tone="purple"
      >
        <ul>{fronts.map(renderRow)}</ul>
      </EffortGroup>
    </>
  );
}
export function FoldDots({ rows }: { rows: MinePr[] }) {
  return (
    <>
      {rows.map((pr) => (
        <SizeDot
          key={pr.row.key}
          lines={pr.row.size.lines}
          tone={rowTone(pr)}
        />
      ))}
    </>
  );
}
