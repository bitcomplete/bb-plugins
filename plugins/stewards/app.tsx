// Two surfaces. The Stewards page (a nav panel, BB-85) is no longer the list:
// `board/<project>` is the project view (project name and steward link, the
// items waiting on you with no open binding, one count line, the latest digest
// and the lessons block) and `board/<project>/<key>` is one effort's detail
// (its two-line row one size up, its needs-you items with the page's full
// controls, its status, threads and lessons). The sidebar (the opt-in
// `experimental_threadList`) is the list; the page publishes the project and
// effort its path names through `board-route.ts`, so the list follows it. The
// one write is closing a question put to you or pressing a needs
// item's button. Settings → Plugins → Stewards: which projects are stewarded
// and whether their configuration is healthy, then every open steward and
// where it stands. Steering stays with the project steward and the CLI.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { PROJECT_CHANGED } from "./channels.js";
import { setBoardRoute, useBoardRoute } from "./board-route.js";
import { readLastPlace, writeLastPlace } from "./last-place.js";
import { buildSidebar, compareBlocked, compareEfforts, compareInflight, countThreads, deploymentPhrase, effortPhrase, effortSection, effortState, effortTitle, hasUnread, isBusy, isUnread, type EffortStatus, type SidebarChild, type SidebarChildRole, type SidebarEffort, type SidebarEffortState, type SidebarSection, type SidebarTab } from "./sidebar.js";
import { AUTOMATIC_THREAD_LIST_PROVIDER, BUILTIN_THREAD_LIST_ID, THREAD_LIST_PROVIDER_KEY, stewardsThreadListId } from "./sidebar-provider.js";

type Client = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { projects: unknown; lastSweepAt: unknown }> : never;
type Project = Overview["projects"][number];
type Steward = Project["stewards"][number];
type BoardResult = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { board: unknown }> : never;
type Board = NonNullable<BoardResult["board"]>;
type SidebarResult = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { needs: unknown; bindings: unknown }> : never;
type SidebarNeeds = SidebarResult["needs"];
type SidebarNeedItem = SidebarNeeds["items"][number];
type CheckResult = { ok: boolean; lines: string[] };

const BOARD_PATH = "board";

const POLL_MS = 30_000;
/** How long a burst of refetch requests is coalesced into one RPC (BB-95). */
const REFETCH_DEBOUNCE_MS = 300;
/** How long the sidebar's Open PR handoff waits for the detail page before opening externally (BB-102). */
const OPEN_PR_HANDOFF_MS = 500;

/** Stable empties, so a memoised row's props keep their identity (BB-95). */
const EMPTY_NEEDS: readonly SidebarNeedItem[] = [];
const NO_CHILDREN: readonly SidebarChild[] = [];

// A one-shot handoff from the sidebar's Open PR button to the effort detail
// page (BB-102). The sidebar is mounted outside the route content, so its
// `openUrl` never reaches the in-app browser; the detail page sits inside a
// pane whose `openUrl` does. The URL is carried in memory, not in the route, so
// back, forward and a refresh do not replay the open.
type OpenPrHandoff = { url: string; seq: number };
let openPrHandoff: OpenPrHandoff | null = null;
let openPrSeq = 0;
const openPrListeners = new Set<() => void>();

/** Record the URL for the page to open; the returned sequence is the consumer's ticket. */
function setOpenPrHandoff(url: string): number {
  openPrSeq += 1;
  openPrHandoff = { url, seq: openPrSeq };
  for (const listener of openPrListeners) listener();
  return openPrSeq;
}

/** Take the URL once, only while `seq` is still the slot's; a stale or repeated call gets null. */
function takeOpenPrHandoff(seq: number): string | null {
  if (openPrHandoff === null || openPrHandoff.seq !== seq) return null;
  const { url } = openPrHandoff;
  openPrHandoff = null;
  for (const listener of openPrListeners) listener();
  return url;
}

function subscribeOpenPr(listener: () => void): () => void {
  openPrListeners.add(listener);
  return () => {
    openPrListeners.delete(listener);
  };
}

function getOpenPrHandoff(): OpenPrHandoff | null {
  return openPrHandoff;
}

/** The pending Open PR handoff, so the page re-renders when one arrives. */
function useOpenPrHandoff(): OpenPrHandoff | null {
  return useSyncExternalStore(subscribeOpenPr, getOpenPrHandoff, getOpenPrHandoff);
}

/** Drop any pending handoff; tests use it so one case cannot leak into the next. */
export function resetOpenPrHandoff(): void {
  if (openPrHandoff === null) return;
  openPrHandoff = null;
  for (const listener of openPrListeners) listener();
}

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

/**
 * What `load` returns, refetched every half minute while the page is visible,
 * and on demand. A burst of `refetch()` calls — a steward turn publishing
 * several signals — is coalesced over `REFETCH_DEBOUNCE_MS`, so the burst makes
 * one RPC; a payload deep-equal to the current one is dropped, so an unchanged
 * answer re-renders nothing. The 30 s poll stays the fallback (BB-95).
 */
