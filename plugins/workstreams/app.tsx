// bb-plugin-workstreams — frontend entry.
//
// One dense screen: an attention rail on the left, an effort grid on the right.
// Effort → ticket cluster → unit (one checkout). Everything it shows comes from
// board_get; the server publishes "board-changed" after each scan and the board
// refetches. Nothing here computes a count or a sentence — the server already
// did, so the board and the CLI can never disagree.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  UrlLink,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Board, BoardMode, Prefs, WireGroup, rpcContract } from "./server";
import {
  LENSES,
  LIFECYCLES,
  STALENESS,
  displayTitle,
  groupChildren,
  matchesFilters,
  type Lens,
  type Lifecycle,
  type LensFilters,
  type Staleness,
} from "./workstreams";
import { EASE_CSS } from "./layout";
import { MapView } from "./map";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type Group = WireGroup;
export type Cluster = Group["clusters"][number];
export type Unit = Cluster["units"][number];

/** Restraint on purpose: color carries lifecycle meaning and nothing else. */
export const TONE: Record<Lifecycle, { dot: string; label: string }> = {
  blocked: { dot: "bg-destructive", label: "Blocked" },
  "awaiting-followup": { dot: "bg-orange-500", label: "Needs your changes" },
  "approved-with-comments": { dot: "bg-yellow-500", label: "Approved, comments open" },
  "awaiting-merge": { dot: "bg-emerald-500", label: "Ready to merge" },
  "awaiting-review": { dot: "bg-amber-500", label: "Awaiting review" },
  active: { dot: "bg-sky-400", label: "Being edited" },
  "in-progress": { dot: "bg-sky-600", label: "In progress" },
  "up-next": { dot: "bg-muted-foreground/50", label: "Up next" },
  shipped: { dot: "bg-teal-500", label: "Shipped" },
  merged: { dot: "bg-violet-500", label: "Merged" },
  closed: { dot: "bg-muted-foreground/40", label: "Closed" },
};

/**
 * The rail lists what you can act on, in the order you would act on it. It is
 * explicitly a STATUS view and the one place status-first reading belongs —
 * which is exactly why nothing else on the board may order by lifecycle.
 */
const ACTIONABLE: readonly Lifecycle[] = [
  "blocked",
  "awaiting-followup",
  "approved-with-comments",
  "awaiting-merge",
  "active",
];

export const LENS_LABEL: Record<Lens, string> = {
  all: "All",
  active: "Active",
  waiting: "Waiting",
  done: "Done",
};

const STALENESS_LABEL: Record<Staleness, string> = {
  fresh: "≤7d",
  recent: "8–30d",
  cold: "31–90d",
  dead: ">90d",
};

/** The alternate canvas encoding. Never shown at the same time as status. */
const SURFACE_TONE: Record<string, string> = {
  auth: "bg-rose-500",
  payments: "bg-fuchsia-500",
  migrations: "bg-orange-500",
  schema: "bg-amber-500",
  infra: "bg-lime-600",
  api: "bg-cyan-500",
  ui: "bg-indigo-500",
  tests: "bg-slate-400",
  docs: "bg-stone-400",
};

function surfaceTone(surface: string | undefined): string {
  return surface === undefined ? "bg-muted" : (SURFACE_TONE[surface] ?? "bg-muted-foreground/40");
}

const RISK_LABEL: Record<Group["risk"], string> = {
  none: "",
  low: "low risk",
  medium: "medium risk",
  high: "high risk",
};

/** Dimmed, never removed: a lens that moved a region would defeat the map. */
const LENS_DIM = 0.16;

