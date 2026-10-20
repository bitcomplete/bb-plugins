// Two surfaces. The Stewards page (a nav panel, one tab per stewarded
// project): what waits on you, what is in flight by stage, what is stuck or
// held, what ended lately, and the latest digest; the one write is closing a
// question put to you. Settings → Plugins → Stewards: which projects are
// stewarded and whether their configuration is healthy, then every open
// steward and where it stands. Steering stays with the project steward and
// the CLI.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, definePluginApp, experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Client = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { projects: unknown; lastSweepAt: unknown }> : never;
type Project = Overview["projects"][number];
type Steward = Project["stewards"][number];
type BoardResult = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { board: unknown }> : never;
type Board = NonNullable<BoardResult["board"]>;
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
                  {x.kind === "approval" ? "Approve or decline in its steward's thread." : "Answer in the project steward's thread."}
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
  const [state, setState] = useState<"idle" | "running" | { error: string }>("idle");
  const act = (action: "approve" | "decline" | "done" | "merge" | "provide") => {
    setState("running");
    rpc.call("stewardsNeedAction", { needId: n.id, action, note: note.trim() === "" ? null : note.trim() }).then(
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
  return (
    <li className="flex flex-col gap-2 p-3">
      <p className="flex flex-wrap items-center gap-2">
        <EntityLink entityKey={n.key} url={n.url} />
        <Badge tone="bad">{n.kind}</Badge>
        <span className="text-xs text-muted-foreground">asked {ago(n.createdAt, now)}</span>
      </p>
      <p>{n.what}</p>
      {n.how !== null ? <div className="text-muted-foreground"><Markdown content={n.how} /></div> : null}
      {!n.actionable ? <p className="text-xs text-amber-600 dark:text-amber-500">Not actionable yet: {n.why ?? "the server cannot verify it now"}.</p> : null}
      {takesNote ? (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={1}
          placeholder={n.kind === "approve-spec" ? "Note (optional)" : n.kind === "decide" ? "Your answer (optional, saved as guidance)" : "Note (optional, saved as guidance)"}
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
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("provide")}>
            Provide
          </button>
        ) : (
          <button type="button" disabled={!n.actionable || state === "running"} className={primary} onClick={() => act("done")}>
            Done
          </button>
        )}
        {n.threadId !== null ? <ThreadLink threadId={n.threadId}>Open the worker</ThreadLink> : null}
        {typeof state === "object" ? <span className="text-destructive">{state.error}</span> : null}
      </div>
    </li>
  );
}

function QuestionRow({ question: q, now, onClosed }: { question: Board["questions"][number]; now: number; onClosed: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<"idle" | "closing" | { error: string }>("idle");
  const close = () => {
    setState("closing");
    rpc.call("stewardsAnswerQuestion", { questionId: q.id, answer: answer.trim() === "" ? null : answer.trim() }).then(
      (r) => {
        if (r.ok) onClosed();
        else setState({ error: r.message });
      },
      (e: unknown) => setState({ error: message(e) }),
    );
  };
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
          placeholder="Your answer (optional)"
          aria-label={`Answer to: ${q.question}`}
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1"
        />
        <button type="button" disabled={state === "closing"} className="rounded-md border border-input px-3 py-1 text-xs hover:bg-state-hover disabled:opacity-50" onClick={close}>
          {state === "closing" ? "Closing…" : answer.trim() === "" ? "Close" : "Answer and close"}
        </button>
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

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Stewards",
    icon: "ShieldCheck",
    path: BOARD_PATH,
    component: BoardPage,
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
