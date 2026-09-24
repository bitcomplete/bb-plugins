// "How this works": the secondary information the header used to carry, in
// one quiet panel. It is a fixed tab in BB's own right panel, so it can stay
// open beside the Map or the Board. Short sections, in the order a reader
// asks: how the groups are made, what the rows mean, the keys, the Map's
// marks, and whether the board is healthy.
import type { ReactNode } from "react";
import type { Board, BoardMode } from "./server";
import { INBOX_SECTION_LABEL, relativeTime } from "./workstreams";
import { TIER_WORDS } from "./threadmenu";
import { THREAD_TIERS } from "./threads";

/** The fixed tab's stable reference: the owning nav panel, and this tab. */
export const HOW_TAB = { panelId: "board", id: "how" } as const;

export const MODE_TEXT: Record<BoardMode, { label: string; detail: string }> = {
  basic: {
    label: "Tickets only",
    detail: "Clusters group by ticket and take the latest PR title as their summary. Add a TypeSafe key for Jev grouping.",
  },
  jev: {
    label: "Jev",
    detail: "Jev picks summaries from your PR titles and assigns clusters to efforts. Add an Anthropic key and Claude also names the groups.",
  },
  "jev+claude": {
    label: "Jev + Claude",
    detail: "Jev assigns clusters; Claude names the groups. Without the Anthropic key, groups keep the names Jev selected.",
  },
};

const BOARD_KEYS: [string, string][] = [
  ["j / k", "Next / previous row"],
  ["Enter", "Open the pull request"],
  ["a", "Run the row's action (asks first)"],
  ["t", "Open the most recent thread"],
  ["n", "Start a thread (asks first)"],
  ["m", "Show it on the Map"],
  ["o", "Open the checkout"],
  ["/", "Search"],
  ["Esc", "Clear search, then selection"],
];

const MAP_KEYS: [string, string][] = [
  ["+ / −", "Zoom in / out"],
  ["0 or Esc", "Fit everything"],
  ["Backspace", "Back out one level"],
  ["Arrows", "Pan"],
  ["[ / ]", "Turn to the other face"],
  ["T", "Open the focused cluster's newest thread"],
];

const BOTH_KEYS: [string, string][] = [
  ["v", "Switch between Map and Board"],
  ["?", "Open this panel"],
];

const STATES: [string, string][] = [
  ["Fix · CI failing", "A check failed. Investigate CI hands it to an agent."],
  ["Fix · Resolve conflicts", "GitHub reports a merge conflict with the base."],
  ["Respond · Changes requested", "A reviewer asked for changes; the ball is with you."],
  ["Respond · Approved, comments open", "Approved, but a reviewer's latest review still has comments."],
  [
    "Merge · Ready to merge",
    "Approved; every check finished and green; GitHub mergeStateStatus CLEAN (or HAS_HOOKS, or UNSTABLE for non-required checks); not stacked behind an unmerged PR.",
  ],
  ["Merge · Update branch", "Ready except the branch is behind its base."],
  ["Waiting · In review", "Nobody has decided yet. Nudge reviewers is one click away."],
  ["Waiting · Behind #N", "Stacked on an unmerged PR, which has to merge first."],
  ["Waiting · Blocked by branch rules", "Branch protection is unsatisfied; clicking merge would not help."],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 py-3 first:pt-0 last:border-b-0">
      <h3 className="mb-1.5 text-[12px] font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Pairs({ rows, mono }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([key, what]) => (
        <div key={key} className="contents">
          <dt className={mono ? "font-mono text-[11px] text-foreground" : "text-foreground"}>{key}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

const number = (value: number) => value.toLocaleString();

export function HowThisWorks({ board, now }: { board: Board | null; now: number }) {
  const mode = board === null ? null : MODE_TEXT[board.mode];
  const coverage = board?.threadCoverage;
  const enrichment = board?.health.enrichment ?? null;
  return (
    <div className="text-[12px]">
      <Section title="How grouping works">
        <p>
          Checkouts cluster by ticket, clusters roll up into efforts, and efforts into programs. Code seeds the
          groups from shared words; Jev assigns each cluster with a confidence score, and a low score lands in
          Unsorted. Claude only names groups and flags ones that look mixed. Counts and rollups are computed locally.
        </p>
        {mode === null ? null : (
          <p>
            <span className="text-foreground">Grouping: {mode.label}.</span> {mode.detail}
          </p>
        )}
      </Section>

      <Section title="What the states mean">
        <p>
          The Board sorts every checkout into {INBOX_SECTION_LABEL.fix}, {INBOX_SECTION_LABEL.respond},{" "}
          {INBOX_SECTION_LABEL.merge} and {INBOX_SECTION_LABEL.waiting}, oldest in state first, then folds in-flight,
          shipped and parked work away.
        </p>
        <Pairs rows={STATES} />
      </Section>

      <Section title="Keyboard shortcuts">
        <p className="text-foreground">Board</p>
        <Pairs rows={BOARD_KEYS} mono />
        <p className="pt-1 text-foreground">Map</p>
        <Pairs rows={MAP_KEYS} mono />
        <p className="pt-1 text-foreground">Both</p>
        <Pairs rows={BOTH_KEYS} mono />
      </Section>

      <Section title="Map marks">
        <Pairs
          rows={[
            ["Pause glyph", "Stuck: in progress or waiting, with no commits in a month or more."],
            ["Dashed rim", "Mixed grouping: Claude thought what is inside looked unrelated (Theme face)."],
            ["Small dot", "An agent thread works here; it pulses while running. Hover or click it for the list."],
          ]}
        />
      </Section>

      <Section title="Health">
        {board === null ? (
          <p>Loading…</p>
        ) : (
          <>
            <Pairs
              rows={[
                ["Last scan", board.lastScanAt === null ? "never" : new Date(board.lastScanAt).toLocaleString()],
                ["Refresh", `every ${board.health.refreshMinutes} min`],
                [
                  "Threads linked",
                  coverage === undefined
                    ? "—"
                    : `${coverage.linked} of ${coverage.threads}, to ${coverage.clustersWithThread} clusters`,
                ],
                ...THREAD_TIERS.map((tier): [string, string] => [`· ${TIER_WORDS[tier]}`, String(coverage?.byTier[tier] ?? 0)]),
                [
                  "Last enrichment",
                  enrichment === null
                    ? "not recorded yet"
                    : `${enrichment.calls} model ${enrichment.calls === 1 ? "call" : "calls"}, ${number(enrichment.inputTokens)} in / ${number(enrichment.outputTokens)} out tokens, ${relativeTime(enrichment.at, now)}`,
                ],
              ]}
            />
            {board.warnings.length === 0 ? null : (
              <ul className="list-disc space-y-1 pl-4 pt-1">
                {board.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Settings">
        <p>
          Scan roots, ticket pattern, API keys, merge method and branch deletion live on this plugin's page under{" "}
          <span className="text-foreground">Plugins → Workstreams</span>, or run{" "}
          <span className="font-mono text-[11px] text-foreground">bb plugin config workstreams</span>.
        </p>
      </Section>
    </div>
  );
}
