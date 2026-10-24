// Two surfaces. The Stewards page (a nav panel, one tab per stewarded
// project): what waits on you, what is in flight by stage, what is stuck or
// held, what ended lately, and the latest digest; the one write is closing a
// question put to you. Settings → Plugins → Stewards: which projects are
// stewarded and whether their configuration is healthy, then every open
// steward and where it stands. Steering stays with the project steward and
// the CLI.
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
import { buildSidebar, isBusy, type SidebarChild, type SidebarChildRole, type SidebarEffort } from "./sidebar.js";
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

/** The count of everything waiting on the user for one project; rendered only when non-zero. */
function NeedsBadge({ count }: { count: number }) {
  return (
    <span aria-label={`${count} waiting on you`} className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive/10 px-1 text-[10px] font-medium leading-4 text-destructive">
      {count}
    </span>
  );
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
  const navigate = useBbNavigate();
  const mine = s.escalations.filter((x) => x.route === "me");
  return (
    <li className="flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {s.url === null ? (
          <span className="font-medium">{s.key}</span>
        ) : (
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => navigate.openUrl(s.url!)}>
            {s.key}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.title}</span>
        <Badge>{s.kind}</Badge>
        {s.phase !== null ? <Badge>{s.phase}</Badge> : null}
        {s.priority !== null && s.priority !== "normal" ? <Badge tone={s.priority === "urgent" ? "bad" : "muted"}>{s.priority}</Badge> : null}
        {s.ending !== null ? <Badge tone="warn">{s.ending === "detach" ? "detaching" : "wrapping up"}</Badge> : null}
        {s.escalations.length > 0 ? <Badge tone={mine.length > 0 ? "bad" : "warn"}>{s.escalations.length === 1 ? "1 escalation" : `${s.escalations.length} escalations`}</Badge> : null}
      </div>
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

/** The stage groups, in the playbook schema's order (from the server), then any other stage seen, then none. */
function stageGroups(stages: string[], seen: Array<string | null>): Array<{ stage: string | null; title: string }> {
  const order = [...stages, ...seen.filter((s): s is string => s !== null && !stages.includes(s))];
  const groups: Array<{ stage: string | null; title: string }> = [...new Set(order)].map((stage) => ({ stage, title: stage.charAt(0).toUpperCase() + stage.slice(1) }));
  return [...groups, { stage: null, title: "No stage" }];
}

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