const MODE_LABEL: Record<BoardMode, { label: string; detail: string }> = {
  basic: {
    label: "Ticket grouping",
    detail:
      "Clusters are grouped by ticket. Summaries are the most recent pull request title. Every count and rollup is computed locally.",
  },
  jev: {
    label: "Jev grouping",
    detail:
      "Jev picks each cluster's summary from its own pull request titles and groups clusters into efforts. Every word shown is one you wrote.",
  },
  "jev+claude": {
    label: "Jev + Claude",
    detail:
      "Jev groups clusters and picks their summaries; Claude writes the effort names. Counts and rollups are computed locally.",
  },
};

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("board_get").then(
      (next) => {
        setBoard(next);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  return { rpc, board, error, refetch };
}

const DEFAULT_PREFS: Prefs = { lens: "all", staleness: [], surfaces: [], colorBy: "status", face: "theme" };

/**
 * The lens, persisted server-side in plugin kv so it survives a reload. Applied
 * optimistically: the control has to answer the click, and a lens is a view
 * preference rather than a fact that can fail to save.
 */
function usePrefs() {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    let live = true;
    rpc.call("prefs_get").then(
      (next) => {
        if (live) setPrefs(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  const update = useCallback(
    (patch: Partial<Prefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        void rpc.call("prefs_set", next).catch(() => {});
        return next;
      });
    },
    [rpc],
  );
  return { prefs, update };
}

/** The filters the pure predicate consumes, from the persisted preferences. */
function filtersOf(prefs: Prefs): LensFilters {
  return { lens: prefs.lens, staleness: prefs.staleness, surfaces: prefs.surfaces };
}

/**
 * Rebuild the tree the flat wire list encodes. The server decided which levels
 * survived the collapse, so the renderer reads the shape rather than assuming
 * one — a board that collapsed to efforts alone renders identically to v3.
 */
export function useTree(board: Board | null) {
  return useMemo(() => {
    const groups = board?.groups ?? [];
    const byParent = groupChildren(groups);
    return {
      groups,
      roots: byParent.get(null) ?? [],
      childrenOf: (key: string) => byParent.get(key) ?? [],
    };
  }, [board]);
}

/** Every cluster under a group, at whatever depth. */
function clustersUnder(group: Group, childrenOf: (key: string) => Group[]): Cluster[] {
  const children = childrenOf(group.key);
  if (children.length === 0) return group.clusters;
  return children.flatMap((child) => clustersUnder(child, childrenOf));
}

/**
 * A quiet marker, not a warning. It tells the reader which groupings to
 * distrust; it is not an error, and Claude was never allowed to act on it.
 */
function CohesionMark({ cohesion }: { cohesion: Group["cohesion"] }) {
  if (cohesion === null || cohesion.verdict !== "mixed") return null;
  return (
    <span
      className="shrink-0 cursor-help font-mono text-[10px] text-muted-foreground/70"
      title={`Claude thought this grouping looked mixed${cohesion.reason === null ? "" : `: ${cohesion.reason}`}. Membership was decided by Jev and is unchanged.`}
      aria-label="Claude flagged this grouping as mixed"
    >
      ~
    </span>
  );
}

function SurfaceTags({ surfaces, risk }: { surfaces: string[]; risk: Group["risk"] }) {
  if (surfaces.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      title={`Touches ${surfaces.join(", ")}${RISK_LABEL[risk] === "" ? "" : ` — ${RISK_LABEL[risk]}`}`}
    >
      {surfaces.slice(0, 4).map((surface) => (
        <span
          key={surface}
          className={cn("size-1.5 rounded-sm", surfaceTone(surface))}
          aria-hidden
        />
      ))}
    </span>
  );
}

function Dot({ lifecycle }: { lifecycle: Lifecycle }) {
  const tone = TONE[lifecycle];
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", tone.dot)}
      title={tone.label}
      aria-label={tone.label}
      role="img"
    />
  );
}

function UnitRow({ unit }: { unit: Unit }) {
  const stack = unit.stack;
  return (
    <li
      className={cn(
        "flex items-center gap-2 py-1 pl-4 text-[11px] leading-5",
        stack !== null && "relative pl-7",
      )}
    >
      {/* The vertical order IS the merge order, bottom to top: an indent, a
          connector and a position is all that needs saying. */}
      {stack === null ? null : (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute left-4 w-px bg-border",
              stack.position === 1 ? "top-0 bottom-1/2" : "",
              stack.position === stack.size ? "top-1/2 bottom-0" : "",
              stack.position > 1 && stack.position < stack.size ? "inset-y-0" : "",
            )}
          />
          <span
            className="absolute left-[13px] top-1/2 size-1.5 -translate-y-1/2 rounded-full border border-border bg-background"
            aria-hidden
          />
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground"
            title={
              stack.blockedBelow === null
                ? `Bottom of a stack of ${stack.size}`
                : `Cannot merge until #${stack.blockedBelow} below it merges`
            }
          >
            {stack.position} of {stack.size}
          </span>
        </>
      )}
      <Dot lifecycle={unit.lifecycle} />
      <span className="w-32 shrink-0 truncate font-medium text-foreground">
        {unit.repo ?? unit.dirName}
      </span>
      {unit.pr === null ? (
        <span className="shrink-0 font-mono text-muted-foreground">no PR</span>
      ) : (
        <UrlLink
          href={unit.pr.url}
          className="shrink-0 font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          #{unit.pr.number}
        </UrlLink>
      )}
      {/* A bare PR number says nothing; the title is the point of the row. */}
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={unit.pr === null ? (unit.branch ?? unit.path) : displayTitle(unit.pr.title)}>
        {unit.pr === null ? (unit.branch ?? unit.path) : displayTitle(unit.pr.title)}
      </span>
      {unit.dirty ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400" title="Uncommitted changes">
          ●
        </span>
      ) : null}
      {(unit.ahead ?? 0) > 0 || (unit.behind ?? 0) > 0 ? (
        <span
          className="shrink-0 font-mono text-muted-foreground"
          title={`${unit.ahead ?? 0} ahead, ${unit.behind ?? 0} behind upstream`}
        >
          ↑{unit.ahead ?? 0}↓{unit.behind ?? 0}
        </span>
      ) : null}
    </li>
  );
}

