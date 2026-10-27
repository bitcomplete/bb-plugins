// Two surfaces. The Stewards page (a nav panel, one tab per stewarded
// project) is the expanded view of the sidebar (BB-78): the Blocked, In flight,
// Monitors and Recently ended sections, every card headed by the shared BB-76
// effort row, and the latest digest and lessons block; the one write is closing
// a question put to you or pressing a needs item's button. Settings → Plugins →
// Stewards: which projects are stewarded and whether their configuration is
// healthy, then every open steward and where it stands. Steering stays with the
// project steward and the CLI.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Markdown,
  ThreadTitle,
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_usePluginId,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { NEEDS_YOU_CHANGED } from "./channels.js";
import { buildSidebar, compareBlocked, compareEfforts, compareInflight, deploymentPhrase, effortPhrase, effortSection, effortState, effortTitle, isBusy, type EffortStatus, type SidebarChild, type SidebarChildRole, type SidebarEffort, type SidebarEffortState, type SidebarSection } from "./sidebar.js";
import { AUTOMATIC_THREAD_LIST_PROVIDER, BUILTIN_THREAD_LIST_ID, THREAD_LIST_PROVIDER_KEY, stewardsThreadListId } from "./sidebar-provider.js";

type Client = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { projects: unknown; lastSweepAt: unknown }> : never;
type Project = Overview["projects"][number];
type Steward = Project["stewards"][number];
type BoardResult = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { board: unknown }> : never;
type Board = NonNullable<BoardResult["board"]>;
type SidebarResult = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { projects: Array<{ needs: unknown }> }> : never;
type SidebarNeeds = SidebarResult["projects"][number]["needs"];
type SidebarNeedItem = SidebarNeeds["items"][number];
type CheckResult = { ok: boolean; lines: string[] };

const BOARD_PATH = "board";

const POLL_MS = 30_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ago(at: number | null, now: number): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** What `load` returns, refetched every half minute while the page is visible, and on demand. */
function usePolled<T>(load: () => Promise<T>): { data: T | null; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Only the latest call lands, so a slow answer for the last project does not replace this one's.
  const latest = useRef(0);
  const refetch = useCallback(() => {
    const call = ++latest.current;
    load().then(
      (o) => {
        if (!mounted.current || call !== latest.current) return;
        setData(o);
        setError(null);
      },
      (e: unknown) => {
        if (mounted.current && call === latest.current) setError(message(e));
      },
    );
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    refetch();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);
  return { data, error, refetch };
}

function useOverview(): { overview: Overview | null; error: string | null } {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error } = usePolled(useCallback(() => rpc.call("stewardsOverview", null), [rpc]));
  return { overview: data, error };
}

function Loading({ error }: { error: string | null }) {
  return <p className="text-sm text-muted-foreground">{error === null ? "Loading…" : <span className="text-destructive">{error}</span>}</p>;
}

function PageLink({ projectId, children }: { projectId: string; children: ReactNode }) {
  const navigate = useBbNavigate();
  return (
    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: encodeURIComponent(projectId) })}>
      {children}
    </button>
  );
}

function ThreadLink({ threadId, children }: { threadId: string; children: ReactNode }) {
  const navigate = useBbNavigate();
  return (
    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.toThread(threadId)}>
      {children}
    </button>
  );
}