function usePolled<T>(load: () => Promise<T>): { data: T | null; error: string | null; loaded: boolean; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True once a load has been on screen for a paint, so the first load's rows
  // do not all animate in at once (BB-91).
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  // Only the latest call lands, so a slow answer for the last project does not replace this one's.
  const latest = useRef(0);
  // The payload last committed, so a byte-identical answer is dropped (BB-95).
  const current = useRef<T | null>(null);
  const pending = useRef<number | null>(null);
  const run = useCallback(() => {
    pending.current = null;
    const call = ++latest.current;
    load().then(
      (o) => {
        if (!mounted.current || call !== latest.current) return;
        if (current.current !== null && JSON.stringify(current.current) === JSON.stringify(o)) {
          setError(null);
          return;
        }
        current.current = o;
        setData(o);
        setError(null);
      },
      (e: unknown) => {
        if (mounted.current && call === latest.current) setError(message(e));
      },
    );
  }, [load]);
  const refetch = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      run();
    }, REFETCH_DEBOUNCE_MS);
  }, [run]);
  // A paint after the first successful load, so rows that mount later animate.
  useEffect(() => {
    if (data !== null) setLoaded(true);
  }, [data]);
  useEffect(() => {
    mounted.current = true;
    // The first load and the fallback poll are immediate; only the burst a
    // realtime signal makes is debounced (BB-95).
    run();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
      if (pending.current !== null) window.clearTimeout(pending.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [run]);
  return { data, error, loaded, refetch };
}

function useOverview(): { overview: Overview | null; error: string | null; refetch: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error, refetch } = usePolled(useCallback(() => rpc.call("stewardsOverview", null), [rpc]));
  // The overview covers every project, so any project's visible change
  // refetches it; the half-minute poll stays the fallback.
  useRealtime(
    PROJECT_CHANGED,
    useCallback(() => refetch(), [refetch]),
  );
  return { overview: data, error, refetch };
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
    tone === "bad" ? "border-destructive/40 text-destructive" : tone === "warn" ? "border-amber-500/40 text-attention" : "border-border text-muted-foreground";
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

/** The plugin's in-memory per-method stat (BB-100), shown in the Status section. */
function MethodStats({ title, rows }: { title: string; rows: Record<string, { count: number; totalMs: number; maxMs: number; lastMs: number; lastAt: number | null }> }) {
  const entries = Object.entries(rows).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div>
      <p className="font-medium">{title}</p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">none</p>
      ) : (
        <ul>
          {entries.map(([name, s]) => (
            <li key={name}>
              {name}: {s.count} call{s.count === 1 ? "" : "s"}, total {s.totalMs}ms, max {s.maxMs}ms, last {s.lastMs}ms
              {s.lastAt === null ? "" : ` (${ago(s.lastAt, Date.now())})`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusSection() {
  const { overview, error, refetch } = useOverview();
  if (overview === null) return <Loading error={error} />;
  const now = Date.now();
  return (
    <div className="flex flex-col gap-4 text-sm">
      {overview.paused ? (
        <p className="flex items-start gap-2">
          <Icon name="CirclePause" className="mt-0.5 size-4 shrink-0 text-attention" aria-label="paused" />
          <span>Stewards are paused: nothing is woken or adopted. Changes queue up until you turn Pause stewards off.</span>
        </p>
      ) : null}
      {overview.projects.length === 0 ? (
        <p className="text-muted-foreground">
          No project has a <code>stewards/project.json</code> in its <code>.bb</code>. Run <code>bb stewards init</code> from a thread in a multi-repo project, commit and publish it, and merge the guidance branch.
        </p>
      ) : (
        overview.projects.map((p) => <ProjectStatus key={p.projectId} project={p} now={now} refetch={refetch} />)
      )}
      <p className="text-xs text-muted-foreground">Last sweep {ago(overview.lastSweepAt, now)}; the sweep runs every half hour. Configuration is reread from committed HEAD every few minutes.</p>
      <details className="rounded-lg border border-border p-3 text-xs">
        <summary className="cursor-pointer font-medium text-muted-foreground">Handler stats (this process)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <MethodStats title="RPC methods" rows={overview.stats.rpc} />
          <MethodStats title="CLI commands" rows={overview.stats.cli} />
          <div>
            <p className="font-medium">Signals published in the last hour</p>
            {Object.keys(overview.stats.signals).length === 0 ? (
              <p className="text-muted-foreground">none</p>
            ) : (
              <ul>
                {Object.entries(overview.stats.signals)
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([projectId, count]) => (
                    <li key={projectId}>
                      {projectId}: {count}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </details>
      {error !== null ? <p className="text-xs text-destructive">Refresh failed: {error}</p> : null}
    </div>
  );
}

function ProjectStatus({ project: p, now, refetch }: { project: Project; now: number; refetch: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [check, setCheck] = useState<CheckResult | "running" | { error: string } | null>(null);
  const [toggle, setToggle] = useState<"idle" | "running" | { error: string }>("idle");
  const healthy = p.configured && p.problems.length === 0;
  const setEnabled = (enabled: boolean) => {
    setToggle("running");
    rpc.call("stewardsSetProjectEnabled", { projectId: p.projectId, enabled }).then(
      () => {
        setToggle("idle");
        refetch();
      },
      (e: unknown) => setToggle({ error: message(e) }),
    );
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-2 font-medium">
          <Icon
            name={healthy ? "CircleCheck" : "CircleAlert"}
            className={`size-4 shrink-0 ${healthy ? "text-success" : "text-attention"}`}
            aria-label={healthy ? "healthy" : "needs attention"}
          />
          {p.name}
          {p.configured ? <Badge tone={p.enabled ? "muted" : "warn"}>{p.enabled ? "on" : "off"}</Badge> : null}
        </p>
        <div className="flex items-center gap-2">
          {p.configured ? (
            <button
              type="button"
              role="switch"
              aria-checked={p.enabled}
              aria-label={`Stewards for ${p.name}`}
              disabled={toggle === "running"}
              className="rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50"
              onClick={() => setEnabled(!p.enabled)}
            >
              {toggle === "running" ? "Saving…" : p.enabled ? "Turn off" : "Turn on"}
            </button>
          ) : null}
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
      </div>
      {!p.enabled && p.configured ? <p className="text-muted-foreground">Stewards are off for this project on this server: nothing is adopted and no steward is woken. Turn it on to resume.</p> : null}
      {typeof toggle === "object" ? <p className="text-xs text-destructive">{toggle.error}</p> : null}
      {!p.configured ? (
        <p className="text-muted-foreground">This project has stewards but no readable stewards/project.json any more. They keep their bindings; nothing new is adopted.</p>
      ) : (
        <dl className="flex flex-col gap-1">
          <Row label="Linear teams">{p.linearTeams.join(", ") || "none"}</Row>
          <Row label="Project source">{p.source === null ? "unknown" : p.source === "native" ? "native git (origin's default branch)" : "multi-repo plugin"}</Row>
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

const ACTOR_LABEL: Record<string, string> = { user: "you", steward: "the steward", other: "someone else" };

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
    hold: s.hold,
    holdBehind: s.holdBehind,
    stuck: s.stuck,
    statusActor: s.actor,
    statusNextAction: s.nextAction,
    deployment: s.deployment,
    pending: s.pending,
    requeueAt: s.requeueAt,
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
  const phrase = effortPhrase(status, now);
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
      {s.waitingOn !== null ? <p className="text-muted-foreground">Waiting on {s.waitingOn}</p> : null}
      {s.hold !== null ? <p className="text-attention">On hold: {s.hold}</p> : null}
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

/** `decodeURIComponent` without throwing on a malformed path segment. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The panel's `subPath` names the project in its first segment and, in a detail
 * view, the effort key in everything after it. A pull-request key like
 * `acme/web#612` keeps its own `/`, so the key is the whole remainder, not one
 * more segment.
 */
function parseBoardPath(subPath: string): { projectId: string | null; key: string | null } {
  const slash = subPath.indexOf("/");
  const first = slash === -1 ? subPath : subPath.slice(0, slash);
  const rest = slash === -1 ? "" : subPath.slice(slash + 1);
  return { projectId: first === "" ? null : safeDecode(first), key: rest === "" ? null : safeDecode(rest) };
}

/** The subPath for a project view, or with a key one effort's detail view. */
function boardSubPath(projectId: string, key?: string): string {
  return key === undefined ? projectId : `${projectId}/${key}`;
}

/** Whether one project's sidebar data still lists an effort by that key (BB-113). */
function effortListed(data: SidebarResult, key: string): boolean {
  return data.bindings.some((b) => b.key === key) || data.ended.some((e) => e.key === key);
}

/** A real link to one effort's detail view, keeping a pull-request key's own `/` as path. */
function boardHref(pluginId: string, projectId: string, key: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${BOARD_PATH}/${encodeURIComponent(projectId)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}

function BoardPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { projectId: wanted, key } = parseBoardPath(subPath);
  // Publish the project and effort the path names for the sidebar thread list
  // (BB-94), which the host mounts outside this panel. The effect keyed on the
  // path republishes as it changes; the empty-deps effect clears the store when
  // the panel unmounts, so a thread route falls back to its own props.
  useEffect(() => {
    setBoardRoute({ projectId: wanted, key });
  }, [wanted, key]);
  useEffect(() => () => setBoardRoute({ projectId: null, key: null }), []);
  const { data, error, refetch } = usePolled(useCallback(() => rpc.call("stewardsBoard", { projectId: wanted }), [rpc, wanted]));
  const boardProjectId = data?.board?.projectId ?? null;
  // A path with no project takes the server's choice, replacing rather than
  // pushing so the sidebar follows without a back-button trap.
  useEffect(() => {
    if (wanted === null && boardProjectId !== null) navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(boardProjectId), replace: true });
  }, [wanted, boardProjectId, navigate]);
  // A steward's visible change shows up here without the half-minute poll.
  useRealtime(
    PROJECT_CHANGED,
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
                      onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(p.projectId) })}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {p.name}
                        {!p.enabled ? <Badge tone="warn">off</Badge> : null}
                      </span>
                    </button>
                  );
                })}
              </nav>
            ) : null}
            {data.board === null ? (
              <None>That project is not stewarded.</None>
            ) : key === null ? (
              <ProjectView board={data.board} refetch={refetch} />
            ) : (
              <EffortDetail board={data.board} effortKey={key} refetch={refetch} />
            )}
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
    hold: s.hold,
    holdBehind: s.holdBehind,
    stuck: s.stuck,
    statusActor: s.actor,
    statusNextAction: s.nextAction,
    deployment: s.deployment,
    pending: s.pending,
    requeueAt: s.requeueAt,
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

/** The open efforts with their derived state, section, phrase and needs-you items. */
function boardEfforts(b: Board): { efforts: BoardEffort[]; orphans: NeedsYouItem[] } {
  const now = Date.now();
  // An escalation a need answers is shown as that need's row, not as the raw
  // escalation: a forwarded approval is answered with Approve/Decline, not by
  // "approve or decline in its steward's thread".
  const covered = new Set(b.needs.map((n) => n.escalationId).filter((id): id is string => id !== null));
  const withUser = b.withUser.filter((x) => !covered.has(x.id));
  // A needs-you item attaches to its binding's detail view; an item with no
  // open binding (a project-level question, or one whose binding has ended)
  // waits in the project view.
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
    return { steward: s, state, section: effortSection({ state, kind: s.kind }), phrase: effortPhrase(status, now), items: itemsByKey.get(s.key) ?? [] };
  });
  return { efforts, orphans };
}

/** One line counting the efforts the sidebar holds for this project. */
function boardCountLine(efforts: readonly BoardEffort[], ended: number): string {
  const count = (section: SidebarSection) => efforts.filter((e) => e.section === section).length;
  return `${efforts.length} open: ${count("blocked")} blocked · ${count("inflight")} in flight · ${count("monitors")} monitors · ${ended} recently ended`;
}

/**
 * The project view at `board/<project>` (BB-85): no list of efforts — the
 * sidebar is the list — just the name, the project steward, what waits on you
 * with no open binding, one count line, the digest and the collapsed lessons.
 */
function ProjectView({ board: b, refetch }: { board: Board; refetch: () => void }) {
  const now = Date.now();
  const rpc = useRpc<typeof rpcContract>();
  const [turnOn, setTurnOn] = useState<"idle" | "running" | { error: string }>("idle");
  const { efforts, orphans } = boardEfforts(b);
  const enable = () => {
    setTurnOn("running");
    rpc.call("stewardsSetProjectEnabled", { projectId: b.projectId, enabled: true }).then(
      () => {
        setTurnOn("idle");
        refetch();
      },
      (e: unknown) => setTurnOn({ error: message(e) }),
    );
  };
  return (
    <>
      {!b.enabled ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p>
            Stewards are off for this project on this server: nothing is adopted, no steward is woken, and the ticket and pull request labels do nothing here. This is a
            per-server setting.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label={`Stewards for ${b.name}`}
              disabled={turnOn === "running"}
              className="rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50"
              onClick={enable}
            >
              {turnOn === "running" ? "Saving…" : "Turn on"}
            </button>
            <span className="text-muted-foreground">Or turn it on in Settings → Plugins → Stewards → Status.</span>
          </div>
          {typeof turnOn === "object" ? <p className="text-xs text-destructive">{turnOn.error}</p> : null}
        </div>
      ) : null}
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
          <Icon name="CirclePause" className="mt-0.5 size-4 shrink-0 text-attention" aria-label="paused" />
          <span>Stewards are paused: nothing is woken or adopted.</span>
        </p>
      ) : null}

      <Section title="Waiting on you" count={orphans.length}>
        {orphans.length === 0 ? (
          <None>Nothing is waiting on you.</None>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {orphans.map((item) => (
              <NeedsYouOrphanCard key={needsYouItemKey(item)} entry={item} now={now} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
            ))}
          </ul>
        )}
      </Section>

      <p data-board-count-line="" className="text-muted-foreground">
        {boardCountLine(efforts, b.ended.length)}
      </p>

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
        <LessonsList lessons={lessons} now={now} className="border-t border-border" />
      )}
    </details>
  );
}

