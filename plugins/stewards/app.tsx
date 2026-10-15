// Settings → Plugins → Stewards: which projects are stewarded and whether
// their configuration is healthy, then every open steward and where it
// stands. Read-only; steering stays with the project steward and the CLI.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Client = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = Awaited<ReturnType<Client["call"]>> extends infer R ? Extract<R, { projects: unknown }> : never;
type Project = Overview["projects"][number];
type Steward = Project["stewards"][number];
type CheckResult = { ok: boolean; lines: string[] };

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

/** The overview, refetched every half minute while the page is visible. */
function useOverview(): { overview: Overview | null; error: string | null } {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const refetch = useCallback(() => {
    rpc.call("stewardsOverview", null).then(
      (o) => {
        if (!mounted.current) return;
        setOverview(o);
        setError(null);
      },
      (e: unknown) => {
        if (mounted.current) setError(message(e));
      },
    );
  }, [rpc]);
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
  return { overview, error };
}

function Loading({ error }: { error: string | null }) {
  return <p className="text-sm text-muted-foreground">{error === null ? "Loading…" : <span className="text-destructive">{error}</span>}</p>;
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

export default definePluginApp((app) => {
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