function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "bad" }) {
  const colors =
    tone === "bad" ? "border-destructive/40 text-destructive" : tone === "warn" ? "border-amber-500/40 text-amber-600 dark:text-amber-500" : "border-border text-muted-foreground";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${colors}`}>{children}</span>;
}

function EntityLink({ entityKey, url }: { entityKey: string; url: string | null }) {
  const navigate = useBbNavigate();
  if (url === null) return <span className="font-medium">{entityKey}</span>;
  return (
    <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => navigate.openUrl(url)}>
      {entityKey}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

// ---- Status ---------------------------------------------------------------------------------------

function StatusSection() {
  const { overview, error } = useOverview();
  if (overview === null) return <Loading error={error} />;
  const now = Date.now();
  return (
    <div className="flex flex-col gap-4 text-sm">
      {overview.paused ? (
        <p className="flex items-start gap-2">
          <Icon name="CirclePause" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-label="paused" />
          <span>Stewards are paused: nothing is woken or adopted. Changes queue up until you turn Pause stewards off.</span>
        </p>
      ) : null}
      {overview.projects.length === 0 ? (
        <p className="text-muted-foreground">
          No project has a <code>stewards/project.json</code> in its <code>.bb</code>. Run <code>bb stewards init</code> from a thread in a multi-repo project, commit and publish it, and merge the guidance branch.
        </p>
      ) : (
        overview.projects.map((p) => <ProjectStatus key={p.projectId} project={p} now={now} />)
      )}
      <p className="text-xs text-muted-foreground">Last sweep {ago(overview.lastSweepAt, now)}; the sweep runs every half hour. Configuration is reread from committed HEAD every few minutes.</p>
      {error !== null ? <p className="text-xs text-destructive">Refresh failed: {error}</p> : null}
    </div>
  );
}

function ProjectStatus({ project: p, now }: { project: Project; now: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const [check, setCheck] = useState<CheckResult | "running" | { error: string } | null>(null);
  const healthy = p.configured && p.problems.length === 0;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-2 font-medium">
          <Icon
            name={healthy ? "CircleCheck" : "CircleAlert"}
            className={`size-4 shrink-0 ${healthy ? "text-success" : "text-amber-600 dark:text-amber-500"}`}
            aria-label={healthy ? "healthy" : "needs attention"}
          />
          {p.name}
        </p>
        {p.configured ? (
          <button
            type="button"
            disabled={check === "running"}
            className="rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50"
            onClick={() => {
              setCheck("running");
              rpc.call("stewardsCheck", { projectId: p.projectId }).then(setCheck, (e: unknown) => setCheck({ error: message(e) }));
            }}
          >
            {check === "running" ? "Checking…" : "Check against Linear and GitHub"}
          </button>
        ) : null}
      </div>
      {!p.configured ? (
        <p className="text-muted-foreground">This project has stewards but no readable stewards/project.json any more. They keep their bindings; nothing new is adopted.</p>
      ) : (
        <dl className="flex flex-col gap-1">
          <Row label="Linear teams">{p.linearTeams.join(", ") || "none"}</Row>
          <Row label="Repos">{p.repos.join(", ") || "none"}</Row>
          {p.excludedRepos.length > 0 && <Row label="Excluded">{p.excludedRepos.join(", ")}</Row>}
          <Row label="Label">
            <code>{p.label}</code>
          </Row>
          <Row label="Playbooks">
            {p.playbooks.map((b) => (
              <span key={b.kind} className="mr-3 inline-block">
                {b.kind}: {b.name}
                {b.version === null ? <span className="text-destructive"> (unusable)</span> : <span className="text-muted-foreground">@{b.version}</span>}
              </span>
            ))}
          </Row>
          <Row label="Project steward">
            {p.projectStewardThreadId === null ? <span className="text-muted-foreground">not started yet; it starts with the first steward</span> : <ThreadLink threadId={p.projectStewardThreadId}>Open thread</ThreadLink>}
          </Row>
          <Row label="Page">
            <PageLink projectId={p.projectId}>Open the stewards page</PageLink>
          </Row>
          <Row label="Nightly">
            {p.nightly === null ? "—" : `${p.nightly.at} ${p.nightly.timezone}`}
            <span className="text-muted-foreground"> · last ran {p.lastNight ?? "never"} · digest {ago(p.digestAt, now)}</span>
          </Row>
        </dl>
      )}
      {p.problems.length > 0 ? (
        <ul className="flex list-disc flex-col gap-0.5 pl-5 text-destructive">
          {p.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      {check !== null && check !== "running" ? (
        "error" in check ? (
          <p className="text-destructive">{check.error}</p>
        ) : (
          <pre className={`whitespace-pre-wrap rounded-md border border-border p-2 text-xs ${check.ok ? "text-muted-foreground" : "text-foreground"}`}>
            {[...check.lines, check.ok ? "OK" : "Problems found."].join("\n")}
          </pre>
        )
      ) : null}
    </div>
  );
}

// ---- Stewards -------------------------------------------------------------------------------------

const ACTOR_LABEL: Record<string, string> = { me: "you", steward: "the steward", other: "someone else" };

/**
 * The BB-76 effort row (BB-78): the glyph, the shortened key and the title on
 * line one; the kind, the entity's phase and the status phrase on line two.
 * Shared by the settings list and the Stewards page cards, so both show the row
 * the sidebar shows. `extra` carries the badges a surface adds beside the
 * title (priority, ending, escalations).
 */
function StewardHeader({ state, phrase, kind, phase, entityKey, url, title, extra }: {
  state: SidebarEffortState;
  phrase: string;
  kind: string;
  phase: string | null;
  entityKey: string;
  url: string | null;
  title: string | null;
  extra?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" title={entityKey}>
        <StewardGlyph kind={state} />
        <EntityLink entityKey={shortBindingKey(entityKey)} url={url} />
        {title !== null ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span> : null}
        {extra}
      </div>
      <p data-steward-line-two="" className="text-[11px] text-muted-foreground">
        {kindLabel(kind)}
        {phase !== null ? ` · ${phase}` : ""}
        {" · "}
        <span className={phraseClass(state)}>{phrase}</span>
      </p>
    </>
  );
}

/** The rules' inputs from a `stewardsOverview` steward, so its row derives the same state and phrase as the page and sidebar. */
function overviewEffortStatus(s: Steward): EffortStatus {
  return {
    busy: false,
    runningWorkers: s.workers,
    needsUser: s.needsUser,
    blockedOn: s.blockedOn,
    hold: s.hold,
    holdBehind: s.holdBehind,
    stuck: s.stuck,
    statusActor: s.actor,
    statusNextAction: s.nextAction,
    deployment: s.deployment,
  };
}

function StewardsSection() {
  const { overview, error } = useOverview();
  if (overview === null) return <Loading error={error} />;
  const now = Date.now();
  const projects = overview.projects.filter((p) => p.stewards.length > 0 || p.endedCount > 0);
  if (projects.length === 0) return <p className="text-sm text-muted-foreground">No stewards yet. Label a Linear ticket or pull request in a stewarded project to adopt it.</p>;
  return (
    <div className="flex flex-col gap-5 text-sm">
      {projects.map((p) => (
        <div key={p.projectId} className="flex flex-col gap-2">
          {overview.projects.length > 1 ? <p className="font-medium">{p.name}</p> : null}
          {p.stewards.length === 0 ? (
            <p className="text-muted-foreground">No open stewards.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {p.stewards.map((s) => (
                <StewardRow key={s.key} steward={s} now={now} />
              ))}
            </ul>
          )}
          {p.endedCount > 0 ? <p className="text-xs text-muted-foreground">{p.endedCount} ended; <code>bb stewards list --all</code> shows them.</p> : null}
        </div>
      ))}
    </div>
  );
}

function StewardRow({ steward: s, now }: { steward: Steward; now: number }) {
  const mine = s.escalations.filter((x) => x.route === "me");
  const status = overviewEffortStatus(s);
  const state = effortState(status);
  const phrase = effortPhrase(status);
  return (
    <li className="flex flex-col gap-1 p-3">
      <StewardHeader
        state={state}
        phrase={phrase}
        kind={s.kind}
        phase={s.phase}
        entityKey={s.key}
        url={s.url}
        title={s.title}
        extra={
          <>
            {s.priority !== null && s.priority !== "normal" ? <Badge tone={s.priority === "urgent" ? "bad" : "muted"}>{s.priority}</Badge> : null}
            {s.ending !== null ? <Badge tone="warn">{s.ending === "detach" ? "detaching" : "wrapping up"}</Badge> : null}
            {s.escalations.length > 0 ? <Badge tone={mine.length > 0 ? "bad" : "warn"}>{s.escalations.length === 1 ? "1 escalation" : `${s.escalations.length} escalations`}</Badge> : null}
          </>
        }
      />
      {s.summary === null ? (
        <p className="text-muted-foreground">No status report yet.</p>
      ) : (
        <p>
          {s.summary} <span className="text-muted-foreground">Next: {s.nextAction}{s.actor === null ? "" : ` (${ACTOR_LABEL[s.actor] ?? s.actor})`}</span>
        </p>
      )}
      {s.blockedOn !== null ? <p className="text-muted-foreground">Blocked on {s.blockedOn}</p> : null}
      {s.hold !== null ? <p className="text-amber-600 dark:text-amber-500">On hold: {s.hold}</p> : null}
      {s.escalations.map((x, i) => (
        <p key={i} className={x.route === "me" ? "text-destructive" : "text-muted-foreground"}>
          {x.kind} escalation with {x.route === "me" ? "you" : x.route === "parent" ? "the parent steward" : "the project steward"}: {x.question}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">
        Reported {ago(s.statusAt, now)} · adopted {ago(s.createdAt, now)}
        {s.workers > 0 ? ` · ${s.workers === 1 ? "1 worker" : `${s.workers} workers`} running` : ""}
        {s.threadId !== null ? (
          <>
            {" · "}
            <ThreadLink threadId={s.threadId}>Open steward</ThreadLink>
          </>
        ) : null}
      </p>
    </li>
  );
}

// ---- The stewards page -------------------------------------------------------------------------

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-medium">
        {title}
        {count === undefined ? null : <span className="ml-2 text-sm font-normal text-muted-foreground">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">{children}</ul>;
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

function BoardPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const first = subPath.split("/")[0] ?? "";
  const wanted = first === "" ? null : decodeURIComponent(first);
  const { data, error, refetch } = usePolled(useCallback(() => rpc.call("stewardsBoard", { projectId: wanted }), [rpc, wanted]));
  const boardProjectId = data?.board?.projectId ?? null;
  // A steward's question or item shows up here without the half-minute poll.
  useRealtime(
    NEEDS_YOU_CHANGED,
    useCallback(
      (payload) => {
        const projectId = payload === null || typeof payload !== "object" ? null : (payload as { projectId?: unknown }).projectId;
        if (typeof projectId === "string" && projectId === boardProjectId) refetch();
      },
      [boardProjectId, refetch],
    ),
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 text-sm">
        {data === null ? (
          <Loading error={error} />
        ) : data.projects.length === 0 ? (
          <None>
            No project is stewarded. Run <code>bb stewards init</code> from a thread in a multi-repo project, commit and publish it, and merge the guidance branch.
          </None>
        ) : (
          <>
            {data.projects.length > 1 ? (
              <nav className="flex flex-wrap gap-1 border-b border-border">
                {data.projects.map((p) => {
                  const active = p.projectId === data.board?.projectId;
                  return (
                    <button
                      key={p.projectId}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      className={`-mb-px border-b-2 px-3 py-1.5 ${active ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                      onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: encodeURIComponent(p.projectId) })}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </nav>
            ) : null}
            {data.board === null ? <None>That project is not stewarded.</None> : <ProjectBoard board={data.board} refetch={refetch} />}
            {error !== null ? <p className="text-xs text-destructive">Refresh failed: {error}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

type BoardSteward = Board["stewards"][number];
type BoardQuestion = Board["questions"][number];
type BoardWithUser = Board["withUser"][number];
type BoardNeed = Board["needs"][number];

/** One needs-you item on the page, tagged so its card knows which write the controls make. */
type NeedsYouItem =
  | { type: "question"; question: BoardQuestion }
  | { type: "withUser"; withUser: BoardWithUser }
  | { type: "need"; need: BoardNeed };

/** The binding key a needs-you item attaches to, or null for a project-level question. */
function needsYouKey(item: NeedsYouItem): string | null {
  if (item.type === "question") return item.question.key;
  if (item.type === "withUser") return item.withUser.key;
  return item.need.key;
}

/** A stable React key for a needs-you item. */
function needsYouItemKey(item: NeedsYouItem): string {
  if (item.type === "question") return `question:${item.question.id}`;
  if (item.type === "withUser") return `withUser:${item.withUser.id}`;
  return `need:${item.need.id}`;
}

/** The rules' inputs from a board steward, so the page and sidebar derive the same state and phrase (BB-78). */
function boardEffortStatus(s: BoardSteward): EffortStatus {
  return {
    busy: false,
    runningWorkers: s.workers.length,
    needsUser: s.needsUser,
    blockedOn: s.blockedOn,
    hold: s.hold,
    holdBehind: s.holdBehind,
    stuck: s.stuck,
    statusActor: s.actor,
    statusNextAction: s.nextAction,
    deployment: s.deployment,
  };
}

/** A board steward with its derived row and the needs-you items that attach to it. */
interface BoardEffort {
  steward: BoardSteward;
  state: SidebarEffortState;
  section: SidebarSection;
  phrase: string;
  items: NeedsYouItem[];
}

/** The most recent thing the board knows about an effort, for the section ordering. */
function boardRecency(e: BoardEffort): number {
  return e.steward.advancedAt ?? e.steward.statusAt ?? e.steward.createdAt;
}

/** The ordering fields the shared comparators read; the page has no live thread, so `pinned` and `busy` are false. */
function boardOrder(e: BoardEffort) {
  return {
    pinned: false,
    state: e.state,
    needsUser: e.steward.needsUser,
    busy: false,
    runningWorkers: e.steward.workers.length,
    recency: boardRecency(e),
    title: e.steward.title ?? e.steward.key,
  };
}

function ProjectBoard({ board: b, refetch }: { board: Board; refetch: () => void }) {
  const now = Date.now();
  // An escalation a need answers is shown as that need's row, not as the raw
  // escalation: a forwarded approval is answered with Approve/Decline, not by
  // "approve or decline in its steward's thread".
  const covered = new Set(b.needs.map((n) => n.escalationId).filter((id): id is string => id !== null));
  const withUser = b.withUser.filter((x) => !covered.has(x.id));

  // Needs-you items attach to their binding's card; an item with no open binding
  // (a project-level question, or one whose binding has ended) keeps a card of
  // its own at the top of Blocked (BB-78).
  const openKeys = new Set(b.stewards.map((s) => s.key));
  const itemsByKey = new Map<string, NeedsYouItem[]>();
  const orphans: NeedsYouItem[] = [];
  const allItems: NeedsYouItem[] = [
    ...b.questions.map((q) => ({ type: "question" as const, question: q })),
    ...withUser.map((x) => ({ type: "withUser" as const, withUser: x })),
    ...b.needs.map((n) => ({ type: "need" as const, need: n })),
  ];
  for (const item of allItems) {
    const key = needsYouKey(item);
    if (key === null || !openKeys.has(key)) orphans.push(item);
    else itemsByKey.set(key, [...(itemsByKey.get(key) ?? []), item]);
  }

  const efforts: BoardEffort[] = b.stewards.map((s) => {
    const status = boardEffortStatus(s);
    const state = effortState(status);
    return { steward: s, state, section: effortSection({ state, kind: s.kind }), phrase: effortPhrase(status), items: itemsByKey.get(s.key) ?? [] };
  });
  const blocked = efforts.filter((e) => e.section === "blocked").sort((a, b) => compareBlocked(boardOrder(a), boardOrder(b)));
  const inflight = efforts.filter((e) => e.section === "inflight").sort((a, b) => compareInflight(boardOrder(a), boardOrder(b)));
  const monitors = efforts.filter((e) => e.section === "monitors").sort((a, b) => compareEfforts(boardOrder(a), boardOrder(b)));

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-medium">{b.name}</h1>
        {b.projectStewardThreadId === null ? (
          <span className="text-muted-foreground">No project steward yet; it starts with the first steward.</span>
        ) : (
          <ThreadLink threadId={b.projectStewardThreadId}>Open the project steward</ThreadLink>
        )}
      </div>
      {b.paused ? (
        <p className="flex items-start gap-2">
          <Icon name="CirclePause" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-label="paused" />
          <span>Stewards are paused: nothing is woken or adopted.</span>
        </p>
      ) : null}

      <Section title="Blocked" count={orphans.length + blocked.length}>
        {orphans.length === 0 && blocked.length === 0 ? (
          <None>Nothing is blocked or waiting on you.</None>
        ) : (
          <List>
            {orphans.map((item) => (
              <NeedsYouOrphanCard key={needsYouItemKey(item)} entry={item} now={now} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
            ))}
            {blocked.map((e) => (
              <StewardCard key={e.steward.key} effort={e} now={now} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
            ))}
          </List>
        )}
      </Section>

      <Section title="In flight" count={inflight.length}>
        {inflight.length === 0 ? (
          <None>Nothing in flight.</None>
        ) : (
          <List>
            {inflight.map((e) => (
              <StewardCard key={e.steward.key} effort={e} now={now} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
            ))}
          </List>
        )}
      </Section>

      <Section title="Monitors" count={monitors.length}>
        {monitors.length === 0 ? (
          <None>No ops bindings.</None>
        ) : (
          <List>
            {monitors.map((e) => (
              <StewardCard key={e.steward.key} effort={e} now={now} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
            ))}
          </List>
        )}
      </Section>

      <Section title="Recently ended" count={b.ended.length}>
        {b.ended.length === 0 ? (
          <None>Nothing ended in the last two weeks.</None>
        ) : (
          <List>
            {b.ended.map((x) => (
              <li key={`${x.key}-${x.endedAt}`} className="flex flex-wrap items-center gap-2 p-3">
                <EntityLink entityKey={x.key} url={x.url} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{x.title}</span>
                <Badge>{x.kind}</Badge>
                {x.endReason !== null ? <Badge>{x.endReason}</Badge> : null}
                <span className="text-xs text-muted-foreground">{ago(x.endedAt, now)}</span>
              </li>
            ))}
          </List>
        )}
      </Section>

      <Section title="Latest digest">
        {b.digest === null ? (
          <None>No digest yet; the project steward writes one at the end of each nightly pass.</None>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">
              {new Date(b.digest.at).toLocaleString()} ({ago(b.digest.at, now)})
            </p>
            <Markdown content={b.digest.text} />
          </div>
        )}
      </Section>

      <LessonsBlock lessons={b.lessons} counts={b.lessonCounts} now={now} />
    </>
  );
}