/**
 * The detail view at `board/<project>/<key>` (BB-85): the effort's own page.
 * Its heading is the sidebar's two-line row one size up, with a crumb back to
 * the project view; below it the needs-you items with the page's full controls,
 * the status report, the threads and the lessons the effort wrote.
 */
function EffortDetail({ board: b, effortKey, refetch }: { board: Board; effortKey: string; refetch: () => void }) {
  const now = Date.now();
  const navigate = useBbNavigate();
  // BB-102: the sidebar's Open PR button leaves the PR URL in the one-shot
  // handoff; this page is inside a pane, so its `openUrl` reaches the in-app
  // browser. One effect keyed on the sequence opens it and clears the slot, so
  // an unmount/remount (or a back/forward) does not replay it.
  const handoff = useOpenPrHandoff();
  const handoffSeq = handoff?.seq ?? null;
  useEffect(() => {
    if (handoffSeq === null) return;
    const url = takeOpenPrHandoff(handoffSeq);
    if (url !== null) navigate.openUrl(url);
  }, [handoffSeq, navigate]);
  const { efforts } = boardEfforts(b);
  const effort = efforts.find((e) => e.steward.key === effortKey);
  if (effort === undefined) {
    const ended = b.ended.find((x) => x.key === effortKey);
    if (ended !== undefined) return <EndedDetail board={b} ended={ended} now={now} />;
    return <UnknownEffort board={b} effortKey={effortKey} />;
  }
  const s = effort.steward;
  const lessons = b.lessons.filter((l) => l.key === effortKey);
  const stuck = b.stuck.find((x) => x.key === effortKey) ?? null;
  return (
    <>
      <EffortHeading board={b} effort={effort} />
      <Section title="Needs you" count={effort.items.length}>
        {effort.items.length === 0 ? (
          <None>Nothing is waiting on you for this effort.</None>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {effort.items.map((item) => (
              <li key={needsYouItemKey(item)} className="flex flex-col gap-2 p-3">
                <NeedsYouPrompt entry={item} now={now} />
                <NeedsYouControls entry={item} onChanged={refetch} projectStewardThreadId={b.projectStewardThreadId} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Status">
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          {s.summary === null ? <p className="text-muted-foreground">No status report yet.</p> : <p>{s.summary}</p>}
          <p className="text-muted-foreground">
            Next: {s.nextAction ?? "—"}
            {s.actor === null ? "" : ` (${ACTOR_LABEL[s.actor] ?? s.actor})`}
          </p>
          {s.waitingOn !== null ? <p className="text-muted-foreground">Waiting on {s.waitingOn}</p> : null}
          {s.hold !== null ? <p className="text-attention">On hold: {s.hold}{s.holdBehind.length > 0 ? ` (behind ${s.holdBehind.join(", ")})` : ""}</p> : null}
          {s.stuck ? <p className="text-destructive">Stuck{stuck === null ? "" : `: ${stuck.why}`}</p> : null}
          <p className="text-xs text-muted-foreground">
            {s.kind === "ops" ? `Last wake ${ago(s.wokeAt, now)}` : `Reported ${ago(s.statusAt, now)} · adopted ${ago(s.createdAt, now)}`}
            {s.stage !== null ? ` · stage ${s.stage}` : ""}
            {s.deployment !== null ? ` · ${deploymentPhrase(s.deployment)}` : ""}
          </p>
        </div>
      </Section>
      <Section title="Threads">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border p-3">
          {s.threadId === null ? null : <ThreadLink threadId={s.threadId}>Open the steward</ThreadLink>}
          {s.workers.map((w) => (
            <ThreadLink key={w.threadId} threadId={w.threadId}>{w.title}</ThreadLink>
          ))}
          {s.url === null ? null : (
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate.openUrl(s.url!)}>
              {s.kind === "pr" ? "Open the pull request" : "Open the entity"}
            </button>
          )}
        </div>
      </Section>
      <Section title="Lessons" count={lessons.length}>
        {lessons.length === 0 ? <None>This effort wrote no lessons.</None> : <LessonsList lessons={lessons} now={now} />}
      </Section>
    </>
  );
}

/** The detail heading: the sidebar's two-line effort row one size up, with a crumb back. */
function EffortHeading({ board: b, effort }: { board: Board; effort: BoardEffort }) {
  const navigate = useBbNavigate();
  const s = effort.steward;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(b.projectId) })}
      >
        ← {b.name}
      </button>
      <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2 text-base" title={s.key}>
          <StewardGlyph kind={effort.state} />
          <EntityLink entityKey={shortBindingKey(s.key)} url={s.url} />
          {s.title === null ? null : <span className="min-w-0 flex-1 truncate text-lg font-medium">{s.title}</span>}
          {s.priority !== null && s.priority !== "normal" ? <Badge tone={s.priority === "urgent" ? "bad" : "muted"}>{s.priority}</Badge> : null}
          {s.ending !== null ? <Badge tone="warn">{s.ending === "detach" ? "detaching" : "wrapping up"}</Badge> : null}
        </div>
        <p data-steward-line-two="" className="text-xs text-muted-foreground">
          {kindLabel(s.kind)}
          {s.phase !== null ? ` · ${s.phase}` : ""}
          {" · "}
          <span className={phraseClass(effort.state)}>{effort.phrase}</span>
        </p>
      </div>
    </div>
  );
}