const THREAD_TIER_LABEL: Record<Cluster["threads"][number]["tier"], string> = {
  environment: "runs in this checkout",
  ticket: "names this ticket",
  paths: "worked in this checkout",
};

/**
 * A linked BB thread. Read-only: the row opens the thread through the host's
 * navigation and nothing here ever writes to it.
 */
function ThreadRow({ thread }: { thread: Cluster["threads"][number] }) {
  const navigate = useBbNavigate();
  return (
    <li className="flex items-center gap-2 py-1 pl-4 text-[11px] leading-5">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", thread.active ? "bg-foreground" : "bg-foreground/40")}
      />
      <button
        type="button"
        onClick={() => navigate.toThread(thread.id)}
        className="min-w-0 flex-1 truncate text-left text-foreground underline-offset-2 hover:underline"
        title="Open this thread in BB"
      >
        {thread.title}
      </button>
      <span className="shrink-0 text-muted-foreground">
        {thread.active ? "running · " : ""}
        {THREAD_TIER_LABEL[thread.tier]}
      </span>
    </li>
  );
}

/**
 * Keep each stack's members adjacent and in merge order, so the column reads
 * bottom-to-top the way the stack actually merges. Unstacked units keep the
 * server's recency order.
 */
export function stackOrder(units: Unit[]): Unit[] {
  return [...units].sort((a, b) => {
    const left = a.stack;
    const right = b.stack;
    if (left !== null && right !== null && left.id === right.id) {
      return left.position - right.position;
    }
    return (left?.id ?? "").localeCompare(right?.id ?? "");
  });
}

