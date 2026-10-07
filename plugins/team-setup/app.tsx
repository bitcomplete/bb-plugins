// The checklist, on the home page until every step is done and always under
// Settings → Plugins → Team setup. Each row reads one step's state from the
// server and starts that step's flow; the plugins that own the steps finish
// them.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { browserDeps, createUpdateStore, type UpdateStore } from "./server-update";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type Status = Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>> extends infer R
  ? Extract<R, { steps: unknown }>
  : never;
type StepState = Status["steps"]["ai"];

const IDLE_POLL_MS = 10_000;
const PENDING_POLL_MS = 3_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Polls while the page is visible and `active`; refetches when it comes back into view. */
function useVisiblePolling(refetch: () => void, active: boolean, intervalMs: number) {
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const start = () => {
      if (timer === null) timer = window.setInterval(refetch, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refetch();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch, active, intervalMs]);
}

function StepMark({ state }: { state: StepState }) {
  const name = state === "done" ? "CircleCheck" : "Circle";
  const tone = state === "done" ? "text-success" : state === "todo" ? "text-muted-foreground" : "text-muted-foreground/60";
  return <Icon name={name} className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-label={state} />;
}

function Step({
  state,
  title,
  children,
  action,
}: {
  state: StepState;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <StepMark state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-4">
          <p className="font-medium">{title}</p>
          {action}
        </div>
        <div className="flex flex-col gap-2 text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="rounded-md border border-border px-2 py-1 text-base tracking-widest text-foreground">{code}</code>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function SettingsLink({ pluginId, children }: { pluginId: string; children: React.ReactNode }) {
  return (
    <a className="underline underline-offset-2" href={`/settings/plugins/${encodeURIComponent(pluginId)}`}>
      {children}
    </a>
  );
}

interface ClaudeFlow {
  sessionId: string;
  url: string;
}
interface CodexFlow {
  sessionId: string;
  url: string;
  code: string;
  expiresAt: number;
  intervalMs: number;
}

function Checklist({ compact }: { compact: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [claude, setClaude] = useState<ClaudeFlow | null>(null);
  const [pasted, setPasted] = useState("");
  const [codex, setCodex] = useState<CodexFlow | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    rpc.call("status").then(
      (s) => {
        if (!mounted.current) return;
        setStatus(s);
        setError(null);
      },
      (e: unknown) => {
        if (mounted.current) setError(message(e));
      },
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);

  const complete = status?.complete ?? false;
  const githubPending = status?.github.pending !== null && status?.github.pending !== undefined;
  useVisiblePolling(refetch, status !== null && !complete, githubPending ? PENDING_POLL_MS : IDLE_POLL_MS);

  // Codex: Account Pool holds the device-flow session; this page polls it.
  useEffect(() => {
    if (codex === null) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const r = await rpc.call("codexPoll", { sessionId: codex.sessionId });
        if (stopped) return;
        if (r.status === "complete") {
          setCodex(null);
          refetch();
        } else if (r.status === "error") {
          setCodexError(r.message);
          setCodex(null);
        }
      } catch (e) {
        if (!stopped) {
          setCodexError(message(e));
          setCodex(null);
        }
      }
    };
    const timer = window.setInterval(() => void tick(), Math.max(codex.intervalMs, 2000));
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [codex, rpc, refetch]);

  const open = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Checking…"}</p>;
  }

  const { ai, github, devbox, linear, machines, steps } = status;

  if (compact && complete) {
    const aiLabel = ai.accounts
      .filter((a) => a.enabled && ai.routing[a.provider])
      .map((a) => a.label)
      .join(", ");
    return (
      <p className="text-sm text-muted-foreground">
        All set: {aiLabel !== "" ? `${aiLabel}; ` : ""}
        {github.login !== null ? `GitHub as ${github.login}; ` : steps.github === "done" ? "GitHub; " : ""}
        {devbox.project !== null ? `devbox project ${devbox.project}; ` : steps.devbox === "done" ? "devbox; " : ""}
        {linear.user !== null ? `Linear as ${linear.user}; ` : steps.linear === "done" ? "Linear; " : ""}
        {machines.names.length === 1 ? "1 machine" : `${machines.names.length} machines`}.{" "}
        <SettingsLink pluginId="team-setup">Details</SettingsLink>
      </p>
    );
  }

  const enabledAccounts = ai.accounts.filter((a) => a.enabled);

  return (
    <div className="flex flex-col gap-4 text-sm">
      <ol className="flex flex-col gap-4">
        <Step
          state={steps.ai}
          title="Claude or Codex"
          action={
            ai.available && claude === null && codex === null ? (
              <div className="flex gap-2">
                <Button size="sm" variant={steps.ai === "done" ? "outline" : "default"} disabled={busy !== null} onClick={() => void run("claude", async () => {
                  const s = await rpc.call("claudeSignIn");
                  setPasted("");
                  setClaude(s);
                  open(s.url);
                })}>
                  Sign in to Claude
                </Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("codex", async () => {
                  setCodexError(null);
                  const s = await rpc.call("codexSignIn");
                  setCodex(s);
                })}>
                  Sign in to Codex
                </Button>
              </div>
            ) : null
          }
        >
          {!ai.available ? (
            <p>{ai.message ?? "Account Pool is unavailable."} <SettingsLink pluginId="account-pool">Account Pool settings</SettingsLink></p>
          ) : steps.ai === "done" ? (
            <p>
              Routing through {enabledAccounts.filter((a) => ai.routing[a.provider]).map((a) => a.label).join(", ")}.{" "}
              <SettingsLink pluginId="account-pool">Manage accounts</SettingsLink>
            </p>
          ) : enabledAccounts.length > 0 ? (
            <p>
              {enabledAccounts.map((a) => a.label).join(", ")} added, but routing is off for{" "}
              {enabledAccounts.map((a) => a.provider).filter((p, i, all) => all.indexOf(p) === i).join(" and ")}.{" "}
              <SettingsLink pluginId="account-pool">Turn it on in Account Pool</SettingsLink>
            </p>
          ) : (
            <p>Agents run on your own Claude or ChatGPT subscription through the Account Pool. One is enough; add both to fall back.</p>
          )}
          {claude !== null ? (
            <form
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (pasted.trim() === "") return;
                void run("claude-complete", async () => {
                  await rpc.call("claudeComplete", { sessionId: claude.sessionId, pasted: pasted.trim() });
                  setClaude(null);
                  setPasted("");
                  refetch();
                });
              }}
            >
              <p className="text-foreground">Sign in at claude.ai, then paste the code from its final page here.</p>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => open(claude.url)}>
                  Open claude.ai again
                </Button>
                <input
                  className="h-8 flex-1 rounded-md border border-border bg-transparent px-2 text-sm text-foreground"
                  aria-label="Claude authorization code"
                  placeholder="Paste code#state here"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                />
                <Button size="sm" type="submit" disabled={busy !== null || pasted.trim() === ""}>
                  Finish
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setClaude(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
          {codex !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="text-foreground">Open the verification page, sign in to ChatGPT, and enter this code.</p>
              <CodeBlock code={codex.code} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => open(codex.url)}>
                  Open verification page
                </Button>
                <span>Waiting for you to approve…</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run("codex-cancel", async () => {
                    await rpc.call("codexCancel", { sessionId: codex.sessionId });
                    setCodex(null);
                  })}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {codexError !== null ? <p className="text-destructive">{codexError}</p> : null}
        </Step>

        <Step
          state={steps.github}
          title="GitHub"
          action={
            github.pending === null && github.status !== "disabled" ? (
              github.status === "logged in" ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("github-out", async () => {
                  await rpc.call("githubSignOut");
                  refetch();
                })}>
                  Sign out
                </Button>
              ) : (
                <Button size="sm" variant={github.status === "overridden" ? "outline" : "default"} disabled={busy !== null} onClick={() => void run("github", async () => {
                  await rpc.call("githubSignIn");
                  refetch();
                })}>
                  Sign in to GitHub
                </Button>
              )
            ) : null
          }
        >
          {github.status === "logged in" ? (
            <p>
              Signed in{github.login !== null ? ` as ${github.login}` : ""}. Every machine gets this login as GH_TOKEN and a git credential helper.
              {github.orgMember === false ? (
                <span className="text-destructive"> {github.login} is not a member of {github.org}, so its repos will not be reachable. Sign out and sign in with your work account.</span>
              ) : null}
            </p>
          ) : github.status === "overridden" ? (
            <p>Using a GH_TOKEN you set by hand in Environment variables. Sign in here to stop managing the token yourself, then delete the variable.</p>
          ) : github.status === "disabled" ? (
            <p>Automatic GitHub credentials are turned off in Settings → Environment variables, so a sign-in here would reach no machine. Turn them back on first.</p>
          ) : (
            <p>Machines clone and push as you. The sign-in happens on this server, once: GitHub shows you a code, you approve it, and bb forwards the login to every machine.</p>
          )}
          {github.pending !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="text-foreground">Enter this code on GitHub.</p>
              <CodeBlock code={github.pending.code} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => open(github.pending!.url)}>
                  Open github.com/login/device
                </Button>
                <span>Waiting for you to approve…</span>
                <Button size="sm" variant="ghost" onClick={() => void run("github-cancel", async () => {
                  await rpc.call("githubCancel");
                  refetch();
                })}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {github.lastError !== null && github.pending === null ? <p className="text-destructive">{github.lastError}</p> : null}
        </Step>

        <Step
          state={steps.devbox}
          title="devbox"
          action={
            devbox.available && !devbox.connected ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void run("devbox", async () => {
                const { url } = await rpc.call("devboxConnect");
                open(url);
              })}>
                Connect devbox
              </Button>
            ) : null
          }
        >
          {!devbox.available ? (
            <p>{devbox.message ?? "devbox is unavailable."} <SettingsLink pluginId="devbox-provider">Devbox machines settings</SettingsLink></p>
          ) : devbox.connected ? (
            <p>Connected{devbox.project !== null ? ` to project ${devbox.project}` : ""}.</p>
          ) : (
            <p>Connect your devbox project so bb can create machines in it. You approve it on devbox, which sends you back here.</p>
          )}
        </Step>

        <Step
          state={steps.linear}
          title="Linear"
          action={
            linear.available && linear.configured && !linear.connected ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void run("linear", async () => {
                const { url } = await rpc.call("linearConnect");
                open(url);
              })}>
                Connect Linear
              </Button>
            ) : null
          }
        >
          {!linear.available ? (
            <p>{linear.message ?? "Linear is unavailable."} <SettingsLink pluginId="linear">Linear settings</SettingsLink></p>
          ) : !linear.configured ? (
            <p>
              No Linear OAuth client ID is set on this server, so there is nothing to connect yet.{" "}
              <SettingsLink pluginId="linear">Linear settings</SettingsLink>
            </p>
          ) : linear.connected ? (
            <p>
              Connected{linear.user !== null ? ` as ${linear.user}` : ""}{linear.organization !== null ? ` in ${linear.organization}` : ""}. Threads read and update issues as you.
            </p>
          ) : (
            <p>Connect your Linear account so threads can read and update issues as you. You approve it on Linear, which sends you back here.</p>
          )}
        </Step>

        <Step state={steps.machine} title="A machine">
          {machines.names.length > 0 ? (
            <p>
              {machines.names.join(", ")}. <SettingsLink pluginId="devbox-provider">Add another</SettingsLink>
            </p>
          ) : (
            <p>
              Agents run on machines, not on this server.{" "}
              {devbox.connected ? (
                <SettingsLink pluginId="devbox-provider">Create one in Devbox machines</SettingsLink>
              ) : (
                "Connect devbox first, then create one from Devbox machines."
              )}
            </p>
          )}
        </Step>
      </ol>
      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

