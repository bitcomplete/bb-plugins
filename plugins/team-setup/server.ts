// Team setup: the checklist a new bb-gate server needs before an agent can
// work. Each step belongs to something else; this plugin reads their state
// and starts their flows from one place.
//
//   AI       Account Pool holds the Claude or Codex sign-in. Started here
//            through its RPCs; the credentials never pass through this plugin.
//   GitHub   gh on this server host. bb core forwards its login to every
//            machine as GH_TOKEN (Settings → Environment variables, the
//            built-in row), so the step is a headless `gh auth login`.
//   devbox   devbox-provider's connection. Started here, finished by its own
//            callback.
//   Linear   the linear plugin's connection, the same shape as devbox's.
//   machine  Any machine at all. Created from devbox-provider's section.
//
// It also carries deployment-wide machine variables: a key the operator
// puts in the server's environment (a Kubernetes Secret in bb-gate) is
// written into Settings → Environment variables, which bb syncs into every
// machine's daemon, where the agent CLIs that need it run.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createGhRunner,
  LOGIN_ARGS,
  LOGOUT_ARGS,
  parseLoggedInAs,
  parseLoginPrompt,
  type GhProcess,
  type GhRunner,
} from "./gh.js";

export const ACCOUNT_POOL_ID = "account-pool";
export const DEVBOX_ID = "devbox-provider";
export const LINEAR_ID = "linear";
export const CHANGED = "changed";

// Server environment variables copied into the machine environment on every
// start. Each is a key an agent CLI on the machine reads: Pi's built-in
// Fireworks provider turns on when FIREWORKS_API_KEY is set, so a server
// whose deployment supplies the key gives every developer Fireworks models
// with nothing to configure. The server's value is the source of truth; a
// row edited or deleted by hand comes back on the next restart.
export const SEEDED_VARIABLES = ["FIREWORKS_API_KEY"] as const;
export const SEEDED_NOTE = "From the server's environment (team setup). Edits are overwritten on restart.";

// GitHub device codes last 15 minutes; gh gives up itself around then.
export const LOGIN_TTL_MS = 15 * 60 * 1000;
// gh prints the prompt within a second or two; longer means it is stuck
// (no network, no gh) and the stderr so far is the error.
const PROMPT_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 15_000;
const IDENTITY_TTL_MS = 60_000;

const stepStateSchema = z.enum(["done", "todo", "unavailable"]);
export type StepState = z.infer<typeof stepStateSchema>;

const providerSchema = z.enum(["claude", "codex"]);
const accountRowSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  label: z.string(),
  enabled: z.boolean(),
  status: z.string(),
});

const githubStatusSchema = z.enum(["logged in", "not logged in", "overridden", "disabled", "unknown"]);
const pendingLoginSchema = z.object({ code: z.string(), url: z.string(), expiresAt: z.number() });

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      ai: z.object({
        available: z.boolean(),
        message: z.string().nullable(),
        routing: z.object({ claude: z.boolean(), codex: z.boolean() }),
        accounts: z.array(accountRowSchema),
      }),
      github: z.object({
        status: githubStatusSchema,
        message: z.string().nullable(),
        login: z.string().nullable(),
        org: z.string(),
        orgMember: z.boolean().nullable(),
        pending: pendingLoginSchema.nullable(),
        lastError: z.string().nullable(),
      }),
      devbox: z.object({
        available: z.boolean(),
        message: z.string().nullable(),
        connected: z.boolean(),
        project: z.string().nullable(),
      }),
      linear: z.object({
        available: z.boolean(),
        message: z.string().nullable(),
        connected: z.boolean(),
        configured: z.boolean(),
        user: z.string().nullable(),
        organization: z.string().nullable(),
      }),
      machines: z.object({ names: z.array(z.string()) }),
      steps: z.object({ ai: stepStateSchema, github: stepStateSchema, devbox: stepStateSchema, linear: stepStateSchema, machine: stepStateSchema }),
      complete: z.boolean(),
    }),
  },
  // GitHub: the device flow. Returns the code to type and where; the login
  // lands when GitHub approves it and `status` flips. Calling again while
  // one is pending returns the same code.
  githubSignIn: { input: z.null(), output: pendingLoginSchema },
  githubCancel: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  githubSignOut: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  // Claude: Account Pool's browser sign-in. Open the URL, paste the code
  // from its final page back here.
  claudeSignIn: { input: z.null(), output: z.object({ sessionId: z.string(), url: z.string() }) },
  claudeComplete: {
    input: z.object({ sessionId: z.string(), pasted: z.string().trim().min(1) }).strict(),
    output: z.object({ label: z.string() }),
  },
  // Codex: Account Pool's device flow, polled from here.
  codexSignIn: {
    input: z.null(),
    output: z.object({ sessionId: z.string(), url: z.string(), code: z.string(), expiresAt: z.number(), intervalMs: z.number() }),
  },
  codexPoll: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }),
      z.object({ status: z.literal("complete"), label: z.string() }),
      z.object({ status: z.literal("error"), message: z.string() }),
    ]),
  },
  codexCancel: { input: z.object({ sessionId: z.string() }).strict(), output: z.object({ ok: z.boolean() }) },
  // devbox: devbox-provider's connect; its callback finishes the job.
  devboxConnect: { input: z.null(), output: z.object({ url: z.string() }) },
  // Linear: the linear plugin's connect, likewise.
  linearConnect: { input: z.null(), output: z.object({ url: z.string() }) },
});