function ClusterRow({
  cluster,
  expanded,
  dimmed,
  onToggle,
}: {
  cluster: Cluster;
  expanded: boolean;
  dimmed: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      id={`cluster-${cluster.ticket}`}
      className="min-w-0 transition-opacity"
      // Dimmed, never unmounted: the lens must not reflow the rows around it.
      style={{ opacity: dimmed ? LENS_DIM : 1 }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-muted/60",
          expanded && "bg-muted/60",
        )}
      >
        <Dot lifecycle={cluster.lifecycle} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {cluster.ticket}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={cluster.summary}>
          {cluster.summary}
        </span>
        <SurfaceTags surfaces={cluster.surfaces} risk={cluster.risk} />
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          title={`Last commit ${STALENESS_LABEL[cluster.staleness]} ago`}
        >
          {cluster.staleness === "fresh" ? "" : cluster.staleness}
        </span>
        {cluster.threads.length === 0 ? null : (
          <span
            className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
            title={`${cluster.threads.length} BB ${cluster.threads.length === 1 ? "thread" : "threads"} linked${cluster.threads.some((thread) => thread.active) ? ", one running now" : ""}`}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                cluster.threads.some((thread) => thread.active) ? "bg-foreground" : "bg-foreground/50",
              )}
            />
            {cluster.threads.length}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {cluster.units.length}
        </span>
      </button>
      {expanded ? (
        <ul className="min-w-0 border-l border-border/60 pb-1">
          {stackOrder(cluster.units).map((unit) => (
            <UnitRow key={unit.path} unit={unit} />
          ))}
          {cluster.threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Progress({ merged, total }: { merged: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((merged / total) * 100);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      title={`${merged} of ${total} checkouts merged`}
    >
      <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span className="block h-full bg-violet-500" style={{ width: `${percent}%` }} />
      </span>
      {merged}/{total}
    </span>
  );
}

/**
 * One grouping node, at whatever level survived the collapse. A program renders
 * as a titled section holding effort cards; an effort renders as a card holding
 * cluster rows. One component, because the levels differ only in what they
 * contain and a second component would be a second place for them to drift.
 */
function GroupCard({
  group,
  childrenOf,
  expanded,
  filters,
  onToggleCluster,
}: {
  group: Group;
  childrenOf: (key: string) => Group[];
  expanded: ReadonlySet<string>;
  filters: LensFilters;
  onToggleCluster: (ticket: string) => void;
}) {
  const children = childrenOf(group.key);
  const matches = matchesFilters(group, filters);

  if (children.length > 0) {
    return (
      <section className="flex min-w-0 flex-col gap-2">
        <header className="flex min-w-0 items-center gap-2">
          <h2
            className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            style={{ opacity: matches ? 1 : LENS_DIM }}
          >
            {group.name}
          </h2>
          <CohesionMark cohesion={group.cohesion} />
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {children.length} {group.level === "domain" ? "programs" : "efforts"} ·{" "}
            {group.total} checkouts
          </span>
          <span className="h-px flex-1 bg-border" />
        </header>
        <div className="grid grid-cols-1 gap-2.5 pl-2 lg:grid-cols-2 2xl:grid-cols-3">
          {children.map((child) => (
            <GroupCard
              key={child.key}
              group={child}
              childrenOf={childrenOf}
              expanded={expanded}
              filters={filters}
              onToggleCluster={onToggleCluster}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <article
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 transition-opacity"
      style={{ opacity: matches ? 1 : LENS_DIM }}
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
          {group.name}
        </h3>
        <CohesionMark cohesion={group.cohesion} />
        <Progress merged={group.merged} total={group.total} />
      </header>
      <p className="truncate text-[11px] text-muted-foreground" title={group.rollup}>
        {group.rollup}
        <span className="ml-2 text-muted-foreground/70">
          {group.repoCount} {group.repoCount === 1 ? "repo" : "repos"}
        </span>
        {group.risk === "none" ? null : (
          <span className="ml-2 text-muted-foreground/70">{RISK_LABEL[group.risk]}</span>
        )}
      </p>
      <ul className="min-w-0 divide-y divide-border/50">
        {group.clusters.map((cluster) => (
          <ClusterRow
            key={cluster.ticket}
            cluster={cluster}
            expanded={expanded.has(cluster.ticket)}
            dimmed={!matchesFilters(cluster, filters)}
            onToggle={() => onToggleCluster(cluster.ticket)}
          />
        ))}
      </ul>
    </article>
  );
}

type Attention = {
  counts: { lifecycle: Lifecycle; count: number }[];
  actionable: {
    ticket: string;
    summary: string;
    lifecycle: Lifecycle;
    staleness: Staleness;
  }[];
};

/**
 * One definition of "what needs attention", shared by the Board rail and the
 * Map's overview control. Two surfaces of one board must never be able to
 * report different numbers.
 *
 * This is the ONE place urgency orders anything. The rail is explicitly a
 * status view; everywhere else, status paints and the hierarchy positions.
 */
function attentionSummary(clusters: Cluster[]): Attention {
  const tally = new Map<Lifecycle, number>();
  const rows: {
    ticket: string;
    summary: string;
    lifecycle: Lifecycle;
    staleness: Staleness;
  }[] = [];
  for (const cluster of clusters) {
    tally.set(cluster.lifecycle, (tally.get(cluster.lifecycle) ?? 0) + 1);
    if (ACTIONABLE.includes(cluster.lifecycle)) {
      rows.push({
        ticket: cluster.ticket,
        summary: cluster.summary,
        lifecycle: cluster.lifecycle,
        staleness: cluster.staleness,
      });
    }
  }
  rows.sort(
    (a, b) =>
      ACTIONABLE.indexOf(a.lifecycle) - ACTIONABLE.indexOf(b.lifecycle) ||
      a.ticket.localeCompare(b.ticket),
  );
  return {
    counts: LIFECYCLES.filter((lifecycle) => tally.has(lifecycle)).map((lifecycle) => ({
      lifecycle,
      count: tally.get(lifecycle) ?? 0,
    })),
    actionable: rows,
  };
}

function AttentionRail({
  clusters,
  onFocus,
}: {
  clusters: Cluster[];
  onFocus: (ticket: string) => void;
}) {
  const { counts, actionable } = useMemo(() => attentionSummary(clusters), [clusters]);

  return (
    <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border px-3 py-3 md:flex">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Clusters
      </h2>
      <dl className="mb-4 space-y-1">
        {counts.map(({ lifecycle, count }) => (
          <div key={lifecycle} className="flex items-center gap-2 text-xs">
            <Dot lifecycle={lifecycle} />
            <dt className="min-w-0 flex-1 truncate text-muted-foreground">
              {TONE[lifecycle].label}
            </dt>
            <dd className="font-mono text-foreground">{count}</dd>
          </div>
        ))}
      </dl>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Needs attention
      </h2>
      {actionable.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing is waiting on you.</p>
      ) : (
        <ul className="min-w-0 space-y-0.5">
          {actionable.map((row) => (
            <li key={row.ticket}>
              <button
                type="button"
                onClick={() => onFocus(row.ticket)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] hover:bg-muted/60"
              >
                <Dot lifecycle={row.lifecycle} />
                <span className="shrink-0 font-mono text-muted-foreground">{row.ticket}</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={row.summary}>
                  {row.summary}
                </span>
                {/* Awaiting review AND dead is the combination the two
                    dimensions exist to surface, so the rail says it in words. */}
                {row.staleness === "cold" || row.staleness === "dead" ? (
                  <span
                    className="shrink-0 font-mono text-[10px] text-muted-foreground"
                    title={`Last commit ${STALENESS_LABEL[row.staleness]} ago`}
                  >
                    {row.staleness}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * The lens. It filters and dims IN PLACE: nothing it does may move a card or a
 * region, because a control that rearranges the picture every time you change
 * question is the thing this replaced.
 */
function LensControl({
  prefs,
  surfaces,
  onChange,
  showColorBy,
}: {
  prefs: Prefs;
  surfaces: string[];
  onChange: (patch: Partial<Prefs>) => void;
  showColorBy: boolean;
}) {
  const toggle = <T extends string>(current: readonly T[], value: T): T[] =>
    current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];

  return (
    <div data-hud className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div role="group" aria-label="Status lens" className="flex gap-0.5 rounded-md bg-muted p-0.5">
        {LENSES.map((lens) => (
          <button
            key={lens}
            type="button"
            aria-pressed={prefs.lens === lens}
            onClick={() => onChange({ lens })}
            className={cn(
              "rounded px-2 py-0.5 text-[11px]",
              prefs.lens === lens
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LENS_LABEL[lens]}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Staleness" className="flex gap-0.5">
        {STALENESS.map((bucket) => (
          <button
            key={bucket}
            type="button"
            aria-pressed={prefs.staleness.includes(bucket)}
            title={`Last commit ${STALENESS_LABEL[bucket]} ago`}
            onClick={() => onChange({ staleness: toggle(prefs.staleness, bucket) })}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px]",
              prefs.staleness.includes(bucket)
                ? "border-foreground/40 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {bucket}
          </button>
        ))}
      </div>
      {surfaces.length === 0 ? null : (
        <div role="group" aria-label="Surfaces" className="flex flex-wrap gap-0.5">
          {surfaces.map((surface) => (
            <button
              key={surface}
              type="button"
              aria-pressed={prefs.surfaces.includes(surface)}
              onClick={() => onChange({ surfaces: toggle(prefs.surfaces, surface) })}
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
                prefs.surfaces.includes(surface)
                  ? "border-foreground/40 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-sm", surfaceTone(surface))} aria-hidden />
              {surface}
            </button>
          ))}
        </div>
      )}
      {!showColorBy ? null : (
        <button
          type="button"
          onClick={() =>
            onChange({ colorBy: prefs.colorBy === "status" ? "surface" : "status" })
          }
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          // Two colour encodings at once is two legends and no answer, so this
          // is a switch rather than a pair of checkboxes.
          title="The canvas colours by status or by surface, never both at once"
        >
          Colour: {prefs.colorBy}
        </button>
      )}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/**
 * "<repo>: no release tags found; …" is a permanent property of a repo, not an
 * event, so it folds into one line. Everything else — an auth failure, a scan
 * that died — is real news and stays listed on its own.
 */
const NO_RELEASE_TAGS = /^(.+?): no release tags found/;

function groupWarnings(warnings: readonly string[]): string[] {
  const untagged = warnings.filter((warning) => NO_RELEASE_TAGS.test(warning));
  const rest = warnings.filter((warning) => !NO_RELEASE_TAGS.test(warning));
  if (untagged.length === 0) return rest;
  const summary =
    untagged.length === 1
      ? `${NO_RELEASE_TAGS.exec(untagged[0]!)?.[1] ?? "One repo"} has no release tags — merged work there shows as merged, not shipped.`
      : `${untagged.length} repos have no release tags — merged work there shows as merged, not shipped.`;
  return [...rest, summary];
}

/**
 * Warnings as one small indicator rather than a banner above the map: the
 * count says something is there, a click says what.
 */
function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => groupWarnings(warnings), [warnings]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  if (lines.length === 0) return null;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${lines.length} ${lines.length === 1 ? "notice" : "notices"} from the last scan`}
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <Icon name="AlertTriangle" className="size-3.5" />
        {lines.length}
      </button>
      {open ? (
        <div
          role="status"
          className="absolute right-0 top-8 z-20 w-96 max-w-[80vw] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <ul className="max-h-72 space-y-2 overflow-y-auto text-xs leading-relaxed">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The dense board. Position now comes from the grouping hierarchy alone: the
 * v2 "active grid, then a Done drawer" split was a POSITION derived from
 * lifecycle, so it is gone. Done work sits where its theme puts it and the lens
 * decides how loudly it reads.
 */
function BoardPage({
  board,
  prefs,
  onPrefs,
  focusTicket,
  onFocusTicket,
}: {
  board: Board | null;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  /** The cluster the Map had in focus: opened and scrolled to on arrival. */
  focusTicket: string | null;
  onFocusTicket: (ticket: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const pendingFocus = useRef<string | null>(null);
  const { roots, childrenOf } = useTree(board);
  const filters = useMemo(() => filtersOf(prefs), [prefs]);
  const clusters = useMemo(
    () => roots.flatMap((root) => clustersUnder(root, childrenOf)),
    [roots, childrenOf],
  );
  const shown = useMemo(
    () => clusters.filter((cluster) => matchesFilters(cluster, filters)).length,
    [clusters, filters],
  );
  const leafRoots = useMemo(
    () => roots.filter((root) => childrenOf(root.key).length === 0),
    [roots, childrenOf],
  );
  const branchRoots = useMemo(
    () => roots.filter((root) => childrenOf(root.key).length > 0),
    [roots, childrenOf],
  );

  const toggleCluster = useCallback((ticket: string) => {
    // Opening a row makes it the shared selection the Map flies back to.
    if (!expanded.has(ticket)) onFocusTicket(ticket);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(ticket)) next.delete(ticket);
      else next.add(ticket);
      return next;
    });
  }, [expanded, onFocusTicket]);

  const focusCluster = useCallback((ticket: string) => {
    setExpanded((current) => new Set(current).add(ticket));
    pendingFocus.current = ticket;
  }, []);

  // Arriving from the Map lands on the cluster it had in focus.
  const arrivedRef = useRef(false);
  useEffect(() => {
    if (arrivedRef.current || board === null) return;
    arrivedRef.current = true;
    if (focusTicket !== null) focusCluster(focusTicket);
  }, [board, focusCluster, focusTicket]);

  // The rail focuses a cluster in place rather than navigating: this is one
  // view, so losing the surrounding board to read one row would be a step back.
  useEffect(() => {
    const ticket = pendingFocus.current;
    if (ticket === null) return;
    pendingFocus.current = null;
    document
      .getElementById(`cluster-${ticket}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [expanded]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {board === null ? null : (
          <AttentionRail clusters={clusters} onFocus={focusCluster} />
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
          {board === null ? (
            <Notice>Loading the board…</Notice>
          ) : roots.length === 0 ? (
            <Notice>
              No checkouts found. Set the plugin's <code>scanRoots</code> setting to
              the directory holding your checkouts, then press Rescan.
            </Notice>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <LensControl
                  prefs={prefs}
                  surfaces={board.surfaces}
                  onChange={onPrefs}
                  showColorBy={false}
                />
                <span className="text-[10px] text-muted-foreground">
                  {shown} of {clusters.length} clusters
                </span>
              </div>
              {/* A board that collapsed to efforts alone renders exactly as v3
                  did: leaf groups fill the grid, and only a level that actually
                  survived gets a titled section of its own. */}
              <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
                {leafRoots.map((root) => (
                  <GroupCard
                    key={root.key}
                    group={root}
                    childrenOf={childrenOf}
                    expanded={expanded}
                    filters={filters}
                    onToggleCluster={toggleCluster}
                  />
                ))}
              </div>
              <div className="flex flex-col gap-4">
                {branchRoots.map((root) => (
                  <GroupCard
                    key={root.key}
                    group={root}
                    childrenOf={childrenOf}
                    expanded={expanded}
                    filters={filters}
                    onToggleCluster={toggleCluster}
                  />
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page: one fetch, two views of it.
// ---------------------------------------------------------------------------

/**
 * The Map is the landing view: the point of the board is the picture, and the
 * dense list is the secondary read. Both stay deep-linkable — `board` is a real
 * sub-path rather than a toggle — so panel history keeps walking with browser
 * back and forward.
 */
const VIEWS = [
  { id: "", title: "Map", icon: "GridView" },
  { id: "board", title: "Board", icon: "Columns2" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

/** Typing in a field is never a view switch. */
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null)
  );
}

/**
 * The two views crossfade: the outgoing one fades and settles back a hair, the
 * incoming one rises into place. Transform and opacity only, on the page's one
 * easing; reduced motion swaps instantly. No shared-element morph — a circle
 * and a table row are not the same shape, and pretending costs more than it says.
 */
function ViewLayer({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced()) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, easing: EASE_CSS, fill: "backwards" },
    );
  }, []);
  useEffect(() => {
    if (!leaving || reduced()) return;
    ref.current?.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-3px) scale(0.995)" },
      ],
      { duration: 220, easing: EASE_CSS, fill: "forwards" },
    );
  }, [leaving]);
  return (
    <div
      ref={ref}
      aria-hidden={leaving || undefined}
      className={cn("absolute inset-0 flex min-h-0 flex-col", leaving && "pointer-events-none")}
    >
      {children}
    </div>
  );
}

function WorkstreamsPage({ subPath }: { subPath: string }) {
  const { rpc, board, error, refetch } = useBoard();
  const { prefs, update } = usePrefs();
  const navigate = useBbNavigate();
  const view: ViewId = subPath.split("/")[0] === "board" ? "board" : "";
  const mode = board === null ? null : MODE_LABEL[board.mode];
  // The one selection both views share: a cluster focused on the Map is the
  // row the Board opens on, and the circle the Map flies back to.
  const [focusTicket, setFocusTicket] = useState<string | null>(null);

  const [leaving, setLeaving] = useState<ViewId | null>(null);
  const shownRef = useRef<ViewId>(view);
  useEffect(() => {
    if (shownRef.current === view) return;
    setLeaving(shownRef.current);
    shownRef.current = view;
    const timer = window.setTimeout(() => setLeaving(null), 240);
    return () => window.clearTimeout(timer);
  }, [view]);

  // `V` toggles the views from anywhere on the page. The Map's own keys are
  // + − 0 Esc Backspace and the arrows, and Tab stays focus navigation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "v" && event.key !== "V") return;
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      navigate.toPluginPanel("board", { subPath: view === "board" ? "" : "board" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, view]);

  const render = (id: ViewId) =>
    id === "board" ? (
      <BoardPage
        board={board}
        prefs={prefs}
        onPrefs={update}
        focusTicket={focusTicket}
        onFocusTicket={setFocusTicket}
      />
    ) : (
      <MapView
        board={board}
        prefs={prefs}
        onPrefs={update}
        selected={focusTicket}
        onSelect={setFocusTicket}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-3">
        {/* Two views of one fetch, one keystroke apart. Quiet on purpose: the
            map is the surface, and this is only the way to the other view. */}
        <div role="tablist" aria-label="Workstreams views" className="flex shrink-0 items-center gap-3">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              title={`${entry.title} (V toggles)`}
              onClick={() => navigate.toPluginPanel("board", { subPath: entry.id })}
              className={cn(
                "text-xs transition-colors duration-150",
                view === entry.id
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.title}
            </button>
          ))}
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {board === null
            ? "Loading…"
            : board.lastScanAt === null
              ? "Never scanned"
              : `Scanned ${new Date(board.lastScanAt).toLocaleString()}`}
          {/* Factual, not a scold: every mode is a usable board. */}
          {mode === null ? null : (
            <span className="cursor-help" title={mode.detail}>
              {" "}
              · {mode.label}
            </span>
          )}
        </p>
        <span className="flex-1" />
        {board === null ? null : <Warnings warnings={board.warnings} />}
        <button
          type="button"
          disabled={board?.scanning === true}
          onClick={() => {
            rpc.call("board_refresh").then(refetch, refetch);
          }}
          className="flex h-7 items-center gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60"
        >
          <Icon
            name={board?.scanning === true ? "Loading" : "ArrowReloadHorizontal"}
            className={cn("size-3.5", board?.scanning === true && "animate-spin")}
          />
          {board?.scanning === true ? "Scanning…" : "Rescan"}
        </button>
      </header>

      {error === null ? null : (
        <p role="alert" className="shrink-0 px-3 pt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {VIEWS.map((entry) =>
          entry.id === view || entry.id === leaving ? (
            <ViewLayer key={entry.id} leaving={entry.id !== view}>
              {render(entry.id)}
            </ViewLayer>
          ) : null,
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Workstreams",
    icon: "Columns2",
    path: "board",
    component: WorkstreamsPage,
  });
});