// bb-gate stages a new build of this server rather than restarting it; the
// banner is how the developer finds out and picks the moment. One store for
// the page, made on first use so a bb that is not behind bb-gate never
// polls for nothing more than once.
let updateStore: UpdateStore | null = null;
function useServerUpdate(): UpdateStore {
  if (updateStore === null) updateStore = createUpdateStore(browserDeps());
  return updateStore;
}

function ServerUpdateBanner() {
  const store = useServerUpdate();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  if (state.status !== "pending" && state.status !== "restarting") return null;
  const restarting = state.status === "restarting";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={restarting ? "LoaderCircle" : "CircleArrowUp"} className={`size-4 shrink-0 ${restarting ? "animate-spin" : "text-primary"}`} />
        {restarting ? (
          <span>Restarting your server. This page reloads in a moment and comes back when it is up.</span>
        ) : (
          <span>
            A new build of your bb server is ready. Restarting takes under a minute and interrupts any running turn; if you
            never do, it restarts tonight.
          </span>
        )}
      </div>
      {restarting ? null : (
        <Button size="sm" onClick={() => void store.apply()}>
          Restart now
        </Button>
      )}
    </div>
  );
}

const CHANGED_CHANNEL = "changed";

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "checklist",
    title: "Team setup",
    component: () => (
      <div className="flex flex-col gap-3">
        <ServerUpdateBanner />
        <Checklist compact />
      </div>
    ),
  });
  // Above the composer in every thread, where a developer actually is.
  app.composer.customize({
    id: "server-update",
    banners: [{ id: "server-update", chrome: "bare", component: ServerUpdateBanner }],
  });
  app.slots.settingsSection({
    id: "checklist",
    title: "Checklist",
    description: "Everything a new server needs before agents can work here.",
    component: () => <Checklist compact={false} />,
  });
});
