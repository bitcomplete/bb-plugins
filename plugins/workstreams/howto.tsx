// "How this works": the secondary information the header used to carry, in
// one quiet panel. It is a fixed tab in BB's own right panel, so it can stay
// open beside any view. Short sections, in the order a reader asks: the
// views, the effort deck, its piles and holds, sorting PRs into efforts, Seed
// from Linear, All PRs, the keys, then the Map, and whether the board is
// healthy.
import type { ReactNode } from "react";
import type { Board, BoardMode } from "./server";
import { relativeTime } from "./workstreams";
import { TIER_WORDS } from "./threadmenu";
import { THREAD_TIERS } from "./threads";
import { runLabel } from "./runs";
import { INVENTORY_HOW } from "./inventory-view-model";
import { ACTION } from "./deck-keys";
import { SEND_DELAY_MS } from "./deck-shared";

/** The fixed tab's stable reference: the owning nav panel, and this tab. */
export const HOW_TAB = { panelId: "board", id: "how" } as const;

export const MODE_TEXT: Record<BoardMode, { label: string; detail: string }> = {
  basic: {
    label: "Tickets only",
    detail: "Clusters group by ticket and take the latest PR title as their summary. Add a TypeSafe key for Jev grouping.",
  },
  jev: {
    label: "Jev",
    detail: "Jev picks summaries from your PR titles and assigns clusters to efforts. Add an Anthropic key and Claude Sonnet 5 also names the groups.",
  },
  "jev+claude": {
    label: "Jev + Claude",
    detail: "Jev assigns clusters; Claude names the groups. Without the Anthropic key, groups keep the names Jev selected.",
  },
};

const MAP_KEYS: [string, string][] = [
  ["+ / −", "Zoom in / out"],
  ["0 or Esc", "Fit everything"],
  ["Backspace", "Back out one level"],
  ["Arrows", "Pan"],
  ["[ / ]", "Turn to the other face"],
  ["T", "Open the focused cluster's newest thread"],
];

/** The deck's keys that matter most, read from its one registry so they say what the keys do; ? in the deck lists every one. */
const DECK_KEYS: [string, string][] = (["next", "prev", "jump", "row-next", "row-prev", "select", "expand", "advance", "merge", "hold", "accept", "move", "seen",
  "undo", "palette", "help"] as const).map((id) => [ACTION[id].keys.join(" / "), ACTION[id].title.replace("…", "")]);