export const SETTING_DESCRIPTORS = {
  githubOrg: {
    type: "string",
    label: "GitHub organization",
    description: "Checked after GitHub sign-in: an account outside this organization cannot reach its repos. Empty skips the check.",
    default: "bitcomplete",
  },
} as const;

export interface TeamSetupDeps {
  gh: GhRunner;
  now: () => number;
  env: Record<string, string | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, lines = 3): string {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join(" ")
    .trim();
}

// What the other plugins answer; only the fields read here, everything else
// passes through.
const poolStatusSchema = z
  .object({
    routing: z.object({ claude: z.boolean(), codex: z.boolean() }).loose(),
    accounts: z.array(
      z.object({ id: z.string(), provider: providerSchema, label: z.string(), enabled: z.boolean(), status: z.string() }).loose(),
    ),
  })
  .loose();
const poolLoginStartSchema = z.object({ sessionId: z.string(), authorizeUrl: z.string() }).loose();
const poolAccountSchema = z.object({ label: z.string() }).loose();
const poolCodexStartSchema = z
  .object({ sessionId: z.string(), verificationUri: z.string(), userCode: z.string(), expiresAt: z.number(), intervalMs: z.number() })
  .loose();
const poolCodexPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).loose(),
  z.object({ status: z.literal("complete"), account: poolAccountSchema }).loose(),
  z.object({ status: z.literal("error"), message: z.string() }).loose(),
]);
const poolCancelSchema = z.object({ cancelled: z.boolean() }).loose();
const devboxStatusSchema = z.object({ connected: z.boolean(), project: z.string().nullable() }).loose();
const devboxConnectSchema = z.object({ url: z.string() }).loose();
const linearStatusSchema = z
  .object({
    connected: z.boolean(),
    configured: z.boolean(),
    user: z.object({ name: z.string() }).loose().nullable(),
    organization: z.object({ name: z.string() }).loose().nullable(),
  })
  .loose();
const linearConnectSchema = z.object({ url: z.string() }).loose();

interface PendingLogin {
  process: GhProcess;
  code: string;
  url: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  // Set before kill() so the exit it causes is not reported as a failure.
  cancelled: boolean;
}

interface Identity {
  login: string | null;
  orgMember: boolean | null;
  org: string;
  at: number;
}