function ProjectBoard({ board: b, refetch }: { board: Board; refetch: () => void }) {
  const now = Date.now();
  // An escalation a need answers is shown as that need's row, not as the raw
  // escalation: a forwarded approval is answered with Approve/Decline, not by
  // "approve or decline in its steward's thread".
  const covered = new Set(b.needs.map((n) => n.escalationId).filter((id): id is string => id !== null));
  const withUser = b.withUser.filter((x) => !covered.has(x.id));
  const waiting = b.questions.length + withUser.length + b.needs.length;
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

      <Section title="Waiting on you" count={waiting}>
        {waiting === 0 ? (
          <None>Nothing is waiting on you.</None>
        ) : (
          <List>
            {b.questions.map((q) => (
              <QuestionRow key={q.id} question={q} now={now} onClosed={refetch} />
            ))}
            {withUser.map((x) => (
              <li key={x.id} className="flex flex-col gap-1 p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <EntityLink entityKey={x.key} url={x.url} />
                  <Badge tone="bad">{x.kind === "approval" ? "approval request" : `${x.kind} escalation`}</Badge>
                  <span className="text-xs text-muted-foreground">{ago(x.createdAt, now)}</span>
                </p>
                <p>{x.question}</p>
                {x.recommendation !== null ? <p className="text-muted-foreground">Recommendation: {x.recommendation}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {x.kind === "approval" ? "Approve or decline in its steward's thread." : "The project steward has not said how to ask you this yet."}
                  {x.kind === "approval" && x.threadId !== null ? (
                    <>
                      {" "}
                      <ThreadLink threadId={x.threadId}>Open steward</ThreadLink>
                    </>
                  ) : null}
                  {x.kind !== "approval" && b.projectStewardThreadId !== null ? (
                    <>
                      {" "}
                      <ThreadLink threadId={b.projectStewardThreadId}>Open the project steward</ThreadLink>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
            {b.needs.map((n) => (
              <NeedRow key={n.id} need={n} now={now} onDone={refetch} />
            ))}
          </List>
        )}
      </Section>

      <Section title="Lessons" count={b.lessons.length}>
        {b.lessons.length === 0 ? (
          <None>No lessons are waiting to be landed.</None>
        ) : (
          <List>
            {b.lessons.map((l) => (
              <li key={l.id} className="flex flex-col gap-1 p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={l.scope === "boundary" ? "bad" : "muted"}>{l.scope}</Badge>
                  <span className="font-medium">{l.file}</span>
                  {l.key !== null ? <EntityLink entityKey={l.key} url={null} /> : null}
                  <span className="text-xs text-muted-foreground">{ago(l.createdAt, now)}</span>
                </p>
                <p>{l.text}</p>
                <p className="text-xs text-muted-foreground">
                  {l.scope === "boundary" ? "Waiting on your Merge or Drop above." : "The project steward applies, commits and self-merges this."}
                  {l.note !== null ? ` Last attempt: ${l.note}` : ""}
                </p>
              </li>
            ))}
          </List>
        )}
      </Section>

      <Section title="In flight" count={b.stewards.length}>
        {b.stewards.length === 0 ? (
          <None>No open stewards. Label a Linear ticket or pull request to adopt it.</None>
        ) : (
          stageGroups(b.stages, b.stewards.map((s) => s.stage)).map(({ stage, title }) => {
            const rows = b.stewards.filter((s) => (s.stage ?? null) === stage);
            if (rows.length === 0) return null;
            return (
              <div key={title} className="flex flex-col gap-1">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {title} · {rows.length}
                </h3>
                <List>
                  {rows.map((s) => (
                    <InFlightRow key={s.key} steward={s} now={now} />
                  ))}
                </List>
              </div>
            );
          })
        )}
      </Section>

      <Section title="Stuck or held" count={b.stuck.length}>
        {b.stuck.length === 0 ? (
          <None>Nothing is stuck or held.</None>
        ) : (
          <List>
            {b.stuck.map((x, i) => (
              <li key={`${x.key}-${i}`} className="flex flex-col gap-1 p-3">
                <p className="flex flex-wrap items-center gap-2">
                  <EntityLink entityKey={x.key} url={x.url} />
                  {x.since !== null ? <span className="text-xs text-muted-foreground">{ago(x.since, now)}</span> : null}
                </p>
                <p className="text-amber-600 dark:text-amber-500">{x.why}</p>
                {x.threadId !== null ? (
                  <p className="text-xs text-muted-foreground">
                    <ThreadLink threadId={x.threadId}>Open steward</ThreadLink>
                  </p>
                ) : null}
              </li>
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
    </>
  );
}

/**
 * One "needs you" item with its buttons. A button is offered only when the
 * server can verify the item's preconditions now; otherwise the item says why
 * it is not actionable yet. Every action runs on the server, as the user.
 */
function NeedRow({ need: n, now, onDone }: { need: Board["needs"][number]; now: number; onDone: () => void }) {
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
    <li className="flex flex-col gap-2 p-3">
      <p className="flex flex-wrap items-center gap-2">
        <EntityLink entityKey={n.key} url={n.entityUrl ?? n.url} />
        <Badge tone="bad">{n.kind}</Badge>
        <span className="text-xs text-muted-foreground">asked {ago(n.createdAt, now)}</span>
      </p>
      <p>{n.what}</p>
      {n.kind === "provide-secret" ? <p className="text-xs text-muted-foreground">The form opens in a thread; the value goes to {n.destination ?? "the destination the item names"}.</p> : null}
      {n.how !== null ? <div className="text-muted-foreground"><Markdown content={n.how} /></div> : null}
      {!n.actionable ? <p className="text-xs text-amber-600 dark:text-amber-500">Not actionable yet: {n.why ?? "the server cannot verify it now"}.</p> : null}
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
    </li>
  );
}

function QuestionRow({ question: q, now, onClosed }: { question: Board["questions"][number]; now: number; onClosed: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [answer, setAnswer] = useState("");
  // With choices, the text box is the choice's note until Other… turns it
  // into the free-text answer.
  const [other, setOther] = useState(false);
  const [state, setState] = useState<"idle" | "closing" | { error: string }>("idle");
  const close = (choice?: string) => {
    setState("closing");
    rpc.call("stewardsAnswerQuestion", { questionId: q.id, answer: answer.trim() === "" ? null : answer.trim(), ...(choice === undefined ? {} : { choice }) }).then(
      (r) => {
        if (r.ok) onClosed();
        else setState({ error: r.message });
      },
      (e: unknown) => setState({ error: message(e) }),
    );
  };
  const button = "rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50";
  return (
    <li className="flex flex-col gap-2 p-3">
      <p className="flex flex-wrap items-center gap-2">
        {q.key !== null ? <EntityLink entityKey={q.key} url={q.url} /> : null}
        <Badge tone="bad">{q.escalationId === null ? "question" : "forwarded escalation"}</Badge>
        <span className="text-xs text-muted-foreground">asked {ago(q.createdAt, now)}</span>
      </p>
      <p>{q.question}</p>
      {q.context !== null ? <p className="text-muted-foreground">{q.context}</p> : null}
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
    </li>
  );
}

function InFlightRow({ steward: s, now }: { steward: Board["stewards"][number]; now: number }) {
  return (
    <li className="flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <EntityLink entityKey={s.key} url={s.url} />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.title}</span>
        <Badge>{s.kind}</Badge>
        {s.phase !== null ? <Badge>{s.phase}</Badge> : null}
        {s.priority !== null && s.priority !== "normal" ? <Badge tone={s.priority === "urgent" ? "bad" : "muted"}>{s.priority}</Badge> : null}
        {s.ending !== null ? <Badge tone="warn">{s.ending === "detach" ? "detaching" : "wrapping up"}</Badge> : null}
      </div>
      {s.summary === null ? (
        <p className="text-muted-foreground">No status report yet.</p>
      ) : (
        <p>
          {s.summary}{" "}
          <span className="text-muted-foreground">
            Next: {s.nextAction}
            {s.actor === null ? "" : ` (${ACTOR_LABEL[s.actor] ?? s.actor})`}
          </span>
        </p>
      )}
      {s.blockedOn !== null ? <p className="text-muted-foreground">Blocked on {s.blockedOn}</p> : null}
      <p className="text-xs text-muted-foreground">
        Moved {ago(s.advancedAt, now)}
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
    </li>
  );
}

// ---- The sidebar thread list -------------------------------------------------------------------
//
// The opt-in replacement for bb's sidebar list, registered through the
// exclusive `experimental_threadList` slot. One project dropdown, in-flight
// efforts grouped by the steward relationship, collapsed Watches and Recently
// ended rows, and a demoted project-steward row. Every row carries bb's own
// thread actions context menu, so nothing bb's rows can do is lost.

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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the title names the key as a whole token, so `#612` is not swallowed by `#6123`. */
function titleNamesKey(title: string, key: string): boolean {
  return new RegExp(`${escapeRegExp(key)}(?!\\d)`).test(title);
}

/** One thread row: bb's glyph, title and context menu, expanding into its children. */
function SidebarThreadRow({
  thread,
  role,
  children,
  depth,
  byId,
  onNavigate,
  meta,
  titleAttr,
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
}) {
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const draft = useSidebarThreadDraft(thread.id);
  const [open, setOpen] = useState(false);
  // The array-wide indicator never reports a draft; the row folds in the
  // client-local one, as bb's own row does.
  const indicator = draft.hasUnsubmittedDraft && thread.indicator === "none" ? (isBusy(thread.status) ? "working-draft" : "draft") : thread.indicator;
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
              className="flex shrink-0 items-center text-muted-foreground"
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <ThreadStatusGlyph indicator={indicator} rowStatus={rowStatus} size="compact" />
          <a
            href={thread.href}
            className="min-w-0 flex-1 truncate text-sm"
            onClick={(e) => {
              e.preventDefault();
              navigate.toThread(thread.id);
              onNavigate();
            }}
          >
            <ThreadTitle threadId={thread.id} />
          </a>
          {role === "worker" || role === "reviewer" ? (
            <span className="shrink-0 rounded bg-state-hover px-1 text-[9px] font-semibold uppercase leading-4 text-muted-foreground" title={role}>
              {role === "worker" ? "W" : "R"}
            </span>
          ) : null}
          {meta}
        </div>
      </ThreadActionsContextMenu>
      {open && children.length > 0 ? (
        <ul className="flex flex-col">
          {children.map((c) => {
            const child = byId.get(c.threadId);
            return child === undefined ? null : (
              <SidebarThreadRow key={c.threadId} thread={child} role={c.role} children={c.children} depth={depth + 1} byId={byId} onNavigate={onNavigate} />
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** One effort's root row, title-first: the shortened key only when the title omits it, and the held/blocked badges. */
function SidebarEffortRow({ effort, byId, onNavigate }: { effort: SidebarEffort; byId: ReadonlyMap<string, PluginSidebarThread>; onNavigate: () => void }) {
  const root = byId.get(effort.rootThreadId);
  if (root === undefined) return null;
  const key = effort.bindingKey;
  const displayKey = key === null ? null : shortBindingKey(key);
  // The title wins: a steward is titled after its binding, so showing the key again is noise.
  const keyInTitle = key !== null && displayKey !== null && (titleNamesKey(root.displayTitle, key) || titleNamesKey(root.displayTitle, displayKey));
  const showKey = displayKey !== null && !keyInTitle;
  const badges = effort.hold !== null || effort.blockedOn !== null;
  const meta =
    !showKey && !badges ? null : (
      <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground">
        {showKey ? <span className="min-w-0 truncate font-medium">{displayKey}</span> : null}
        {effort.hold !== null ? <Badge tone="warn">held</Badge> : null}
        {effort.blockedOn !== null ? <Badge tone="bad">blocked</Badge> : null}
      </span>
    );
  return <SidebarThreadRow thread={root} role="thread" children={effort.children} depth={0} byId={byId} onNavigate={onNavigate} meta={meta} titleAttr={key ?? undefined} />;
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
 * The project dropdown, always a native `<select>`: the per-project needs count
 * in each option and the summed `NeedsBadge` beside it. The plus button opens
 * the composer on the dropdown's project — the host's own New thread button
 * cannot be retargeted from a thread list — then closes the mobile drawer.
 */
function ProjectTabs({ tabs, counts, activeId, onPick, onNewThread }: { tabs: Array<{ projectId: string; name: string }>; counts: ReadonlyMap<string, number>; activeId: string | null; onPick: (projectId: string) => void; onNewThread: () => void }) {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return (
    <div className="flex items-center gap-1 px-1 py-1">
      <select
        aria-label="Project"
        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
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
      {total > 0 ? <NeedsBadge count={total} /> : null}
      <button
        type="button"
        aria-label="New thread"
        title="New thread"
        className="shrink-0 rounded-md border border-input p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
        onClick={onNewThread}
      >
        <Icon name="Plus" className="size-4" />
      </button>
    </div>
  );
}

/**
 * One item in the sidebar's "Needs you" block: the key, one line of text, and
 * the fixed choices as buttons. A choice writes through the page's own RPC; a
 * row without choices (or a provide-secret item) opens the board, where the
 * free-text answer or the secret form lives.
 */
function SidebarNeedRow({ item, onChanged, onOpenBoard }: { item: SidebarNeedItem; onChanged: () => void; onOpenBoard: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  // Choices are a decide item's or a question's; every other item opens the page.
  const choices = item.type === "question" ? item.choices : item.type === "need" && item.kind === "decide" ? item.choices : [];
  const text = item.type === "need" ? item.what : item.question;
  const entityUrl = item.type === "need" ? item.entityUrl : item.url;
  const choose = (choice: string) => {
    setState("running");
    const call =
      item.type === "question"
        ? rpc.call("stewardsAnswerQuestion", { questionId: item.id, answer: null, choice })
        : rpc.call("stewardsNeedAction", { needId: item.id, action: "choose", note: null, choice });
    call.then(
      (r) => {
        if (!r.ok) return setState({ error: r.message });
        onChanged();
      },
      (e: unknown) => setState({ error: message(e) }),
    );
  };
  return (
    <li className="flex flex-col gap-1 px-2 py-1.5">
      <p className="flex flex-wrap items-center gap-2">
        {item.key !== null ? <EntityLink entityKey={item.key} url={entityUrl} /> : null}
        {item.type === "withUser" ? <Badge tone="bad">{item.kind === "approval" ? "approval request" : `${item.kind} escalation`}</Badge> : null}
        {item.type === "need" ? <Badge tone="bad">{item.kind}</Badge> : null}
      </p>
      <p className="min-w-0 truncate">{text}</p>
      <div className="flex flex-wrap items-center gap-1">
        {choices.length > 0 ? (
          choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={state === "running"}
              className="rounded-md border border-input px-2 py-0.5 text-[11px] hover:bg-state-hover disabled:opacity-50"
              onClick={() => choose(choice)}
            >
              {choice}
            </button>
          ))
        ) : (
          <button type="button" className="rounded-md border border-input px-2 py-0.5 text-[11px] hover:bg-state-hover" onClick={onOpenBoard}>
            Open
          </button>
        )}
        {typeof state === "object" ? <span className="text-destructive">{state.error}</span> : null}
      </div>
    </li>
  );
}

/** The sidebar's "Needs you" block: the board's waiting items, above In flight. */
function SidebarNeedsSection({ projectId, needs, onChanged }: { projectId: string; needs: SidebarNeeds; onChanged: () => void }) {
  const navigate = useBbNavigate();
  return (
    <SidebarSection title="Needs you" count={needs.count}>
      {needs.items.length === 0 ? (
        <p className="px-2 py-1 text-muted-foreground">Nothing is waiting on you.</p>
      ) : (
        <ul className="flex flex-col">
          {needs.items.map((item) => (
            <SidebarNeedRow key={`${item.type}:${item.id}`} item={item} onChanged={onChanged} onOpenBoard={() => navigate.toPluginPanel(BOARD_PATH, { subPath: encodeURIComponent(projectId) })} />
          ))}
        </ul>
      )}
    </SidebarSection>
  );
}

function StewardsSidebar({ activeProjectId, onNavigate }: PluginThreadListProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { status, threads, projects } = experimental_useSidebarThreads();
  const { data, error, refetch } = usePolled(useCallback(() => rpc.call("stewardsSidebar", null), [rpc]));
  const tabs = useMemo(() => buildSidebar({ projects, threads, data: data?.projects ?? [] }), [projects, threads, data]);
  const needsByProject = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.projectId, p.needs] as const)), [data]);
  const counts = useMemo(() => new Map(tabs.map((t) => [t.projectId, needsByProject.get(t.projectId)?.count ?? 0] as const)), [tabs, needsByProject]);
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
  return (
    <div className="flex h-full flex-col text-sm">
      <ProjectTabs tabs={tabs} counts={counts} activeId={active?.projectId ?? null} onPick={setPicked} onNewThread={openNewThread} />
      {status === "loading" && data === null ? (
        <p className="p-3 text-muted-foreground">Loading…</p>
      ) : active === null ? (
        <p className="p-3 text-muted-foreground">No projects yet.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
          {activeNeeds !== undefined ? <SidebarNeedsSection projectId={active.projectId} needs={activeNeeds} onChanged={refetch} /> : null}
          <SidebarSection title="In flight" count={active.efforts.length}>
            {active.efforts.length === 0 ? (
              <p className="px-2 py-1 text-muted-foreground">Nothing in flight.</p>
            ) : (
              <ul className="flex flex-col">
                {active.efforts.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} byId={byId} onNavigate={onNavigate} />
                ))}
              </ul>
            )}
          </SidebarSection>
          {active.threads.length > 0 ? (
            <SidebarCollapsible title="Threads" count={active.threads.length}>
              <ul className="flex flex-col">
                {active.threads.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} byId={byId} onNavigate={onNavigate} />
                ))}
              </ul>
            </SidebarCollapsible>
          ) : null}
          {active.watches.length > 0 ? (
            <SidebarCollapsible title="Watches" count={active.watches.length}>
              <ul className="flex flex-col">
                {active.watches.map((e) => (
                  <SidebarEffortRow key={e.key} effort={e} byId={byId} onNavigate={onNavigate} />
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