/** An ended effort's detail: what the board still knows about it. */
function EndedDetail({ board: b, ended, now }: { board: Board; ended: Board["ended"][number]; now: number }) {
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(b.projectId) })}
      >
        ← {b.name}
      </button>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2 text-base" title={ended.key}>
          <EntityLink entityKey={shortBindingKey(ended.key)} url={ended.url} />
          {ended.title === null ? null : <span className="min-w-0 flex-1 truncate text-lg font-medium">{ended.title}</span>}
          <Badge>{kindLabel(ended.kind)}</Badge>
          {ended.endReason === null ? null : <Badge>{ended.endReason}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">Ended {ago(ended.endedAt, now)}</p>
        {ended.threadId === null ? <p className="text-muted-foreground">Its thread is no longer available.</p> : <p><ThreadLink threadId={ended.threadId}>Open the archived thread</ThreadLink></p>}
      </div>
    </div>
  );
}

/** A key the board does not know. */
function UnknownEffort({ board: b, effortKey }: { board: Board; effortKey: string }) {
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(b.projectId) })}
      >
        ← {b.name}
      </button>
      <None>No effort <code>{effortKey}</code> on this board. It may have ended more than two weeks ago.</None>
    </div>
  );
}

/** The lesson rows, shared by the project view's collapsed block and one effort's detail. */
function LessonsList({ lessons, now, className = "rounded-lg border border-border" }: { lessons: Board["lessons"]; now: number; className?: string }) {
  return (
    <ul className={`flex flex-col divide-y divide-border ${className}`}>
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
      {!n.actionable ? <p className="text-xs text-attention">Not actionable yet: {n.why ?? "the server cannot verify it now"}.</p> : null}
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
  const takesNote = n.kind === "approve-spec" || n.kind === "approve-pr" || n.kind === "configure" || n.kind === "decide";
  const choices = n.kind === "decide" ? n.choices : [];
  // A lesson's Merge/Drop are its only choices: no free-text "Other…".
  const lesson = n.lessonId !== null;
  const freeText = choices.length === 0 || other;
  // The entity link opens the binding's ticket; for approve-pr and merge the
  // item's `url` is the pull request, so it gets its own link.
  const prUrl = n.kind === "approve-pr" || n.kind === "merge" ? n.url : (n.prUrl ?? null);
  return (
    <>
      {takesNote && !lesson ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={1}
          placeholder={n.kind === "approve-spec" ? "Note (optional)" : n.kind === "approve-pr" ? "Note (optional; used when you decline)" : freeText ? "Your answer (optional, saved as guidance)" : "Note (optional, saved as guidance)"}
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
          <>
            <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("approve")}>
              Approve
            </button>
            <button type="button" disabled={!n.actionable || state === "running"} className={secondary} onClick={() => act("decline")}>
              Decline
            </button>
          </>
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
        {lesson && n.prUrl === null && n.kind === "decide" && n.choices.includes("Review PR") ? <span className="text-muted-foreground">The pull request is not open yet.</span> : null}
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
// exclusive `experimental_threadList` slot. One project dropdown,
// two-line effort rows with the four glyphs in the Blocked / In flight /
// Threads / Monitors / Recently ended sections, and a demoted project-steward
// row. An effort row and a Recently ended row open the detail view; worker,
// reviewer, one-off and project-steward rows open their thread; the effort the
// Stewards page shows is highlighted and navigation expands a collapsed parent
// (the page publishes it through `board-route.ts`, BB-94). Every
// effort and thread row carries bb's own thread actions context menu, so
// nothing bb's rows can do is lost.

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

/** The phrase's colour follows the glyph's (BB-76), in bb's theme tokens (BB-99): attention, destructive, timeline-accent, muted. */
function phraseClass(state: SidebarEffortState): string {
  const transition = "motion-safe:transition-colors duration-300";
  if (state === "you") return `text-attention ${transition}`;
  if (state === "blocked") return `text-destructive ${transition}`;
  if (state === "running") return `text-timeline-accent ${transition}`;
  return `text-muted-foreground ${transition}`;
}

/**
 * The four glyphs, in precedence order (BB-76): a solid attention dot when it
 * waits on you, an empty destructive ring when blocked, a timeline-accent ring
 * that pulses slowly while a worker or agent runs, an empty muted ring when
 * quiet. The pulse is CSS only and stops under `prefers-reduced-motion`.
 */
function StewardGlyph({ kind }: { kind: SidebarEffortState }) {
  const transition = "motion-safe:transition-colors duration-300";
  if (kind === "you") return <span data-steward-glyph="you" aria-hidden="true" className={`size-2.5 shrink-0 rounded-full bg-attention ${transition}`} />;
  const border = kind === "blocked" ? "border-destructive" : kind === "running" ? "border-timeline-accent" : "border-muted-foreground/50";
  return <span data-steward-glyph={kind} aria-hidden="true" className={`size-2.5 shrink-0 rounded-full border-2 ${border} ${transition}${kind === "running" ? " motion-safe:animate-pulse" : ""}`} />;
}

/** A one-off thread's glyph: attention when unread, timeline-accent animated while its agent runs, muted otherwise. */
function oneOffGlyph(thread: PluginSidebarThread): SidebarEffortState {
  if (isUnread(thread)) return "you";
  if (isBusy(thread.status)) return "running";
  return "quiet";
}

/**
 * A signature of the read state of a child tree (BB-95): two rows with the
 * same signature have the same unread glyphs and the same auto-expand state, so
 * a memoised row can skip. A thread's read state feeds neither `SidebarLiveThread`
 * nor `SidebarEffort`, and `byId` is a new Map on every host tick, so the state
 * itself has to be part of the props for a memoised row to see it change.
 */
function unreadKey(children: readonly SidebarChild[], byId: ReadonlyMap<string, PluginSidebarThread>): string {
  let out = "";
  for (const c of children) {
    const t = byId.get(c.threadId);
    out += `${c.threadId}:${t === undefined ? "-" : `${t.isUnread ? 1 : 0}${t.indicator}`};`;
    out += unreadKey(c.children, byId);
  }
  return out;
}

/**
 * Per-row render counters, for the sidebar tests to assert that a same-content
 * refetch or host tick re-renders only the row whose data changed (BB-95).
 * Exported for `sidebar-app.test.tsx`; the production cost is one map write per
 * row render.
 */
export const rowRenderCounts = new Map<string, number>();
function useRenderProbe(key: string): void {
  useEffect(() => {
    // A cap keeps the probe from growing without bound over a long session.
    if (rowRenderCounts.size > 500) rowRenderCounts.clear();
    rowRenderCounts.set(key, (rowRenderCounts.get(key) ?? 0) + 1);
  });
}

type SidebarThreadRowProps = {
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
  /** The route's thread, so the row is highlighted while its page is showing (BB-85). */
  activeThreadId: string | null;
  /** The rows that must be open so the active thread is revealed (BB-85). */
  openThreads: ReadonlySet<string>;
  /** A signature of the descendants' read state, so a memoised row re-renders when any of them is read (BB-95). */
  unreadKey: string;
  /** Whether the first load has painted, so a row that mounts later animates in (BB-91). */
  entered?: boolean;
};

/**
 * Whether two `SidebarThreadRow` prop sets render the same output. `byId` is
 * ignored: it is a new Map whenever the host's thread list ticks, and the row
 * only reads it for threads whose own changes already arrive through `thread`,
 * `children` and `unreadKey`. `openThreads` is compared only for this row's
 * own membership, so a new Set with the same members is not a change (BB-95).
 */
function sameThreadRowProps(a: SidebarThreadRowProps, b: SidebarThreadRowProps): boolean {
  return (
    a.thread === b.thread &&
    a.children === b.children &&
    a.depth === b.depth &&
    a.onNavigate === b.onNavigate &&
    a.meta === b.meta &&
    a.titleAttr === b.titleAttr &&
    a.glyph === b.glyph &&
    a.activeThreadId === b.activeThreadId &&
    a.entered === b.entered &&
    a.unreadKey === b.unreadKey &&
    a.openThreads.has(a.thread.id) === b.openThreads.has(b.thread.id)
  );
}

/** One thread row: a glyph, title and context menu, expanding into its children. */
const SidebarThreadRow = memo(function SidebarThreadRow({
  thread,
  children,
  depth,
  byId,
  onNavigate,
  meta,
  titleAttr,
  glyph,
  activeThreadId,
  openThreads,
  entered = false,
}: SidebarThreadRowProps) {
  useRenderProbe(`thread:${thread.id}`);
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const draft = useSidebarThreadDraft(thread.id);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const selected = activeThreadId !== null && thread.id === activeThreadId;
  // Navigation to a row inside this one expands it, so the highlighted row is revealed.
  const revealed = openThreads.has(thread.id);
  useEffect(() => {
    if (revealed) setUserOpen(true);
  }, [revealed]);
  // An untouched row follows the unread state of its descendants (BB-80); a
  // manual toggle always wins.
  const open = userOpen ?? hasUnread(children, byId);
  // The array-wide indicator never reports a draft; the row folds in the
  // client-local one, as bb's own row does.
  const indicator = draft.hasUnsubmittedDraft && thread.indicator === "none" ? (isBusy(thread.status) ? "working-draft" : "draft") : thread.indicator;
  const useStewardGlyph = glyph !== undefined && indicator !== "draft" && indicator !== "working-draft";
  const count = countThreads(children);
  return (
    <li className={`flex flex-col ${entered ? " motion-safe:animate-in fade-in-0 slide-in-from-top-1 duration-200" : ""}`}>
      <ThreadActionsContextMenu thread={actionTarget(thread)}>
        <div className={`flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-state-hover ${selected ? "bg-state-active" : ""}`} style={{ paddingLeft: `${4 + depth * 14}px` }} title={titleAttr}>
          {count > 0 ? (
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${thread.displayTitle}`}
              aria-expanded={open}
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              onClick={() => setUserOpen(!open)}
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
            aria-current={selected ? "page" : undefined}
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
              <SidebarThreadRow key={c.threadId} thread={child} role={c.role} children={c.children} depth={depth + 1} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(child)} activeThreadId={activeThreadId} openThreads={openThreads} unreadKey={unreadKey(c.children, byId)} entered={entered} />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}, sameThreadRowProps);

/**
 * The inline "needs you" block under an effort row's line two (BB-76): the
 * question or need's text, then its one-click actions, exactly the RPC calls
 * the old Needs you block made. A fixed-choice question answers through
 * `stewardsAnswerQuestion`, a `decide` need through `stewardsNeedAction
 * choose`; an approve-pr or merge keeps its Open PR / Approve|Merge buttons.
 * The row itself opens the detail view (BB-85), so there is no Details button.
 */
function SidebarInlineNeed({ item, projectId, effortKey, onChanged }: { item: SidebarNeedItem; projectId: string; effortKey: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  // The fallback timer that opens the PR externally when the page never takes
  // the handoff (a hidden panel, a chunk that failed to load) (BB-102).
  const openPrFallback = useRef<number | null>(null);
  useEffect(() => () => {
    if (openPrFallback.current !== null) window.clearTimeout(openPrFallback.current);
  }, []);
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
  const decline = () => run(rpc.call("stewardsNeedAction", { needId: item.id, action: "decline", note: null, choice: null }));
  const merge = () => run(rpc.call("stewardsNeedAction", { needId: item.id, action: "merge", note: null, choice: null }));
  // BB-102: hand the URL to the detail page, which is inside a pane and can
  // open it in bb's in-app browser, then go there as the row does. If nothing
  // takes the slot in time, fall back to the sidebar's own (external) openUrl.
  const openPr = () => {
    const url = item.url;
    if (url === null) return;
    if (openPrFallback.current !== null) window.clearTimeout(openPrFallback.current);
    const seq = setOpenPrHandoff(url);
    navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(projectId, effortKey) });
    openPrFallback.current = window.setTimeout(() => {
      openPrFallback.current = null;
      const pending = takeOpenPrHandoff(seq);
      if (pending !== null) navigate.openUrl(pending);
    }, OPEN_PR_HANDOFF_MS);
  };
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
              <button type="button" className={button} onClick={openPr}>
                Open PR
              </button>
            ) : null}
            <button type="button" disabled={state === "running"} className={button} onClick={isApprovePr ? approve : merge}>
              {isApprovePr ? "Approve" : "Merge"}
            </button>
            {isApprovePr ? (
              <button type="button" disabled={state === "running"} className={button} onClick={decline}>
                Decline
              </button>
            ) : null}
          </>
        ) : null}
        {typeof state === "object" ? <span className="text-[11px] text-destructive">{state.error}</span> : null}
      </div>
    </div>
  );
}

/**
 * One effort's root row, two lines (BB-76): glyph, entity key and title on
 * line one; kind, phase and status phrase on line two; a needs-you row adds
 * its prompt and actions under that, in the same row. A stewarded effort row is
 * a real link to its detail view (BB-85) and is highlighted while the board
 * shows that effort.
 */
type SidebarEffortRowProps = {
  effort: SidebarEffort;
  needs: readonly SidebarNeedItem[];
  byId: ReadonlyMap<string, PluginSidebarThread>;
  projectId: string;
  /** The effort key the board is showing, so its row is highlighted (BB-85). */
  activeKey: string | null;
  /** The route's thread, passed to the effort's worker and reviewer rows (BB-85). */
  activeThreadId: string | null;
  /** The rows that must be open so the active thread is revealed (BB-85). */
  openThreads: ReadonlySet<string>;
  /** A signature of the descendants' read state, so a memoised row re-renders when any of them is read (BB-95). */
  unreadKey: string;
  onNavigate: () => void;
  onChanged: () => void;
  /** A right-aligned stamp after the title, for a Recently ended row's `ended N ago` (BB-88). */
  trailing?: ReactNode;
  /** Whether the first load has painted, so a row that mounts later animates in (BB-91). */
  entered?: boolean;
};

/**
 * Whether two `SidebarEffortRow` prop sets render the same output. `effort` is
 * structurally shared by `buildSidebar`, so an unchanged effort keeps its
 * identity. `byId` is ignored (a new Map on every host tick); the read state of
 * the effort's threads arrives as `unreadKey`, and the needs this row shows are
 * compared by content, since the RPC hands back fresh objects (BB-95).
 */
function sameEffortRowProps(a: SidebarEffortRowProps, b: SidebarEffortRowProps): boolean {
  if (
    a.effort !== b.effort ||
    a.projectId !== b.projectId ||
    a.activeKey !== b.activeKey ||
    a.activeThreadId !== b.activeThreadId ||
    a.onNavigate !== b.onNavigate ||
    a.onChanged !== b.onChanged ||
    a.trailing !== b.trailing ||
    a.entered !== b.entered ||
    a.unreadKey !== b.unreadKey ||
    a.openThreads.has(a.effort.rootThreadId) !== b.openThreads.has(b.effort.rootThreadId)
  ) {
    return false;
  }
  const key = a.effort.bindingKey;
  const aMine = key === null ? EMPTY_NEEDS : a.needs.filter((item) => item.bindingKey === key);
  const bMine = key === null ? EMPTY_NEEDS : b.needs.filter((item) => item.bindingKey === key);
  if (aMine.length !== bMine.length) return false;
  for (let i = 0; i < aMine.length; i += 1) if (JSON.stringify(aMine[i]) !== JSON.stringify(bMine[i])) return false;
  return true;
}

const SidebarEffortRow = memo(function SidebarEffortRow({
  effort,
  needs,
  byId,
  projectId,
  activeKey,
  activeThreadId,
  openThreads,
  onNavigate,
  onChanged,
  trailing,
  entered = false,
}: SidebarEffortRowProps) {
  useRenderProbe(`effort:${effort.key}`);
  const root = byId.get(effort.rootThreadId);
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const key = effort.bindingKey;
  if (key === null) return null;
  const displayKey = shortBindingKey(key);
  // A Recently ended binding's steward thread is usually archived and so absent
  // from the live view; its title comes from the RPC and the row renders without
  // the thread actions context menu (BB-88).
  const title = effortTitle(root?.displayTitle ?? effort.title, key);
  const count = countThreads(effort.children);
  const mine = needs.filter((item) => item.bindingKey !== null && item.bindingKey === key);
  const selected = activeKey !== null && activeKey === key;
  const revealed = openThreads.has(effort.rootThreadId);
  useEffect(() => {
    if (revealed) setUserOpen(true);
  }, [revealed]);
  // An untouched effort follows the unread state of its workers and reviewers
  // (BB-80); a manual toggle always wins.
  const open = userOpen ?? hasUnread(effort.children, byId);
  const href = boardHref(pluginId, projectId, key);
  const body = (
    <div className={`flex flex-col rounded-md py-0.5 pr-1 hover:bg-state-hover ${selected ? "bg-state-active" : ""}`} style={{ paddingLeft: "4px" }} title={key ?? undefined}>
      <div className="flex items-center gap-1">
        {count > 0 ? (
          <button
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${root?.displayTitle ?? effort.title}`}
            aria-expanded={open}
            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            onClick={() => setUserOpen(!open)}
          >
            <Icon name="ChevronRight" className={`size-3.5 motion-safe:transition-transform motion-safe:duration-200 ${open ? " rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="flex size-4 shrink-0 items-center justify-center" />
        )}
        <span data-sidebar-status-slot="" className="flex size-4 shrink-0 items-center justify-center">
          <StewardGlyph kind={effort.state} />
        </span>
        <a
          href={href}
          aria-current={selected ? "page" : undefined}
          className="flex min-w-0 flex-1 items-baseline gap-1 text-sm"
          title={root?.displayTitle ?? effort.title}
          onClick={(e) => {
            e.preventDefault();
            navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(projectId, key) });
            onNavigate();
          }}
        >
          <span className="shrink-0 font-semibold">{displayKey}</span>
          <span className="min-w-0 truncate">{title}</span>
        </a>
        {trailing}
      </div>
      <p className="text-[11px] text-muted-foreground" style={{ paddingLeft: "36px" }} data-sidebar-line-two="">
        {kindLabel(effort.kind)}
        {effort.phase !== null ? ` · ${effort.phase}` : ""}
        {" · "}
        <span className={phraseClass(effort.state)}>{effort.phrase}</span>
      </p>
    </div>
  );
  return (
    <li className={`flex flex-col ${entered ? " motion-safe:animate-in fade-in-0 slide-in-from-top-1 duration-200" : ""}`}>
      {root === undefined ? body : <ThreadActionsContextMenu thread={actionTarget(root)}>{body}</ThreadActionsContextMenu>}
      {mine.length > 0 ? (
        <div className="flex flex-col gap-1 pb-1" style={{ paddingLeft: "40px" }}>
          {mine.map((item) => (
            <SidebarInlineNeed key={`${item.type}:${item.id}`} item={item} projectId={projectId} effortKey={key} onChanged={onChanged} />
          ))}
        </div>
      ) : null}
      {effort.children.length > 0 ? (
        <div data-sidebar-workers="" className={`grid motion-safe:transition-[grid-template-rows,visibility] motion-safe:duration-200 ${open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"}`}>
          <ul className="flex min-h-0 flex-col overflow-hidden">
            {effort.children.map((c) => {
              const child = byId.get(c.threadId);
              return child === undefined ? null : (
                <SidebarThreadRow key={c.threadId} thread={child} role={c.role} children={c.children} depth={1} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(child)} activeThreadId={activeThreadId} openThreads={openThreads} unreadKey={unreadKey(c.children, byId)} entered={entered} />
              );
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
}, sameEffortRowProps);

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

const SidebarCollapsible = memo(function SidebarCollapsible({ title, count, revealed = false, unread = false, children }: { title: string; count: number; revealed?: boolean; /** Whether a thread in the section is unread, so an untouched section opens (BB-80). */ unread?: boolean; children: ReactNode }) {
  // An untouched section follows the unread state of the threads in it
  // (BB-80); a manual toggle always wins.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Navigation to a row inside this section expands it, so the row is revealed.
  useEffect(() => {
    if (revealed) setUserOpen(true);
  }, [revealed]);
  const open = userOpen ?? unread;
  return (
    <section className="flex flex-col">
      {/* `<details>` only for its `open` attribute, which drives the chevron's
          `group-open:` rotation; the body is a sibling so it stays mounted and
          eases between `0fr` and `1fr` (BB-91). */}
      <details className="group" open={open}>
        <summary
          role="button"
          aria-expanded={open}
          className="flex cursor-pointer list-none items-center gap-1 px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            setUserOpen(!open);
          }}
        >
          <Icon name="ChevronRight" className="size-3.5 motion-safe:transition-transform group-open:rotate-90" />
          {title} <span className="font-normal">{count}</span>
        </summary>
      </details>
      <div data-sidebar-collapsible="" className={`grid motion-safe:transition-[grid-template-rows,visibility] motion-safe:duration-200 ${open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
});

/**
 * The project dropdown, always a native `<select>`, with the per-project needs
 * count in each option. The plus button opens the composer on the dropdown's
 * project — the host's own New thread button cannot be retargeted from a thread
 * list — then closes the mobile drawer.
 */
const ProjectTabs = memo(function ProjectTabs({ tabs, counts, activeId, onPick, onNewThread }: { tabs: Array<{ projectId: string; name: string }>; counts: ReadonlyMap<string, number>; activeId: string | null; onPick: (projectId: string) => void; onNewThread: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5">
      <div className="relative min-w-0 flex-1">
        <select
          aria-label="Project"
          className="h-8 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent pl-3 pr-7 text-sm"
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
        <Icon
          name="ChevronDown"
          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
      </div>
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
});

/** Whether `id` is anywhere in a child tree. */
function subtreeHas(children: readonly SidebarChild[], id: string): boolean {
  return children.some((c) => c.threadId === id || subtreeHas(c.children, id));
}

/** Whether any effort in a section has an unread root or descendant thread (BB-80). */
function sectionHasUnread(efforts: readonly SidebarEffort[], byId: ReadonlyMap<string, PluginSidebarThread>): boolean {
  return efforts.some((e) => {
    const root = byId.get(e.rootThreadId);
    return (root !== undefined && isUnread(root)) || hasUnread(e.children, byId);
  });
}

/** The ancestor thread ids from the direct parent up, or null when `id` is not in the tree. */
function ancestorThreads(children: readonly SidebarChild[], id: string): string[] | null {
  for (const c of children) {
    if (c.threadId === id) return [];
    const sub = ancestorThreads(c.children, id);
    if (sub !== null) return [c.threadId, ...sub];
  }
  return null;
}

/** Every effort row a tab renders, whatever its section. */
function tabEfforts(tab: SidebarTab): SidebarEffort[] {
  return [...tab.blocked, ...tab.efforts, ...tab.monitors, ...tab.threads];
}

/** The effort and thread rows that must be open so the active thread is revealed (BB-85). */
function revealThreads(tabs: readonly SidebarTab[], activeThreadId: string | null): ReadonlySet<string> {
  const open = new Set<string>();
  if (activeThreadId === null) return open;
  for (const tab of tabs) {
    for (const effort of tabEfforts(tab)) {
      const chain = ancestorThreads(effort.children, activeThreadId);
      if (chain === null) continue;
      open.add(effort.rootThreadId);
      for (const id of chain) open.add(id);
    }
  }
  return open;
}

/** The collapsed sections that must be open so the active thread or effort is revealed (BB-85). */
function revealSections(tabs: readonly SidebarTab[], activeThreadId: string | null, activeKey: string | null): ReadonlySet<string> {
  const open = new Set<string>();
  for (const tab of tabs) {
    if ((activeThreadId !== null && tab.ended.some((e) => e.rootThreadId === activeThreadId)) || (activeKey !== null && tab.ended.some((e) => e.key === activeKey))) open.add("Recently ended");
    if (activeThreadId !== null && tab.threads.some((e) => e.rootThreadId === activeThreadId || subtreeHas(e.children, activeThreadId))) open.add("Threads");
    if (tab.monitors.some((e) => (activeKey !== null && e.bindingKey === activeKey) || (activeThreadId !== null && (e.rootThreadId === activeThreadId || subtreeHas(e.children, activeThreadId))))) open.add("Monitors");
  }
  return open;
}

/**
 * The sidebar thread list (BB-44), mounted by the host in the
 * `experimental_threadList` slot. It follows the thread route through its
 * `activeThreadId` and `activeProjectId` props, and the Stewards page through
 * the board-route store (BB-94): while that panel is mounted the store names
 * the project and effort its path shows, and a project pick moves the page.
 */
function StewardsSidebarCore({
  activeProjectId,
  activeThreadId,
  onNavigate,
  onNewThread,
}: {
  activeProjectId: string | null;
  activeThreadId: string | null;
  onNavigate: () => void;
  onNewThread: (projectId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { status, threads, projects } = experimental_useSidebarThreads();
  // The Stewards page's route, when that panel is mounted (BB-94). It is null
  // on a thread route, where the props above are the source.
  const boardRoute = useBoardRoute();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [picked, setPicked] = useState<string | null>(null);
  // The project the route names: the Stewards page's path, else the thread
  // route's own prop. Null on Settings, the home page and other plugin panels.
  const routeProject = boardRoute.projectId ?? activeProjectId;
  // The last project the sidebar showed, so a route that names none — archiving
  // a thread, Settings, the home page — leaves the list on it instead of
  // letting the server fall back to the first project (BB-117). Written during
  // render like `previousTabs`; a pick sets it too, so a home-page pick outlives
  // the route change that clears `picked`.
  const lastProject = useRef<string | null>(null);
  if (routeProject !== null) lastProject.current = routeProject;
  // A board pick whose remembered effort key cannot be checked yet: it waits
  // for the picked project's sidebar data, then navigates (BB-113).
  const pendingBoardPick = useRef<{ projectId: string; key: string } | null>(null);
  // The active tab follows the panel route, then the thread route; a pick only
  // lasts until one of them moves. `lastProject` above is what survives the
  // move, so a pick on a route that names no project does not vanish.
  useEffect(() => {
    setPicked(null);
    pendingBoardPick.current = null;
  }, [activeProjectId, boardRoute.projectId]);
  // Remember the last project-scoped place, per project, so a pick can return
  // to it (BB-113). The board route wins while the Stewards page is mounted;
  // otherwise the thread route's own props. Settings, the home page and other
  // plugin panels have neither, so they record nothing.
  useEffect(() => {
    if (boardRoute.projectId !== null) {
      writeLastPlace(pluginId, boardRoute.projectId, { kind: "board", key: boardRoute.key });
      return;
    }
    if (activeThreadId !== null && activeProjectId !== null) {
      writeLastPlace(pluginId, activeProjectId, { kind: "thread", threadId: activeThreadId });
    }
  }, [pluginId, boardRoute.projectId, boardRoute.key, activeThreadId, activeProjectId]);
  // The one project the RPC is asked for; null lets the server pick the first
  // by name. `load` depends on it, so a pick refetches like the board's `wanted`.
  // A route that names a project wins over the remembered one, and a pick wins
  // until the next route change (BB-117).
  const wanted = picked ?? routeProject ?? lastProject.current;
  const { data, error, loaded, refetch } = usePolled(useCallback(() => rpc.call("stewardsSidebar", { projectId: wanted }), [rpc, wanted]));
  // Finish a board pick whose remembered effort key still has to be checked:
  // once the picked project's list has loaded, go to the effort if it is still
  // there and to the project page otherwise (BB-113).
  useEffect(() => {
    const pending = pendingBoardPick.current;
    if (pending === null || data === null || data.projectId !== pending.projectId) return;
    pendingBoardPick.current = null;
    navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(pending.projectId, effortListed(data, pending.key) ? pending.key : undefined) });
  }, [data, navigate, picked]);
  // The previous tabs, so `buildSidebar` can hand back the same effort and
  // thread objects for unchanged rows and the memoised rows skip a render
  // (BB-95). The ref is written during render; the call is idempotent.
  const previousTabs = useRef<readonly SidebarTab[]>([]);
  const tabs = useMemo(() => {
    // The RPC carries one project's data; that tab is the only one whose rows
    // render, so the others are built from the live threads alone (BB-100).
    const projectData =
      data === null || data.projectId === null
        ? []
        : [
            {
              projectId: data.projectId,
              name: data.projects.find((p) => p.projectId === data.projectId)?.name ?? data.projectId,
              projectStewardThreadId: data.projectStewardThreadId,
              bindings: data.bindings,
              ended: data.ended,
            },
          ];
    const next = buildSidebar({ projects, threads, data: projectData, now: Date.now() }, previousTabs.current);
    previousTabs.current = next;
    return next;
  }, [projects, threads, data]);
  // The picker's count is the server's needs-you binding count, so the pill and
  // the yellow rows cannot disagree (BB-100).
  const counts = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.projectId, p.needsCount] as const)), [data]);
  const active = tabs.find((t) => t.projectId === wanted) ?? tabs.find((t) => t.projectId === data?.projectId) ?? tabs[0] ?? null;
  // A steward's visible change updates the badge and block within seconds; the
  // half-minute poll stays the fallback. Only a signal that names the shown
  // project triggers a refetch, not one for another listed project (BB-100).
  const shownProjectId = active?.projectId ?? data?.projectId ?? wanted;
  useRealtime(
    PROJECT_CHANGED,
    useCallback(
      (payload) => {
        const projectId = payload === null || typeof payload !== "object" ? null : (payload as { projectId?: unknown }).projectId;
        if (typeof projectId === "string" && projectId === shownProjectId) refetch();
      },
      [shownProjectId, refetch],
    ),
  );
  const byId = useMemo(() => new Map(threads.map((t) => [t.id, t] as const)), [threads]);
  // `byId` is a new Map on every host tick, so `pick` reads it through a ref:
  // a new callback each tick would defeat `ProjectTabs`' memo (BB-95).
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  // The requested project's needs items, only while the data matches the tab on
  // screen; a stale answer for a previous project shows nothing (BB-100).
  const needItems = active !== null && data?.projectId === active.projectId ? data.needs.items : EMPTY_NEEDS;
  const now = Date.now();
  const activeKey = boardRoute.key;
  const openThreads = useMemo(() => revealThreads(tabs, activeThreadId), [tabs, activeThreadId]);
  const openSections = useMemo(() => revealSections(tabs, activeThreadId, activeKey), [tabs, activeThreadId, activeKey]);
  // The picker switches the list and, on a project-scoped route, moves the main
  // pane back to that project's last place (BB-113): its remembered thread when
  // that still exists in the project, else its Stewards page (the remembered
  // effort when it is still listed). It never calls `onNavigate`, so a phone's
  // drawer stays open. Stable, so `ProjectTabs` can be memoised (BB-95).
  const pick = useCallback(
    (projectId: string) => {
      // Picking the project already shown does nothing.
      if (projectId === active?.projectId) return;
      setPicked(projectId);
      // Remember it past the route change that clears `picked`, so a pick on
      // the home page or Settings lasts (BB-117).
      lastProject.current = projectId;
      pendingBoardPick.current = null;
      // Settings, the home page and other plugin panels are not project-scoped:
      // there a pick only switches the list, as before (BB-113).
      if (boardRoute.projectId === null && activeThreadId === null) return;
      const place = readLastPlace(pluginId, projectId);
      if (place !== null && place.kind === "thread") {
        const thread = byIdRef.current.get(place.threadId);
        if (thread !== undefined && !thread.isArchived && thread.projectId === projectId) {
          navigate.toThread(place.threadId);
          return;
        }
        navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(projectId) });
        return;
      }
      if (place !== null && place.kind === "board" && place.key !== null) {
        // The effort is only kept when the picked project's list still has it.
        // That list is not loaded yet, so wait for it rather than guess.
        pendingBoardPick.current = { projectId, key: place.key };
        return;
      }
      navigate.toPluginPanel(BOARD_PATH, { subPath: boardSubPath(projectId) });
    },
    [active?.projectId, boardRoute.projectId, activeThreadId, navigate, pluginId],
  );
  const newThread = useCallback(() => {
    if (active !== null) onNewThread(active.projectId);
  }, [active, onNewThread]);
  const rows = (list: readonly SidebarEffort[]) =>
    list.map((e) => (
      <SidebarEffortRow
        key={e.key}
        effort={e}
        needs={needItems}
        byId={byId}
        projectId={active!.projectId}
        activeKey={activeKey}
        activeThreadId={activeThreadId}
        openThreads={openThreads}
        unreadKey={unreadKey(e.children, byId)}
        onNavigate={onNavigate}
        onChanged={refetch}
        entered={loaded}
      />
    ));
  return (
    <div className="flex h-full flex-col text-sm">
      <ProjectTabs
        tabs={tabs}
        counts={counts}
        activeId={active?.projectId ?? null}
        onPick={pick}
        onNewThread={newThread}
      />
      {status === "loading" && data === null ? (
        <p className="p-3 text-muted-foreground">Loading…</p>
      ) : active === null ? (
        <p className="p-3 text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
          {data !== null && data.roleProblem !== null ? (
            <p className="rounded-md border border-border bg-state-hover px-2 py-1 text-xs text-attention">{data.roleProblem}</p>
          ) : null}
          {active.blocked.length > 0 ? (
            <SidebarSection title="Blocked" count={active.blocked.length}>
              <ul className="flex flex-col">{rows(active.blocked)}</ul>
            </SidebarSection>
          ) : null}
          <SidebarSection title="In flight" count={active.efforts.length}>
            {active.efforts.length === 0 ? (
              <p className="px-2 py-1 text-muted-foreground">Nothing in flight.</p>
            ) : (
              <ul className="flex flex-col">{rows(active.efforts)}</ul>
            )}
          </SidebarSection>
          {active.threads.length > 0 ? (
            <SidebarCollapsible title="Threads" count={active.threads.length} revealed={openSections.has("Threads")} unread={sectionHasUnread(active.threads, byId)}>
              <ul className="flex flex-col">
                {active.threads.map((e) => {
                  const t = byId.get(e.rootThreadId);
                  return t === undefined ? null : (
                    <SidebarThreadRow key={e.key} thread={t} role="thread" children={e.children} depth={0} byId={byId} onNavigate={onNavigate} glyph={oneOffGlyph(t)} activeThreadId={activeThreadId} openThreads={openThreads} unreadKey={unreadKey(e.children, byId)} entered={loaded} />
                  );
                })}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.monitors.length > 0 ? (
            <SidebarCollapsible title="Monitors" count={active.monitors.length} revealed={openSections.has("Monitors")} unread={sectionHasUnread(active.monitors, byId)}>
              <ul className="flex flex-col">{rows(active.monitors)}</ul>
            </SidebarCollapsible>
          ) : null}
          {active.ended.length > 0 ? (
            <SidebarCollapsible title="Recently ended" count={active.ended.length} revealed={openSections.has("Recently ended")} unread={sectionHasUnread(active.ended, byId)}>
              <ul className="flex flex-col">
                {active.ended.map((e) => (
                  <SidebarEffortRow
                    key={`${e.key}-${e.endedAt}`}
                    effort={e}
                    needs={needItems}
                    byId={byId}
                    projectId={active.projectId}
                    activeKey={activeKey}
                    activeThreadId={activeThreadId}
                    openThreads={openThreads}
                    unreadKey={unreadKey(e.children, byId)}
                    onNavigate={onNavigate}
                    onChanged={refetch}
                    trailing={<span className="shrink-0 text-[11px] text-muted-foreground">{ago(e.endedAt, now)}</span>}
                    entered={loaded}
                  />
                ))}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.projectStewardThreadId !== null && byId.has(active.projectStewardThreadId) ? (
            <div className="mt-auto border-t border-border pt-1">
              <SidebarThreadRow
                thread={byId.get(active.projectStewardThreadId)!}
                role="thread"
                children={NO_CHILDREN}
                depth={0}
                byId={byId}
                onNavigate={onNavigate}
                glyph="quiet"
                activeThreadId={activeThreadId}
                openThreads={openThreads}
                unreadKey=""
                entered={loaded}
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

/** The opt-in sidebar thread list (BB-44): the shared list with the route's active thread. */
function StewardsSidebar({ activeProjectId, activeThreadId, onNavigate }: PluginThreadListProps) {
  const navigate = useBbNavigate();
  return (
    <StewardsSidebarCore
      activeProjectId={activeProjectId}
      activeThreadId={activeThreadId}
      onNavigate={onNavigate}
      onNewThread={(projectId) => {
        navigate.toCompose({ projectId, focusPrompt: true });
        onNavigate();
      }}
    />
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