export function createTeamSetupPlugin(deps: TeamSetupDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);

    // ---- deployment-wide machine variables ---------------------------------

    for (const name of SEEDED_VARIABLES) {
      const value = deps.env[name];
      if (value === undefined || value.trim() === "") continue;
      try {
        await bb.sdk.system.setMachineEnvironmentVariable({ name, value, note: SEEDED_NOTE });
        bb.log.info(`${name} from the server environment is set for every machine`);
      } catch (error) {
        bb.log.warn(`could not set ${name} for machines: ${errorMessage(error)}`);
      }
    }

    // ---- other plugins ----------------------------------------------------

    async function pluginState(id: string): Promise<{ available: boolean; message: string | null }> {
      try {
        const { plugins } = await bb.sdk.plugins.list();
        const p = plugins.find((entry) => entry.id === id);
        if (p === undefined) return { available: false, message: `The ${id} plugin is not installed.` };
        if (!p.enabled) return { available: false, message: `The ${id} plugin is turned off.` };
        return { available: true, message: null };
      } catch (error) {
        return { available: false, message: `Could not list plugins: ${errorMessage(error)}` };
      }
    }

    function call<T>(pluginId: string, method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> {
      return bb.sdk.plugins.callRpc({
        pluginId,
        method,
        input: (input ?? null) as Parameters<typeof bb.sdk.plugins.callRpc>[0]["input"],
        outputSchema,
      });
    }

    // ---- GitHub -----------------------------------------------------------

    let pending: PendingLogin | null = null;
    let lastError: string | null = null;
    let identity: Identity | null = null;

    function clearPending(): void {
      if (pending === null) return;
      clearTimeout(pending.timer);
      pending = null;
    }

    function cancelPending(): void {
      if (pending === null) return;
      pending.cancelled = true;
      pending.process.kill();
      clearPending();
    }

    async function githubIdentity(): Promise<Identity> {
      const org = (await settings.get()).githubOrg.trim();
      if (identity !== null && identity.org === org && deps.now() - identity.at < IDENTITY_TTL_MS) return identity;
      let login: string | null = null;
      let orgMember: boolean | null = null;
      const user = await deps.gh.run(["api", "--hostname", "github.com", "user", "--jq", ".login"], GH_TIMEOUT_MS);
      if (user.exitCode === 0 && user.stdout.trim() !== "") login = user.stdout.trim();
      if (login !== null && org !== "") {
        const membership = await deps.gh.run(
          ["api", "--hostname", "github.com", `user/memberships/orgs/${org}`, "--jq", ".state"],
          GH_TIMEOUT_MS,
        );
        orgMember = membership.exitCode === 0 && membership.stdout.trim() === "active";
      }
      identity = { login, orgMember, org, at: deps.now() };
      return identity;
    }

    async function githubStatus() {
      const org = (await settings.get()).githubOrg.trim();
      let status: z.infer<typeof githubStatusSchema> = "unknown";
      let message: string | null = null;
      try {
        const env = await bb.sdk.system.machineEnvironment();
        status = env.builtInGit.status;
        message = env.builtInGit.statusMessage;
      } catch (error) {
        message = `Could not read the machine environment: ${errorMessage(error)}`;
      }
      const id = status === "logged in" ? await githubIdentity() : { login: null, orgMember: null, org, at: 0 };
      return {
        status,
        message,
        login: id.login,
        org,
        orgMember: id.orgMember,
        pending: pending === null ? null : { code: pending.code, url: pending.url, expiresAt: pending.expiresAt },
        lastError,
      };
    }

    function startGithubLogin(): Promise<{ code: string; url: string; expiresAt: number }> {
      if (pending !== null) {
        return Promise.resolve({ code: pending.code, url: pending.url, expiresAt: pending.expiresAt });
      }
      lastError = null;
      const process = deps.gh.start(LOGIN_ARGS);
      const lines: string[] = [];
      return new Promise((resolve, reject) => {
        let settled = false;
        const promptTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          process.kill();
          reject(new Error(`gh printed no sign-in code within ${PROMPT_TIMEOUT_MS / 1000} s: ${tail(lines.join("\n")) || "no output"}`));
        }, PROMPT_TIMEOUT_MS);
        process.onLine((line) => {
          lines.push(line);
          if (settled) return;
          const prompt = parseLoginPrompt(lines);
          if (prompt === null) return;
          settled = true;
          clearTimeout(promptTimer);
          const expiresAt = deps.now() + LOGIN_TTL_MS;
          const entry: PendingLogin = {
            process,
            code: prompt.code,
            url: prompt.url,
            expiresAt,
            cancelled: false,
            timer: setTimeout(() => {
              if (pending === entry) {
                process.kill();
                lastError = "The code expired before it was approved. Start again.";
              }
            }, LOGIN_TTL_MS),
          };
          pending = entry;
          void process.exited.then((result) => {
            if (pending === entry) clearPending();
            identity = null;
            if (result.exitCode === 0) {
              lastError = null;
              bb.log.info(`GitHub signed in${parseLoggedInAs(lines) === null ? "" : ` as ${parseLoggedInAs(lines)}`}`);
            } else if (entry.cancelled) {
              return;
            } else if (lastError === null) {
              lastError = tail(result.stderr) || `gh auth login exited with ${result.exitCode}`;
              bb.log.warn(`GitHub sign-in failed: ${lastError}`);
            }
            bb.realtime.publish(CHANGED, { github: result.exitCode === 0 ? "signed in" : "failed" });
          });
          resolve({ code: prompt.code, url: prompt.url, expiresAt });
        });
        void process.exited.then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(promptTimer);
          reject(new Error(tail(result.stderr) || `gh auth login exited with ${result.exitCode} before printing a code`));
        });
      });
    }

    // ---- the checklist ----------------------------------------------------

    bb.rpc.register(rpcContract, {
      async status() {
        const [poolState, devboxState, linearState, github, hosts] = await Promise.all([
          pluginState(ACCOUNT_POOL_ID),
          pluginState(DEVBOX_ID),
          pluginState(LINEAR_ID),
          githubStatus(),
          bb.sdk.hosts.list().then(
            (list) => list.map((h) => h.name),
            (error: unknown) => {
              bb.log.warn(`could not list machines: ${errorMessage(error)}`);
              return [] as string[];
            },
          ),
        ]);

        const ai = { ...poolState, routing: { claude: false, codex: false }, accounts: [] as z.infer<typeof accountRowSchema>[] };
        if (poolState.available) {
          try {
            const pool = await call(ACCOUNT_POOL_ID, "status.get", null, poolStatusSchema);
            ai.routing = { claude: pool.routing.claude, codex: pool.routing.codex };
            ai.accounts = pool.accounts.map((a) => ({ id: a.id, provider: a.provider, label: a.label, enabled: a.enabled, status: a.status }));
          } catch (error) {
            ai.available = false;
            ai.message = `Account Pool did not answer: ${errorMessage(error)}`;
          }
        }

        const devbox = { ...devboxState, connected: false, project: null as string | null };
        if (devboxState.available) {
          try {
            const d = await call(DEVBOX_ID, "status", null, devboxStatusSchema);
            devbox.connected = d.connected;
            devbox.project = d.project;
          } catch (error) {
            devbox.available = false;
            devbox.message = `devbox did not answer: ${errorMessage(error)}`;
          }
        }

        const linear = { ...linearState, connected: false, configured: false, user: null as string | null, organization: null as string | null };
        if (linearState.available) {
          try {
            const l = await call(LINEAR_ID, "status", null, linearStatusSchema);
            linear.connected = l.connected;
            linear.configured = l.configured;
            linear.user = l.user?.name ?? null;
            linear.organization = l.organization?.name ?? null;
          } catch (error) {
            linear.available = false;
            linear.message = `Linear did not answer: ${errorMessage(error)}`;
          }
        }

        const aiReady = ai.accounts.some((a) => a.enabled && ai.routing[a.provider]);
        const steps = {
          ai: !ai.available ? "unavailable" : aiReady ? "done" : "todo",
          github:
            github.status === "logged in" || github.status === "overridden"
              ? "done"
              : github.status === "disabled"
                ? "unavailable"
                : "todo",
          devbox: !devbox.available ? "unavailable" : devbox.connected ? "done" : "todo",
          // A server whose operator has not set up the OAuth application
          // cannot connect, and that is not the developer's to-do.
          linear: !linear.available || !linear.configured ? "unavailable" : linear.connected ? "done" : "todo",
          machine: hosts.length > 0 ? "done" : "todo",
        } as const;
        return {
          ai,
          github,
          devbox,
          linear,
          machines: { names: hosts },
          steps,
          complete: Object.values(steps).every((s) => s !== "todo"),
        };
      },

      githubSignIn: () => startGithubLogin(),
      async githubCancel() {
        cancelPending();
        lastError = null;
        return { ok: true };
      },
      async githubSignOut() {
        cancelPending();
        const result = await deps.gh.run(LOGOUT_ARGS, GH_TIMEOUT_MS);
        identity = null;
        lastError = null;
        if (result.exitCode !== 0 && !/not logged in/iu.test(result.stderr)) {
          throw new Error(tail(result.stderr) || `gh auth logout exited with ${result.exitCode}`);
        }
        bb.realtime.publish(CHANGED, { github: "signed out" });
        return { ok: true };
      },

      async claudeSignIn() {
        const started = await call(ACCOUNT_POOL_ID, "login.start", null, poolLoginStartSchema);
        return { sessionId: started.sessionId, url: started.authorizeUrl };
      },
      async claudeComplete({ sessionId, pasted }) {
        const account = await call(ACCOUNT_POOL_ID, "login.complete", { sessionId, pasted }, poolAccountSchema);
        bb.realtime.publish(CHANGED, { ai: "claude" });
        return { label: account.label };
      },
      async codexSignIn() {
        const s = await call(ACCOUNT_POOL_ID, "codexLogin.start", null, poolCodexStartSchema);
        return { sessionId: s.sessionId, url: s.verificationUri, code: s.userCode, expiresAt: s.expiresAt, intervalMs: s.intervalMs };
      },
      async codexPoll({ sessionId }) {
        const r = await call(ACCOUNT_POOL_ID, "codexLogin.poll", { sessionId }, poolCodexPollSchema);
        if (r.status === "complete") {
          bb.realtime.publish(CHANGED, { ai: "codex" });
          return { status: "complete" as const, label: r.account.label };
        }
        return r.status === "pending" ? { status: "pending" as const } : { status: "error" as const, message: r.message };
      },
      async codexCancel({ sessionId }) {
        const r = await call(ACCOUNT_POOL_ID, "codexLogin.cancel", { sessionId }, poolCancelSchema);
        return { ok: r.cancelled };
      },

      async devboxConnect() {
        const { url } = await call(DEVBOX_ID, "connect", null, devboxConnectSchema);
        return { url };
      },
      async linearConnect() {
        const { url } = await call(LINEAR_ID, "connect", null, linearConnectSchema);
        return { url };
      },
    });
  };
}

export default createTeamSetupPlugin({ gh: createGhRunner(), now: () => Date.now(), env: process.env });