const BOTH_KEYS: [string, string][] = [
  ["v", "Next view; in Efforts and All PRs, switch between the two"],
  ["⌘K", "Go to a view; in Efforts and All PRs, list every action"],
  ["?", "Open this panel; in Efforts and All PRs, list their keys"],
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
      <Section title="Views">
        <p>
          Every view shares one header: Efforts, All PRs, and More, which holds Map, Efforts admin, and How it
          works. Its right side shows when the view last read its data, Mark seen where the view has it, ⌘K, and ?.
        </p>
      </Section>

      <Section title="The effort deck">
        <p>
          Overview comes first in Efforts and takes no number key. Its action matrix shows Your turn and what&apos;s blocked
          in each effort, Aging blockers lists the oldest waits on others, and each effort&apos;s tile names its next
          step. Select any of them to open that effort&apos;s card.
        </p>
        <p>
          After Overview, Efforts shows one card per effort. Flip with [ and ] (or ← and →), or press 1–9. A card opens on
          its finish line, how many tickets are done, its date, and its ETA at the last two weeks&apos; pace (p opens what&apos;s
          left, by Linear priority and points too, who holds it, and whether it&apos;s moving), then up to three moves. Each
          move is one outcome, one verb, and one key, over the PRs it touches in All PRs&apos; own rows, each row with its
          ticket and that ticket&apos;s priority. Moves rank by one rule: someone waits on you (Address, b), one step from
          merged (Merge, m, then Confirm, c), your blockers (Fix, f), a reviewer holding a PR four days or more (Nudge, n,
          naming who), then Linear and GitHub disagreeing (Reconcile: Show the open PRs of tickets Done in Linear, or open
          Linear for a ticket still open after its PRs merged; it writes nothing). Chores, the other nudges, requests, and
          ready marks, wait on one Advance line, a, which never turns amber. Notes, Threads, Linear, Held, and All PRs open
          under the card.
        </p>
        <p>
          A strip chip counts Your turn: open PRs where a person&apos;s feedback waits on you. A held PR doesn&apos;t count.
          Rows follow each read, as All PRs does; a blue dot on a chip marks a change since you looked, until you mark the
          view seen. ↻ on a row reads it from GitHub again.
        </p>
        <p>
          Address starts one thread for the rows you leave ticked under it, with {Math.round(SEND_DELAY_MS / 1_000)} s
          to Undo. Every other GitHub write lists each PR in a confirm, then waits the same with Undo. Review notes are
          confirmed one PR at a time, never by Advance. Fix sends each PR its own fix in its thread, or starts a worker
          for one with none; it never merges. Merges run only from the fresh merge preview, on a click or ⌘↵.
        </p>
      </Section>

      <Section title="Piles and holds">
        <p>
          The strip is the active pile, with On hold and Done at its right. Hold moves an effort to On hold with an
          optional reason, and its PRs stop counting until you resume it. Complete moves it to Done, and Reopen puts it
          back at the end of the pile.
        </p>
        <p>
          To pause one PR, focus its row and choose Hold PR in ⌘K. A held PR is listed under the card&apos;s Held toggle, or ⇧H,
          with its reason and how long it&apos;s been held. No batch or Advance touches it until you release it. Release lists
          each PR first and waits with Undo like any write. One-offs collects PRs that merge on their own, and it stays on the
          active pile. To move a PR there from an effort, focus its row and choose Move to One-offs in ⌘K; Undo puts it back.
          Each effort&apos;s Notes keep Markdown for flags, experiments, and the rest: ⇧N edits them in place and ⌘↵ saves.
        </p>
      </Section>

      <Section title="Sorting PRs into efforts">
        <p>
          Every open PR and thread is on a card, or with its done effort on the Done pile. A PR that no effort owns is on
          its repository&apos;s service card, such as folio · service, after the efforts in the strip. A service card works
          like an effort&apos;s card, and its Your turn PRs count on its chip. A thread goes with the PRs it works on, or with its
          own checkout. Threads with no effort or single repository, such as ones that only ran in a shared clone, are on
          Loose threads, the last card.
        </p>
        <p>
          Suggestions under a service card show where each group of its PRs could go, with its strength (strong,
          moderate, or weak) and the signals behind it: a shared ticket, Linear project, stack, linked thread, board group,
          or code area. A ticket prefix only adds weight to a stronger signal. A lone PR whose ticket nothing else carries
          is offered as a weak one-off.
        </p>
        <p>
          Nothing moves until you press a group&apos;s button, or ⇧A on one of its rows, and Undo takes it back. A weak group
          asks again first. From a focused row you can also move it to any effort (e), start a new effort from it, or mark it a
          one-off. Promote to effort makes an effort of all the card&apos;s PRs in one confirm.
        </p>
        <p>
          A standing rule places new PRs on every read by ticket prefix, branch, repository, Linear project, or stack.
          Standing rules in ⌘K lists and removes them from any card. Removing a rule leaves the PRs it placed.
        </p>
      </Section>

      <Section title="Seed from Linear">
        <p>
          Seed from Linear, on a service card, proposes one effort per Linear project that has tickets on your open
          PRs. Each takes the project&apos;s name and description, and flags an effort that already matches. Check the ones
          to create. Each takes only PRs that no effort owns, never syncs with Linear after, and Undo takes it back. It
          needs a Linear API key in settings.
        </p>
      </Section>

      <Section title="All PRs">
        <p>{INVENTORY_HOW.intro}</p>
        <Pairs rows={INVENTORY_HOW.rows} />
      </Section>

      <Section title="Keys">
        <p className="text-foreground">Efforts and All PRs</p>
        <p>The same keys do the same thing in both. ? lists every key, and ⌘K lists every action.</p>
        <Pairs rows={DECK_KEYS} mono />
        <p className="pt-1 text-foreground">Map</p>
        <Pairs rows={MAP_KEYS} mono />
        <p className="pt-1 text-foreground">All views</p>
        <Pairs rows={BOTH_KEYS} mono />
      </Section>

      <Section title="How the Map groups checkouts">
        <p>
          Checkouts with the same ticket form a cluster. Related clusters can form efforts, programs, and domains;
          levels that add no useful grouping collapse. Code seeds groups from changed code areas, shared words,
          Linear parents or projects, and linked threads. Two signals must agree, except that a Linear link needs
          only one other signal. Sharing a repository alone does not group tickets.
        </p>
        <p>
          Jev assigns groups with a confidence score; low scores land in Unsorted. Claude names groups and flags
          mixed ones. Code computes counts and rollups. Tickets with no related cluster go into team containers
          such as &ldquo;ABC &middot; 14 one-offs&rdquo;. Containers do not imply that their tickets are related.
        </p>
        {mode === null ? null : (
          <p>
            <span className="text-foreground">Grouping: {mode.label}.</span> {mode.detail}
          </p>
        )}
      </Section>

      <Section title="Map marks">
        <Pairs
          rows={[
            ["Pause glyph", "Stuck: in progress or waiting, with no commits in a month or more."],
            ["Dashed rim", "Mixed grouping: Claude thought what is inside looked unrelated (Theme face)."],
            ["Small dot", "An agent thread works here; it pulses while running. Hover or click it for the list."],
          ]}
        />
        <p>Archive idle leaf threads from that list. Archived threads shows history and lets you undo an archive.</p>
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
            <p>Git ref changes and idle thread transitions can trigger targeted refreshes. The configured interval and manual Refresh also update the board; Workstreams does not use GitHub webhooks.</p>
            <p className="pt-1 text-foreground">Recent runs</p>
            {board.runs.length === 0 ? (
              <p>No row actions in the last day.</p>
            ) : (
              <ul className="space-y-0.5">
                {board.runs.slice(0, 10).map((run) => (
                  <li key={run.id} className="flex min-w-0 gap-2">
                    <span className="w-24 shrink-0 truncate text-foreground" title={run.path}>
                      {run.path.split("/").filter(Boolean).pop() ?? run.path}
                    </span>
                    <span className="min-w-0 truncate" title={runLabel(run, now)}>
                      {runLabel(run, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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

      <Section title="Linear details">
        <p>
          Add one or more Linear API keys in settings and each ticket is looked up with the key whose workspace owns
          its team prefix. A ticket no key covers gets no Linear details.
        </p>
      </Section>

      <Section title="Data and services">
        <p>
          Board facts and caches stay in BB&apos;s local plugin storage. Workstreams uses your authenticated gh to
          read GitHub pull requests and run actions you confirm. A configured Linear key sends ticket identifiers
          to Linear and retrieves issue details.
        </p>
        <p>
          With model keys, Jev receives ticket keys, repository names, PR titles, and available Linear context to
          select summaries and groups. Anthropic receives group members, summaries, repository names, and available
          Linear or linked-thread context to name groups. Unchanged semantic inputs reuse cached decisions.
        </p>
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