/**
 * BB-35 step 4: one collapsed details block at the bottom of the project tab,
 * counts by tier and the rows behind a disclosure. No buttons of its own: the
 * boundary Merge / Drop stays the need in "Waiting on you".
 */
function LessonsBlock({ lessons, counts, now }: { lessons: Board["lessons"]; counts: Board["lessonCounts"]; now: number }) {
  const total = counts.candidate + counts.trial + counts.promoted + counts.retired;
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-base font-medium">
        Lessons <span className="text-sm font-normal text-muted-foreground">{total}</span>
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          candidate {counts.candidate} · trial {counts.trial} · promoted {counts.promoted} · retired {counts.retired}
        </span>
      </summary>
      {lessons.length === 0 ? (
        <p className="border-t border-border p-3 text-muted-foreground">No lessons yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {lessons.map((l) => (
            <li key={l.id} className="flex flex-col gap-1 p-3">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={l.scope === "boundary" ? "bad" : "muted"}>{l.scope}</Badge>
                <Badge>{l.tier}</Badge>
                <span className="font-medium">{l.file}</span>
                {l.key !== null ? <span className="text-muted-foreground">{l.key}</span> : null}
                <span className="text-xs text-muted-foreground">{ago(l.createdAt, now)}</span>
              </p>
              <p>{l.text}</p>
              <p className="text-xs text-muted-foreground">
                {l.hits} citation{l.hits === 1 ? "" : "s"} · {l.corrections} correction{l.corrections === 1 ? "" : "s"} · last cited {ago(l.lastCitedAt, now)}
                {l.note !== null ? ` · ${l.note}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * One Stewards page card (BB-78): the BB-76 effort row as its header, then its
 * needs-you items (prompt, muted summary, the page's full controls) or its
 * status report (summary, next action, meta line). The glyph and phrase come
 * from the same `sidebar.ts` rules the sidebar uses.
 */
function StewardCard({ effort, now, onChanged, projectStewardThreadId }: { effort: BoardEffort; now: number; onChanged: () => void; projectStewardThreadId: string | null }) {
  const s = effort.steward;
  return (
    <li className="flex flex-col gap-2 p-3">
      <StewardHeader
        state={effort.state}
        phrase={effort.phrase}
        kind={s.kind}
        phase={s.phase}
        entityKey={s.key}
        url={s.url}
        title={s.title}
        extra={
          <>
            {s.priority !== null && s.priority !== "normal" ? <Badge tone={s.priority === "urgent" ? "bad" : "muted"}>{s.priority}</Badge> : null}
            {s.ending !== null ? <Badge tone="warn">{s.ending === "detach" ? "detaching" : "wrapping up"}</Badge> : null}
          </>
        }
      />
      {effort.items.length > 0 ? (
        effort.items.map((item, i) => (
          <div key={needsYouItemKey(item)} className="flex flex-col gap-2">
            <NeedsYouPrompt entry={item} now={now} />
            {i === 0 ? <p className="text-muted-foreground">{s.summary ?? "No status report yet."}</p> : null}
            <NeedsYouControls entry={item} onChanged={onChanged} projectStewardThreadId={projectStewardThreadId} />
          </div>
        ))
      ) : (
        <>
          {s.summary === null ? (
            <p className="text-muted-foreground">No status report yet.</p>
          ) : (
            <p>
              {s.summary}{" "}
              <span className="text-muted-foreground">
                Next: {s.nextAction ?? "—"}
                {s.actor === null ? "" : ` (${ACTOR_LABEL[s.actor] ?? s.actor})`}
              </span>
            </p>
          )}
          {s.hold !== null ? <p className="text-amber-600 dark:text-amber-500">On hold: {s.hold}</p> : null}
          <p className="text-xs text-muted-foreground">
            {s.kind === "ops" ? `Last wake ${ago(s.wokeAt, now)}` : `Reported ${ago(s.statusAt, now)} · adopted ${ago(s.createdAt, now)}`}
            {s.deployment !== null ? ` · ${deploymentPhrase(s.deployment)}` : ""}
            {s.threadId !== null ? (
              <>
                {" · "}
                <ThreadLink threadId={s.threadId}>Open steward</ThreadLink>
              </>
            ) : null}
            {s.workers.map((w) => (
              <span key={w.threadId}>
                {" · worker "}
                <ThreadLink threadId={w.threadId}>{w.title}</ThreadLink>
              </span>
            ))}
          </p>
        </>
      )}
    </li>
  );
}

/**
 * A needs-you item with no open binding (a project-level question, or one whose
 * binding has ended): its own card at the top of Blocked (BB-78).
 */
function NeedsYouOrphanCard({ entry, now, onChanged, projectStewardThreadId }: { entry: NeedsYouItem; now: number; onChanged: () => void; projectStewardThreadId: string | null }) {
  const key = needsYouKey(entry);
  const url = entry.type === "question" ? entry.question.url : entry.type === "withUser" ? entry.withUser.url : (entry.need.entityUrl ?? entry.need.url);
  return (
    <li className="flex flex-col gap-2 p-3">
      {key !== null ? <EntityLink entityKey={key} url={url} /> : null}
      <NeedsYouPrompt entry={entry} now={now} />
      <NeedsYouControls entry={entry} onChanged={onChanged} projectStewardThreadId={projectStewardThreadId} />
    </li>
  );
}

/** The prompt half of one needs-you item: what it asks, and why it is not actionable yet. */
function NeedsYouPrompt({ entry, now }: { entry: NeedsYouItem; now: number }) {
  if (entry.type === "question") {
    const q = entry.question;
    return (
      <>
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone="bad">{q.escalationId === null ? "question" : "forwarded escalation"}</Badge>
          <span className="text-xs text-muted-foreground">asked {ago(q.createdAt, now)}</span>
        </p>
        <p>{q.question}</p>
        {q.context !== null ? <p className="text-muted-foreground">{q.context}</p> : null}
      </>
    );
  }
  if (entry.type === "withUser") {
    const x = entry.withUser;
    return (
      <>
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone="bad">{x.kind === "approval" ? "approval request" : `${x.kind} escalation`}</Badge>
          <span className="text-xs text-muted-foreground">asked {ago(x.createdAt, now)}</span>
        </p>
        <p>{x.question}</p>
        {x.context !== null ? <p className="text-muted-foreground">{x.context}</p> : null}
        {x.recommendation !== null ? <p className="text-muted-foreground">Recommendation: {x.recommendation}</p> : null}
      </>
    );
  }
  const n = entry.need;
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone="bad">{n.kind}</Badge>
        <span className="text-xs text-muted-foreground">asked {ago(n.createdAt, now)}</span>
      </p>
      <p>{n.what}</p>
      {n.kind === "provide-secret" ? <p className="text-xs text-muted-foreground">The form opens in a thread; the value goes to {n.destination ?? "the destination the item names"}.</p> : null}
      {n.how !== null ? <div className="text-muted-foreground"><Markdown content={n.how} /></div> : null}
      {!n.actionable ? <p className="text-xs text-amber-600 dark:text-amber-500">Not actionable yet: {n.why ?? "the server cannot verify it now"}.</p> : null}
    </>
  );
}

/** The controls half of one needs-you item, chosen by its type; each makes the same RPC call the page always did. */
function NeedsYouControls({ entry, onChanged, projectStewardThreadId }: { entry: NeedsYouItem; onChanged: () => void; projectStewardThreadId: string | null }) {
  if (entry.type === "question") return <QuestionControls question={entry.question} onClosed={onChanged} />;
  if (entry.type === "withUser") return <WithUserControls withUser={entry.withUser} projectStewardThreadId={projectStewardThreadId} />;
  return <NeedControls need={entry.need} onDone={onChanged} />;
}

/**
 * A with-user escalation's controls: a forwarded approval is answered in its
 * steward's thread, anything else waits on the project steward.
 */
function WithUserControls({ withUser: x, projectStewardThreadId }: { withUser: BoardWithUser; projectStewardThreadId: string | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      {x.kind === "approval" ? "Approve or decline in its steward's thread." : "The project steward has not said how to ask you this yet."}
      {x.kind === "approval" && x.threadId !== null ? (
        <>
          {" "}
          <ThreadLink threadId={x.threadId}>Open steward</ThreadLink>
        </>
      ) : null}
      {x.kind !== "approval" && projectStewardThreadId !== null ? (
        <>
          {" "}
          <ThreadLink threadId={projectStewardThreadId}>Open the project steward</ThreadLink>
        </>
      ) : null}
    </p>
  );
}

/**
 * A need's buttons. A button is offered only when the server can verify the
 * item's preconditions now; otherwise the item says why it is not actionable
 * yet. Every action runs on the server, as the user.
 */
function NeedControls({ need: n, onDone }: { need: BoardNeed; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [note, setNote] = useState("");
  // With choices, the text box answers a choice's note until Other… turns it
  // into the free-text answer.
  const [other, setOther] = useState(false);
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  const act = (action: "approve" | "decline" | "done" | "merge" | "provide" | "choose", choice?: string) => {
    setState("running");
    rpc
      .call("stewardsNeedAction", { needId: n.id, action, note: note.trim() === "" ? null : note.trim(), ...(choice === undefined ? {} : { choice }) })
      .then(
        (r) => {
          if (!r.ok) return setState({ error: r.message });
          onDone();
          if (r.threadId !== null && r.threadId !== undefined) navigate.toThread(r.threadId);
        },
        (e: unknown) => setState({ error: message(e) }),
      );
  };
  const primary = "rounded-md border border-input bg-state-hover px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50";
  const secondary = "rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50";
  const takesNote = n.kind === "approve-spec" || n.kind === "configure" || n.kind === "decide";
  const choices = n.kind === "decide" ? n.choices : [];
  // A lesson's Merge/Drop are its only choices: no free-text "Other…".
  const lesson = n.lessonId !== null;
  const freeText = choices.length === 0 || other;
  // The entity link opens the binding's ticket; for approve-pr and merge the
  // item's `url` is the pull request, so it gets its own link.
  const prUrl = n.kind === "approve-pr" || n.kind === "merge" ? n.url : null;
  return (
    <>
      {takesNote && !lesson ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={1}
          placeholder={n.kind === "approve-spec" ? "Note (optional)" : freeText ? "Your answer (optional, saved as guidance)" : "Note (optional, saved as guidance)"}
          aria-label={`Note for: ${n.what}`}
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {n.kind === "approve-spec" ? (
          <>
            <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("approve")}>
              Approve
            </button>
            <button type="button" disabled={!n.actionable || state === "running"} className={secondary} onClick={() => act("decline")}>
              Decline
            </button>
          </>
        ) : n.kind === "approve-pr" ? (
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("approve")}>
            Approve
          </button>
        ) : n.kind === "merge" ? (
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("merge")}>
            Merge
          </button>
        ) : n.kind === "provide-secret" ? (
          <>
            <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("provide")}>
              Provide
            </button>
            <button type="button" disabled={state === "running"} className={secondary} onClick={() => act("done")}>
              Done
            </button>
          </>
        ) : n.kind === "configure" ? (
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("done")}>
            Done
          </button>
        ) : choices.length > 0 && !other ? (
          <>
            {choices.map((choice) => (
              <button key={choice} type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("choose", choice)}>
                {choice}
              </button>
            ))}
            {lesson ? null : (
              <button type="button" disabled={!n.actionable || state === "running"} className={secondary} onClick={() => setOther(true)}>
                Other…
              </button>
            )}
          </>
        ) : (
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("done")}>
            Answer
          </button>
        )}
        {n.threadId !== null ? <ThreadLink threadId={n.threadId}>{n.kind === "provide-secret" ? "Open the requester" : "Open the worker"}</ThreadLink> : null}
        {prUrl !== null ? (
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.openUrl(prUrl)}>
            Open the pull request
          </button>
        ) : null}
        {typeof state === "object" ? <span className="text-destructive">{state.error}</span> : null}
      </div>
    </>
  );
}

/** A question's page controls (BB-78): the optional rationale box, the free-text answer, fixed choices and Other…. */
function QuestionControls({ question: q, onClosed }: { question: BoardQuestion; onClosed: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [answer, setAnswer] = useState("");
  // BB-35 step 4: the rationale box appears only when the plugin set
  // `rationaleWanted`, with its one-line why as the placeholder. An empty box
  // is always accepted.
  const [rationale, setRationale] = useState("");
  // With choices, the text box is the choice's note until Other… turns it
  // into the free-text answer.
  const [other, setOther] = useState(false);
  const [state, setState] = useState<"idle" | "closing" | { error: string }>("idle");
  const close = (choice?: string) => {
    setState("closing");
    rpc
      .call("stewardsAnswerQuestion", {
        questionId: q.id,
        answer: answer.trim() === "" ? null : answer.trim(),
        ...(choice === undefined ? {} : { choice }),
        ...(q.rationaleWanted === null || rationale.trim() === "" ? {} : { rationale: rationale.trim() }),
      })
      .then(
        (r) => {
          if (r.ok) onClosed();
          else setState({ error: r.message });
        },
        (e: unknown) => setState({ error: message(e) }),
      );
  };
  const button = "rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50";
  return (
    <>
      {q.rationaleWanted !== null ? (
        <textarea
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          rows={2}
          placeholder={q.rationaleWanted}
          aria-label={`Why: ${q.question}`}
          className="min-w-0 rounded-md border border-input bg-transparent px-2 py-1"
        />
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={1}
          placeholder={q.choices.length > 0 && !other ? "Note (optional)" : "Your answer (optional)"}
          aria-label={`Answer to: ${q.question}`}
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1"
        />
        {q.choices.length > 0 && !other ? (
          <>
            {q.choices.map((choice) => (
              <button key={choice} type="button" disabled={state === "closing"} className={button} onClick={() => close(choice)}>
                {choice}
              </button>
            ))}
            <button type="button" disabled={state === "closing"} className={button} onClick={() => setOther(true)}>
              Other…
            </button>
          </>
        ) : (
          <button type="button" disabled={state === "closing"} className={button} onClick={() => close()}>
            {state === "closing" ? "Closing…" : "Answer"}
          </button>
        )}
      </div>
      {typeof state === "object" ? <p className="text-destructive">{state.error}</p> : null}
    </>
  );
}

// ---- The sidebar thread list -------------------------------------------------------------------
//
// The opt-in replacement for bb's sidebar list, registered through the
// exclusive `experimental_threadList` slot. One project dropdown, two-line
// effort rows with the four glyphs in the Blocked / In flight / Threads /
// Monitors / Recently ended sections, and a demoted project-steward row. Every
// row carries bb's own thread actions context menu, so nothing bb's rows can
// do is lost.

/** The live fields bb's thread actions read, from a sidebar row. */
function actionTarget(t: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: t.id,
    projectId: t.projectId,
    parentThreadId: t.parentThreadId,
    archivedAt: t.archivedAt,
    pinnedAt: t.pinnedAt,
    sectionId: t.sectionId,
    isUnread: t.isUnread,
    status: t.status,
    environment: t.environment === null || t.environment.id === null ? null : { id: t.environment.id, path: t.environment.path },
  };
}

function countThreads(children: readonly SidebarChild[]): number {
  return children.reduce((n, c) => n + 1 + countThreads(c.children), 0);
}

/** A pull-request key like `acme/web#612` shortens to `#612`; a ticket key stays its key. */
function shortBindingKey(key: string): string {
  const pull = /#(\d+)$/.exec(key);
  return pull === null ? key : `#${pull[1]}`;
}

/** The effort's kind, spelled out for line two. */
function kindLabel(kind: string | null): string {
  if (kind === "pr") return "pull request";
  if (kind === "ticket") return "ticket";
  if (kind === "review") return "review";
  if (kind === "ops") return "ops";
  return kind ?? "thread";
}

/** The phrase's colour follows the glyph's (BB-76): yellow, red, blue, muted. */
function phraseClass(state: SidebarEffortState): string {
  if (state === "you") return "text-amber-600 dark:text-amber-500";
  if (state === "blocked") return "text-destructive";
  if (state === "running") return "text-blue-600 dark:text-blue-400";
  return "text-muted-foreground";
}

/**
 * The four glyphs, in precedence order (BB-76): a solid yellow dot when it
 * waits on you, an empty red ring when blocked, a blue ring that pulses slowly
 * while a worker or agent runs, an empty grey ring when quiet. The pulse is
 * CSS only and stops under `prefers-reduced-motion`.
 */
function StewardGlyph({ kind }: { kind: SidebarEffortState }) {
  if (kind === "you") return <span data-steward-glyph="you" aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-amber-400" />;
  const border = kind === "blocked" ? "border-red-500" : kind === "running" ? "border-blue-500" : "border-muted-foreground/50";
  return <span data-steward-glyph={kind} aria-hidden="true" className={`size-2.5 shrink-0 rounded-full border-2 ${border}${kind === "running" ? " motion-safe:animate-pulse" : ""}`} />;
}

/** A one-off thread's glyph: yellow when unread, blue animated while its agent runs, grey otherwise. */
function oneOffGlyph(thread: PluginSidebarThread): SidebarEffortState {
  if (thread.isUnread || thread.indicator === "unread-success" || thread.indicator === "unread-error") return "you";
  if (isBusy(thread.status)) return "running";
  return "quiet";
}

/** One thread row: a glyph, title and context menu, expanding into its children. */
function SidebarThreadRow({
  thread,
  children,
  depth,
  byId,
  onNavigate,
  meta,
  titleAttr,
  glyph,
}: {
  thread: PluginSidebarThread;
  role: SidebarChildRole;
  children: readonly SidebarChild[];
  depth: number;
  byId: ReadonlyMap<string, PluginSidebarThread>;
  onNavigate: () => void;
  meta?: ReactNode;
  /** The full binding key, kept on the row's `title` attribute when the row is an effort. */
  titleAttr?: string;
  /** The four-glyph component for a one-off thread or its child, an effort's
   * worker/reviewer child, or the project steward row; drafts keep bb's glyph. */
  glyph?: SidebarEffortState;
}) {
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const draft = useSidebarThreadDraft(thread.id);
  const [open, setOpen] = useState(false);
  // The array-wide indicator never reports a draft; the row folds in the
  // client-local one, as bb's own row does.
  const indicator = draft.hasUnsubmittedDraft && thread.indicator === "none" ? (isBusy(thread.status) ? "working-draft" : "draft") : thread.indicator;
  const useStewardGlyph = glyph !== undefined && indicator !== "draft" && indicator !== "working-draft";
  const count = countThreads(children);
  return (
    <li className="flex flex-col">
      <ThreadActionsContextMenu thread={actionTarget(thread)}>
        <div className="flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-state-hover" style={{ paddingLeft: `${4 + depth * 14}px` }} title={titleAttr}>
          {count > 0 ? (
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${thread.displayTitle}`}
              aria-expanded={open}
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            </button>
          ) : (
            <span className="flex size-4 shrink-0 items-center justify-center" />
          )}
          {/* A fixed-width slot keeps the title column put whatever the glyph
              (none, dot, spinner) or its width. The spinner at size="compact"
              is the widest, so size-4 is the slot. */}
          <span data-sidebar-status-slot="" className="flex size-4 shrink-0 items-center justify-center">
            {useStewardGlyph ? <StewardGlyph kind={glyph!} /> : <ThreadStatusGlyph indicator={indicator} rowStatus={rowStatus} size="compact" />}
          </span>
          <a
            href={thread.href}
            className="min-w-0 flex-1 truncate text-sm"
            title={thread.displayTitle}
            onClick={(e) => {
              e.preventDefault();
              navigate.toThread(thread.id);
              onNavigate();
            }}
          >
            <ThreadTitle threadId={thread.id} />
          </a>
          {meta}
        </div>
      </ThreadActionsContextMenu>
      {open && children.length > 0 ? (
        <ul className="flex flex-col">
          {children.map((c) => {
            const child = byId.get(c.threadId);
            return child === undefined ? null : (
              <SidebarThreadRow key={c.threadId} thread={child} role={c.role} children={c.children} depth={depth + 1} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(child)} />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The inline "needs you" block under an effort row's line two (BB-76): the
 * question or need's text, then its one-click actions, exactly the RPC calls
 * the old Needs you block made. A fixed-choice question answers through
 * `stewardsAnswerQuestion`, a `decide` need through `stewardsNeedAction
 * choose`; an approve-pr or merge keeps its Open PR / Approve|Merge buttons;
 * everything else opens the board.
 */
function SidebarInlineNeed({ item, onChanged, onOpenBoard }: { item: SidebarNeedItem; onChanged: () => void; onOpenBoard: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  const text = item.type === "need" ? item.what : item.question;
  const isApprovePr = item.type === "need" && item.kind === "approve-pr";
  const isMerge = item.type === "need" && item.kind === "merge";
  const choices = item.type === "question" ? item.choices : item.type === "need" && item.kind === "decide" ? item.choices : [];
  // A free-text prompt (no choices, not an approve-pr or merge need) cannot be
  // answered from the sidebar, so it gets one line; the rest get three. The
  // full text stays on the element's title and on the page; context is never
  // shown here (BB-79).
  const clamped = choices.length === 0 && !isApprovePr && !isMerge;
  const run = (call: Promise<{ ok: boolean; message: string }>) => {
    setState("running");
    call.then(
      (r) => {
        if (!r.ok) return setState({ error: r.message });
        onChanged();
      },
      (e: unknown) => setState({ error: message(e) }),
    );
  };
  const answer = (choice: string) => run(rpc.call("stewardsAnswerQuestion", { questionId: item.id, answer: null, choice }));
  const choose = (choice: string) => run(rpc.call("stewardsNeedAction", { needId: item.id, action: "choose", note: null, choice }));
  const approve = () => run(rpc.call("stewardsNeedAction", { needId: item.id, action: "approve", note: null, choice: null }));
  const merge = () => run(rpc.call("stewardsNeedAction", { needId: item.id, action: "merge", note: null, choice: null }));
  const button = "rounded-md border border-input px-2 py-0.5 text-[11px] hover:bg-state-hover disabled:opacity-50";
  return (
    <div className="flex flex-col gap-1">
      <p className={`min-w-0 break-words text-[11px] text-muted-foreground ${clamped ? "line-clamp-1" : "line-clamp-3"}`} title={text}>{text}</p>
      <div className="flex flex-wrap items-center gap-1">
        {choices.length > 0 ? (
          choices.map((choice) => (
            <button key={choice} type="button" disabled={state === "running"} className={button} onClick={() => (item.type === "question" ? answer(choice) : choose(choice))}>
              {choice}
            </button>
          ))
        ) : isApprovePr || isMerge ? (
          <>
            {item.url !== null ? (
              <button type="button" className={button} onClick={() => navigate.openUrl(item.url!)}>
                Open PR
              </button>
            ) : null}
            <button type="button" disabled={state === "running"} className={button} onClick={isApprovePr ? approve : merge}>
              {isApprovePr ? "Approve" : "Merge"}
            </button>
          </>
        ) : null}
        <button type="button" className={button} onClick={onOpenBoard}>
          Details
        </button>
        {typeof state === "object" ? <span className="text-[11px] text-destructive">{state.error}</span> : null}
      </div>
    </div>
  );
}

/**
 * One effort's root row, two lines (BB-76): glyph, entity key and title on
 * line one; kind, phase and status phrase on line two; a needs-you row adds
 * its prompt and actions under that, in the same row.
 */
function SidebarEffortRow({
  effort,
  needs,
  byId,
  onNavigate,
  onChanged,
  onOpenBoard,
}: {
  effort: SidebarEffort;
  needs: readonly SidebarNeedItem[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  onNavigate: () => void;
  onChanged: () => void;
  onOpenBoard: () => void;
}) {
  const root = byId.get(effort.rootThreadId);
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  if (root === undefined) return null;
  const key = effort.bindingKey;
  const displayKey = key === null ? null : shortBindingKey(key);
  const title = effortTitle(root.displayTitle, key);
  const count = countThreads(effort.children);
  const mine = needs.filter((item) => item.bindingKey !== null && item.bindingKey === key);
  return (
    <li className="flex flex-col">
      <ThreadActionsContextMenu thread={actionTarget(root)}>
        <div className="flex flex-col rounded-md py-0.5 pr-1 hover:bg-state-hover" style={{ paddingLeft: "4px" }} title={key ?? undefined}>
          <div className="flex items-center gap-1">
            {count > 0 ? (
              <button
                type="button"
                aria-label={`${open ? "Collapse" : "Expand"} ${root.displayTitle}`}
                aria-expanded={open}
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => setOpen((v) => !v)}
              >
                <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
              </button>
            ) : (
              <span className="flex size-4 shrink-0 items-center justify-center" />
            )}
            <span data-sidebar-status-slot="" className="flex size-4 shrink-0 items-center justify-center">
              <StewardGlyph kind={effort.state} />
            </span>
            <a
              href={root.href}
              className="flex min-w-0 flex-1 items-baseline gap-1 text-sm"
              title={root.displayTitle}
              onClick={(e) => {
                e.preventDefault();
                navigate.toThread(root.id);
                onNavigate();
              }}
            >
              {displayKey !== null ? <span className="shrink-0 font-semibold">{displayKey}</span> : null}
              <span className="min-w-0 truncate">{title}</span>
            </a>
          </div>
          <p className="text-[11px] text-muted-foreground" style={{ paddingLeft: "36px" }} data-sidebar-line-two="">
            {kindLabel(effort.kind)}
            {effort.phase !== null ? ` · ${effort.phase}` : ""}
            {" · "}
            <span className={phraseClass(effort.state)}>{effort.phrase}</span>
          </p>
        </div>
      </ThreadActionsContextMenu>
      {mine.length > 0 ? (
        <div className="flex flex-col gap-1 pb-1" style={{ paddingLeft: "40px" }}>
          {mine.map((item) => (
            <SidebarInlineNeed key={`${item.type}:${item.id}`} item={item} onChanged={onChanged} onOpenBoard={onOpenBoard} />
          ))}
        </div>
      ) : null}
      {open && effort.children.length > 0 ? (
        <ul className="flex flex-col">
          {effort.children.map((c) => {
            const child = byId.get(c.threadId);
            return child === undefined ? null : (
              <SidebarThreadRow key={c.threadId} thread={child} role={c.role} children={c.children} depth={1} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(child)} />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function SidebarSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} <span className="font-normal">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function SidebarCollapsible({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        {title} <span className="font-normal">{count}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

/**
 * The project dropdown, always a native `<select>`, with the per-project needs
 * count in each option. The plus button opens the composer on the dropdown's
 * project — the host's own New thread button cannot be retargeted from a thread
 * list — then closes the mobile drawer.
 */
function ProjectTabs({ tabs, counts, activeId, onPick, onNewThread }: { tabs: Array<{ projectId: string; name: string }>; counts: ReadonlyMap<string, number>; activeId: string | null; onPick: (projectId: string) => void; onNewThread: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <select
        aria-label="Project"
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
        value={activeId ?? ""}
        onChange={(e) => onPick(e.target.value)}
      >
        {tabs.map((t) => {
          const count = counts.get(t.projectId) ?? 0;
          return (
            <option key={t.projectId} value={t.projectId}>
              {count > 0 ? `${t.name} (${count})` : t.name}
            </option>
          );
        })}
      </select>
      {tabs.length > 0 ? (
        <button
          type="button"
          aria-label="New thread"
          title="New thread"
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-state-hover hover:text-foreground"
          onClick={onNewThread}
        >
          <Icon name="Plus" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

function StewardsSidebar({ activeProjectId, onNavigate }: PluginThreadListProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { status, threads, projects } = experimental_useSidebarThreads();
  const { data, error, refetch } = usePolled(useCallback(() => rpc.call("stewardsSidebar", null), [rpc]));
  const tabs = useMemo(() => buildSidebar({ projects, threads, data: data?.projects ?? [] }), [projects, threads, data]);
  const needsByProject = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.projectId, p.needs] as const)), [data]);
  // The picker counts the yellow rows, so the pill and the sections cannot disagree (BB-76).
  const counts = useMemo(() => new Map(tabs.map((t) => [t.projectId, t.blocked.filter((e) => e.state === "you").length] as const)), [tabs]);
  // A steward's question or item updates the badge and block within seconds;
  // the half-minute poll stays the fallback. Only a project this sidebar shows
  // triggers a refetch.
  useRealtime(
    NEEDS_YOU_CHANGED,
    useCallback(
      (payload) => {
        const projectId = payload === null || typeof payload !== "object" ? null : (payload as { projectId?: unknown }).projectId;
        if (typeof projectId === "string" && projects.some((p) => p.id === projectId)) refetch();
      },
      [projects, refetch],
    ),
  );
  const byId = useMemo(() => new Map(threads.map((t) => [t.id, t] as const)), [threads]);
  const [picked, setPicked] = useState<string | null>(null);
  // The active tab follows the route; a pick only lasts until the route moves.
  useEffect(() => setPicked(null), [activeProjectId]);
  const wanted = picked ?? activeProjectId;
  const active = tabs.find((t) => t.projectId === wanted) ?? tabs[0] ?? null;
  const activeNeeds = active === null ? undefined : needsByProject.get(active.projectId);
  const now = Date.now();
  // The picker only changes local state; the plus button is what retargets the
  // composer to it, then closes the drawer.
  const openNewThread = () => {
    if (active !== null) navigate.toCompose({ projectId: active.projectId });
    onNavigate();
  };
  const openBoard = () => {
    if (active !== null) navigate.toPluginPanel(BOARD_PATH, { subPath: encodeURIComponent(active.projectId) });
  };
  const needItems = activeNeeds?.items ?? [];
  return (
    <div className="flex h-full flex-col text-sm">
      <ProjectTabs tabs={tabs} counts={counts} activeId={active?.projectId ?? null} onPick={setPicked} onNewThread={openNewThread} />
      {status === "loading" && data === null ? (
        <p className="p-3 text-muted-foreground">Loading…</p>
      ) : active === null ? (
        <p className="p-3 text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
          {active.blocked.length > 0 ? (
            <SidebarSection title="Blocked" count={active.blocked.length}>
              <ul className="flex flex-col">
                {active.blocked.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} needs={needItems} byId={byId} onNavigate={onNavigate} onChanged={refetch} onOpenBoard={openBoard} />
                ))}
              </ul>
            </SidebarSection>
          ) : null}
          <SidebarSection title="In flight" count={active.efforts.length}>
            {active.efforts.length === 0 ? (
              <p className="px-2 py-1 text-muted-foreground">Nothing in flight.</p>
            ) : (
              <ul className="flex flex-col">
                {active.efforts.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} needs={needItems} byId={byId} onNavigate={onNavigate} onChanged={refetch} onOpenBoard={openBoard} />
                ))}
              </ul>
            )}
          </SidebarSection>
          {active.threads.length > 0 ? (
            <SidebarCollapsible title="Threads" count={active.threads.length}>
              <ul className="flex flex-col">
                {active.threads.map((e) => {
                  const t = byId.get(e.rootThreadId);
                  return t === undefined ? null : (
                    <SidebarThreadRow key={e.key} thread={t} role="thread" children={e.children} depth={0} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(t)} />
                  );
                })}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.monitors.length > 0 ? (
            <SidebarCollapsible title="Monitors" count={active.monitors.length}>
              <ul className="flex flex-col">
                {active.monitors.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} needs={needItems} byId={byId} onNavigate={onNavigate} onChanged={refetch} onOpenBoard={openBoard} />
                ))}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.ended.length > 0 ? (
            <SidebarCollapsible title="Recently ended" count={active.ended.length}>
              <ul className="flex flex-col">
                {active.ended.map((e) => {
                  const t = e.threadId === null ? undefined : byId.get(e.threadId);
                  return t === undefined ? (
                    <li key={`${e.key}-${e.endedAt}`} className="flex items-center gap-2 px-2 py-0.5 text-muted-foreground">
                      <span className="font-medium">{e.key}</span>
                      <span className="min-w-0 flex-1 truncate">{e.title ?? ""}</span>
                      <span className="shrink-0 text-[11px]">{ago(e.endedAt, now)}</span>
                    </li>
                  ) : (
                    <SidebarThreadRow
                      key={`${e.key}-${e.endedAt}`}
                      thread={t}
                      role="thread"
                      children={[]}
                      depth={0}
                      byId={byId}
                      onNavigate={onNavigate}
                      meta={<span className="shrink-0 text-[11px] text-muted-foreground">{ago(e.endedAt, now)}</span>}
                    />
                  );
                })}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.projectStewardThreadId !== null && byId.has(active.projectStewardThreadId) ? (
            <div className="mt-auto border-t border-border pt-1">
              <SidebarThreadRow
                thread={byId.get(active.projectStewardThreadId)!}
                role="thread"
                children={[]}
                depth={0}
                byId={byId}
                onNavigate={onNavigate}
                glyph="quiet"
                meta={<span className="shrink-0 text-[10px] uppercase text-muted-foreground">project steward</span>}
              />
            </div>
          ) : null}
        </div>
      )}
      {error !== null ? <p className="px-2 py-1 text-xs text-destructive">Refresh failed: {error}</p> : null}
    </div>
  );
}

// ---- The sidebar-footer toggle -----------------------------------------------------------------
//
// BB-45: an icon in the sidebar footer that opens a small panel above the
// footer row with a switch for the stewards list BB-44 registers. The footer
// is host-rendered and stays in place under either list, so the toggle is
// reachable in both states. The preference it writes is the one Settings →
// Appearance → Sidebar sets; the value is the plugin id plus the `sidebar`
// slot id BB-44 registers.

/** bb answers a stale `expectedRevision` with HTTP 409. */
function isRevisionConflict(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : null;
  return status === 409 || /\bHTTP\s*409\b/u.test(String(error));
}

type ThreadListProviderState = { status: "loading" } | { status: "ready"; on: boolean; revision: number } | { status: "error"; message: string };

/**
 * The disclosure's body: a switch that writes `sidebar.threadListProvider`.
 * The preference is read when the disclosure opens (the component mounts) and
 * again after a conflict. `__automatic__` (the value while nothing is pinned)
 * means bb picks the stewards list, so it reads as on until the load-time pin
 * has made the choice explicit.
 */
function SidebarToggle() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const onId = stewardsThreadListId(pluginId);
  const [state, setState] = useState<ThreadListProviderState>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<{ on: boolean; revision: number }> => {
    const { preferences } = await sdk.system.uiPreferences.list();
    const entry = preferences[THREAD_LIST_PROVIDER_KEY];
    const value = entry?.value;
    return { on: value === onId || value === undefined || value === AUTOMATIC_THREAD_LIST_PROVIDER, revision: entry?.revision ?? 0 };
  }, [sdk, onId]);

  useEffect(() => {
    let live = true;
    read().then(
      (next) => {
        if (live) setState({ status: "ready", ...next });
      },
      (error: unknown) => {
        if (live) setState({ status: "error", message: message(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [read]);

  const flip = useCallback(async () => {
    if (state.status !== "ready" || busy) return;
    const next = !state.on;
    const value = next ? onId : BUILTIN_THREAD_LIST_ID;
    setBusy(true);
    try {
      let revision: number;
      try {
        revision = (await sdk.system.uiPreferences.set({ key: THREAD_LIST_PROVIDER_KEY, value, expectedRevision: state.revision })).revision;
      } catch (error) {
        // Another window changed the preference between our list and our set:
        // re-list and retry once with the fresh revision. Anything else is a
        // real failure.
        if (!isRevisionConflict(error)) throw error;
        const fresh = await read();
        revision = (await sdk.system.uiPreferences.set({ key: THREAD_LIST_PROVIDER_KEY, value, expectedRevision: fresh.revision })).revision;
      }
      setState({ status: "ready", on: next, revision });
    } catch (error) {
      setState({ status: "error", message: message(error) });
    } finally {
      setBusy(false);
    }
  }, [state, busy, onId, read, sdk]);

  const on = state.status === "ready" && state.on;
  return (
    <div className="flex flex-col gap-1 p-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Stewards sidebar</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Stewards sidebar"
          disabled={state.status !== "ready" || busy}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${on ? "border-success bg-success/70" : "border-input bg-state-hover"}`}
          onClick={() => void flip()}
        >
          <span aria-hidden="true" className={`absolute top-0.5 size-3.5 rounded-full bg-background transition-all ${on ? "left-4" : "left-0.5"}`} />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Show the stewards list of threads grouped by project and effort. Off shows bb's own list.</p>
      {state.status === "error" ? <p className="text-xs text-destructive">Could not change the sidebar: {state.message}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Stewards",
    icon: "ShieldCheck",
    path: BOARD_PATH,
    component: BoardPage,
  });
  // The exclusive sidebar slot: while this plugin is enabled and no provider is
  // pinned, this list replaces bb's own (see DESIGN.md, "The sidebar thread list").
  app.slots.experimental_threadList({
    id: "sidebar",
    title: "Stewards",
    description: "Threads grouped by project and in-flight effort, with stages, workers and reviewers.",
    component: StewardsSidebar,
  });
  // The footer disclosure that writes the provider preference, so the list
  // above can be turned on and off without Settings → Appearance.
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "sidebar",
    label: "Stewards sidebar",
    icon: "ShieldCheck",
    component: SidebarToggle,
  });
  app.slots.settingsSection({
    id: "status",
    title: "Status",
    description: "Stewarded projects, their configuration in .bb, and the nightly pass.",
    component: StatusSection,
  });
  app.slots.settingsSection({
    id: "stewards",
    title: "Stewards",
    description: "Every open steward and its latest status report.",
    component: StewardsSection,
  });
});
