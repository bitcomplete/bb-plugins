// Stewards: give a labelled Linear ticket or GitHub pull request, or a
// teammate's pull request, a long-lived thread that manages it as the
// developer until it is done. DESIGN.md is the design; this file wires it.
//
// The model is a controller. The spec (the playbook, the entity's own
// description and spec comments, standing guidance) is the desired state; a
// snapshot read through the linear and github-watcher plugins is the observed state;
// a steward's turn is one reconcile. Rings from those plugins (bb-gate-hooks
// doorbells, forwarded) and timers only say "look again". The mechanical tier
// below looks, compares with the last observation, and wakes the steward only
// when something actionable changed.
//
// Configuration lives in the project's `.bb`, read through multi-repo's RPC
// from the canonical checkout's committed HEAD. Nothing here reads a file.
import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_FOLLOW_THROUGH_MS,
  DEFAULT_PLAYBOOKS,
  ESCALATION_KINDS,
  KINDS,
  PROJECT_FILE,
  durationSchema,
  formatDuration,
  isTerminal,
  modelSpecSchema,
  parsePlaybook,
  parseProjectFile,
  playbookNameFor,
  playbookPath,
  playbookStates,
  STAGES,
  type BindingKind,
  type EscalationKind,
  type ModelSpec,
  type Playbook,
  type ProjectFile,
} from "./config.js";
import { nightlyDue, stillNight } from "./nightly.js";
import { advanced, approvalWanted, diffObserved, endingDeadline, followingThrough, gateState, hasLabel, isCommentNews, lifecycle, newestCommentAt, phaseAndStage, resolveChecklistItem, specHash, stuckDue, unheardWait, type Change } from "./reconcile.js";
import {
  SOURCE_PLUGIN_IDS,
  STEWARDS_PLUGIN_ID,
  entitySnapshotSchema,
  signatureLine,
  sourceContract,
  stewardsContract,
  type EntitySnapshot,
  type Source,
} from "./source-contract.js";
import { ACTORS, MIGRATIONS, createStore, type Binding, type Escalation, type EscalationRoute, type Observed, type Question, type ReadyState, type Store } from "./store.js";
import { PLAYBOOK_TEMPLATES, projectFileTemplate } from "./templates.js";
import { PROJECT_STEWARD_INTRO, formatProjectWake, formatWake, type DigestRecords, type WakeReason } from "./wake.js";

export const MULTI_REPO_PLUGIN_ID = "multi-repo";
/** multi-repo's environment provider: where every thread of a stewards project works. */
export const MULTI_REPO_ENVIRONMENT_PROVIDER_ID = "multi-repo-workspace";

/**
 * What thread-briefs is asked to leave alone, seeded into this plugin's
 * metadata namespace on each thread it spawns (thread-briefs' README, "Threads
 * a plugin runs"). Every steward keeps the title it was given, which carries
 * the entity key, and is archived by this plugin when its binding ends, or
 * when a wake turn ends waiting on someone else, rather than whenever its
 * brief reads done between wakes. Stewards stay out of the status
 * sections, where one idle between wakes would read done: the project
 * steward is never finished, and a steward is finished when its binding ends.
 * A ticket or pull request steward's row draws the stage ring like any
 * thread's, following its entity's work. The project steward's draws none:
 * it has no stage to show, and its ring would only say done about a project
 * that is not.
 */
export const STEWARD_BRIEFS = { rename: false, group: false, archive: false } as const;
export const PROJECT_BRIEFS = { ...STEWARD_BRIEFS, ring: false } as const;

export interface Timing {
  /** Rings for one entity within this long are one look. */
  debounceMs: number;
  /** How long a project's configuration is reused before `.bb` is read again. */
  configTtlMs: number;
  /** The mechanical sweep: adoption backstop, stuck backstop, a look at every binding. */
  sweepMs: number;
  /** How often requeue timers are checked. */
  requeueTickMs: number;
  /** Between two nightly turns. */
  nightlyStaggerMs: number;
  /** A wrap-up or stop turn that has not finished in this long is finished for it (follow-through has its own cap, from the playbook). */
  endingTimeoutMs: number;
  /** A steward that ends this many woken turns in a row without a report is stuck. */
  missedReportsForStuck: number;
  /** How far back a user's words are looked for when an approval is recorded. */
  approvalLookbackMs: number;
}

export const DEFAULT_TIMING: Timing = {
  debounceMs: 3000,
  configTtlMs: 5 * 60_000,
  sweepMs: 30 * 60_000,
  requeueTickMs: 60_000,
  nightlyStaggerMs: 20_000,
  endingTimeoutMs: 60 * 60_000,
  missedReportsForStuck: 3,
  approvalLookbackMs: 24 * 60 * 60_000,
};

export interface StewardsDeps {
  now: () => number;
  timing?: Partial<Timing>;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** "owner/repo" from a GitHub remote URL, or null for anything else. */
export function githubRepoOf(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

// What this plugin reads from multi-repo. Loose: multi-repo's views carry more.
const readFilesOutput = z
  .object({ projectSourcePath: z.string().nullable(), head: z.string().nullable(), files: z.array(z.object({ path: z.string(), content: z.string().nullable() }).loose()), error: z.string().nullable() })
  .loose();
const repoSetOutput = z.object({ repos: z.array(z.object({ dir: z.string(), url: z.string() }).loose()), error: z.string().nullable() }).loose();

/** The steward's own surface for the app and the CLI. Cross-plugin methods are in source-contract.ts. */
export const rpcContract = defineRpcContract({
  ...stewardsContract,
  stewardsList: {
    input: z.object({ projectId: z.string().min(1).max(100).nullable(), all: z.boolean() }),
    output: z.object({
      bindings: z.array(
        z.object({
          id: z.string(),
          projectId: z.string(),
          key: z.string(),
          kind: z.string(),
          phase: z.string().nullable(),
          threadId: z.string().nullable(),
          summary: z.string().nullable(),
          nextAction: z.string().nullable(),
          actor: z.string().nullable(),
          escalations: z.number(),
          ended: z.boolean(),
        }),
      ),
    }),
  },
  // The settings page: what is stewarded, per project, and whether it is healthy.
  stewardsOverview: {
    input: z.null(),
    output: z.object({
      paused: z.boolean(),
      lastSweepAt: z.number().nullable(),
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          configured: z.boolean(),
          label: z.string().nullable(),
          linearTeams: z.array(z.string()),
          repos: z.array(z.string()),
          excludedRepos: z.array(z.string()),
          playbooks: z.array(z.object({ kind: z.string(), name: z.string(), version: z.string().nullable() })),
          problems: z.array(z.string()),
          nightly: z.object({ at: z.string(), timezone: z.string() }).nullable(),
          lastNight: z.string().nullable(),
          projectStewardThreadId: z.string().nullable(),
          digestAt: z.number().nullable(),
          endedCount: z.number(),
          stewards: z.array(
            z.object({
              key: z.string(),
              url: z.string().nullable(),
              title: z.string().nullable(),
              kind: z.string(),
              phase: z.string().nullable(),
              threadId: z.string().nullable(),
              summary: z.string().nullable(),
              nextAction: z.string().nullable(),
              actor: z.string().nullable(),
              blockedOn: z.string().nullable(),
              priority: z.string().nullable(),
              hold: z.string().nullable(),
              ending: z.string().nullable(),
              statusAt: z.number().nullable(),
              createdAt: z.number(),
              workers: z.number(),
              escalations: z.array(z.object({ kind: z.string(), route: z.string(), question: z.string() })),
            }),
          ),
        }),
      ),
    }),
  },
  stewardsCheck: {
    input: z.object({ projectId: z.string().min(1).max(100) }),
    output: z.object({ ok: z.boolean(), lines: z.array(z.string()) }),
  },
  // The stewards page: one project's board. A null projectId picks the first project.
  stewardsBoard: {
    input: z.object({ projectId: z.string().min(1).max(100).nullable() }),
    output: z.object({
      projects: z.array(z.object({ projectId: z.string(), name: z.string() })),
      board: z
        .object({
          projectId: z.string(),
          name: z.string(),
          paused: z.boolean(),
          projectStewardThreadId: z.string().nullable(),
          /** The playbook schema's stages, in order: the page groups in-flight stewards by them. */
          stages: z.array(z.string()),
          digest: z.object({ text: z.string(), at: z.number() }).nullable(),
          questions: z.array(
            z.object({ id: z.string(), question: z.string(), context: z.string().nullable(), key: z.string().nullable(), url: z.string().nullable(), escalationId: z.string().nullable(), createdAt: z.number() }),
          ),
          /** Open escalations with the user that no question covers: approval requests, and forwards from before questions were kept. */
          withUser: z.array(
            z.object({ id: z.string(), kind: z.string(), question: z.string(), recommendation: z.string().nullable(), key: z.string(), url: z.string().nullable(), threadId: z.string().nullable(), createdAt: z.number() }),
          ),
          stewards: z.array(
            z.object({
              key: z.string(),
              url: z.string().nullable(),
              title: z.string().nullable(),
              kind: z.string(),
              phase: z.string().nullable(),
              stage: z.string().nullable(),
              threadId: z.string().nullable(),
              summary: z.string().nullable(),
              nextAction: z.string().nullable(),
              actor: z.string().nullable(),
              blockedOn: z.string().nullable(),
              priority: z.string().nullable(),
              ending: z.string().nullable(),
              advancedAt: z.number().nullable(),
              workers: z.array(z.object({ threadId: z.string(), title: z.string() })),
            }),
          ),
          stuck: z.array(z.object({ key: z.string(), url: z.string().nullable(), threadId: z.string().nullable(), why: z.string(), since: z.number().nullable() })),
          ended: z.array(z.object({ key: z.string(), url: z.string().nullable(), title: z.string().nullable(), kind: z.string(), endReason: z.string().nullable(), endedAt: z.number(), threadId: z.string().nullable() })),
        })
        .nullable(),
    }),
  },
  // The user closes a question from the page, with or without an answer.
  stewardsAnswerQuestion: {
    input: z.object({ questionId: z.string().min(1).max(100), answer: z.string().trim().max(4000).nullable() }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

/** How long an ended binding stays on the page. */
const ENDED_ON_BOARD_MS = 14 * 86_400_000;

type ProjectConfig = {
  projectId: string;
  file: ProjectFile;
  playbooks: Partial<Record<BindingKind, Playbook>>;
  /** GitHub repos from the project's repos.json, as owner/repo, less github.exclude. */
  repos: string[];
  /** What is wrong with the configuration, in sentences; bindings keep running under the last good playbook. */
  problems: string[];
  loadedAt: number;
};

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function createStewardsPlugin(deps: StewardsDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const timing: Timing = { ...DEFAULT_TIMING, ...deps.timing };
    const now = deps.now;
    const settings = bb.settings.define({
      paused: {
        type: "boolean",
        label: "Pause stewards",
        description: "No steward is woken and nothing new is adopted while this is on. Changes still queue up and are delivered when it is turned off.",
        default: false,
      },
      workerSpawnsPerHour: {
        type: "number",
        label: "Worker spawns per binding per hour",
        description: "The runaway guard: a steward that tries to start more workers than this in an hour is refused. Not a budget.",
        default: 6,
      },
      compactAboveTokens: {
        type: "number",
        label: "Compact a steward above this many context tokens",
        description: "After a steward's or the project steward's turn, its context is compacted when it holds more than this. Every wake is self-contained, so little is lost. 0 leaves compaction to the provider.",
        default: 120_000,
      },
    });

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = createStore(db, now);

    const rpc = <T>(pluginId: string, method: string, input: unknown, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> =>
      bb.sdk.plugins.callRpc<T>({ pluginId, method, input: input as never, outputSchema, ...(signal === undefined ? {} : { signal }) });
    const sourceRpc = <T>(source: Source, method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> =>
      rpc(SOURCE_PLUGIN_IDS[source], method, input, outputSchema);

    // ---- serial work and debounce ----------------------------------------------------
    //
    // Work on one binding (or one entity, before it has a binding) never
    // overlaps: a promise chain per key. Different keys run concurrently.

    const chains = new Map<string, Promise<void>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    });

    function serial(key: string, fn: () => Promise<void>): Promise<void> {
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => (disposed ? undefined : fn()))
        .catch((error: unknown) => bb.log.warn(`stewards: ${key}: ${errorMessage(error)}`))
        .finally(() => {
          if (chains.get(key) === next) chains.delete(key);
        });
      chains.set(key, next);
      return next;
    }

    function debounce(key: string, fn: () => Promise<void>): void {
      if (disposed || timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          void fn();
        }, timing.debounceMs),
      );
    }

    /** Look at a binding again, soon, once however often this is called meanwhile. */
    const scheduleReconcile = (bindingId: string) => debounce(`b:${bindingId}`, () => serial(`b:${bindingId}`, () => reconcileBinding(bindingId, null)));

    // ---- configuration ----------------------------------------------------------------

    const configs = new Map<string, { at: number; value: ProjectConfig | null }>();

    async function readFiles(projectId: string, paths: string[]): Promise<Map<string, string | null>> {
      const out = await rpc(MULTI_REPO_PLUGIN_ID, "readProjectFiles", { projectId, paths }, readFilesOutput);
      if (out.error !== null && out.files.length === 0) throw new Error(out.error);
      return new Map(out.files.map((f) => [f.path, f.content]));
    }

    /**
     * The project's stewards configuration, or null when the project has none.
     * A file that fails to parse falls back to the last good copy, kept in kv,
     * and the failure is reported as a problem rather than stopping anything.
     */
    async function loadConfig(projectId: string, force = false): Promise<ProjectConfig | null> {
      const cached = configs.get(projectId);
      if (!force && cached !== undefined && now() - cached.at < timing.configTtlMs) return cached.value;
      let value: ProjectConfig | null;
      try {
        value = await readConfig(projectId);
      } catch (error) {
        // Unreachable `.bb` is not "no stewards": keep what we had.
        bb.log.warn(`stewards: could not read the configuration of project ${projectId}: ${errorMessage(error)}`);
        if (cached !== undefined) return cached.value;
        return null;
      }
      configs.set(projectId, { at: now(), value });
      return value;
    }

    async function readConfig(projectId: string): Promise<ProjectConfig | null> {
      const problems: string[] = [];
      const projectText = (await readFiles(projectId, [PROJECT_FILE])).get(PROJECT_FILE) ?? null;
      if (projectText === null) return null;
      let file: ProjectFile;
      const parsed = parseProjectFile(projectText);
      if (parsed.ok) {
        file = parsed.value;
        await bb.storage.kv.set(`good/${projectId}/project`, projectText);
      } else {
        problems.push(parsed.error);
        const last = await bb.storage.kv.get<string>(`good/${projectId}/project`);
        const lastParsed = typeof last === "string" ? parseProjectFile(last) : null;
        if (lastParsed === null || !lastParsed.ok) {
          bb.log.warn(`stewards: ${parsed.error}`);
          return null;
        }
        file = lastParsed.value;
      }

      const kinds = KINDS.filter((k) => k !== "review" || file.reviews.enabled);
      const names = new Map(kinds.map((k) => [k, playbookNameFor(file, k)] as const));
      const texts = await readFiles(projectId, [...new Set(names.values())].map(playbookPath));
      const playbooks: Partial<Record<BindingKind, Playbook>> = {};
      for (const [kind, name] of names) {
        const text = texts.get(playbookPath(name)) ?? null;
        const goodKey = `good/${projectId}/playbook/${name}`;
        let result = text === null ? ({ ok: false, error: `${playbookPath(name)} does not exist` } as const) : parsePlaybook(text, name);
        if (result.ok && result.value.kind !== kind) result = { ok: false, error: `${playbookPath(name)} is a ${result.value.kind} playbook, but the project file uses it for ${kind}` };
        if (result.ok) {
          playbooks[kind] = result.value;
          await bb.storage.kv.set(goodKey, text);
          continue;
        }
        problems.push(result.error);
        const last = await bb.storage.kv.get<string>(goodKey);
        const lastParsed = typeof last === "string" ? parsePlaybook(last, name) : null;
        if (lastParsed !== null && lastParsed.ok) {
          playbooks[kind] = lastParsed.value;
          problems.push(`${kind} bindings keep running under the last good ${name} (${lastParsed.value.version}).`);
        }
      }

      let repos: string[] = [];
      try {
        const set = await rpc(MULTI_REPO_PLUGIN_ID, "repoSet", { projectId }, repoSetOutput);
        if (set.error !== null) problems.push(`repos.json: ${set.error}`);
        const all = set.repos.map((r) => githubRepoOf(r.url)).filter((r): r is string => r !== null);
        repos = all.filter((r) => !file.github.exclude.some((x) => lc(x) === lc(r)));
        if (set.error === null) {
          const stray = file.github.exclude.filter((x) => !all.some((r) => lc(r) === lc(x)));
          if (stray.length > 0) problems.push(`github.exclude names ${stray.join(", ")}, not in repos.json`);
        }
      } catch (error) {
        problems.push(`could not read the repo set: ${errorMessage(error)}`);
      }
      return { projectId, file, playbooks, repos, problems, loadedAt: now() };
    }

    /** Every project with a stewards configuration. */
    async function stewardedProjects(force = false): Promise<ProjectConfig[]> {
      const projects = await bb.sdk.projects.list();
      const out: ProjectConfig[] = [];
      for (const p of projects) {
        const config = await loadConfig(p.id, force);
        if (config !== null) out.push(config);
      }
      return out;
    }

    const playbookFor = (config: ProjectConfig, kind: BindingKind) => config.playbooks[kind] ?? null;

    // ---- the sources ---------------------------------------------------------------------

    async function snapshot(source: Source, id: string): Promise<EntitySnapshot | null> {
      const out = await sourceRpc(source, "sourceSnapshot", { id }, sourceContract.sourceSnapshot.output);
      return out.snapshot === null ? null : entitySnapshotSchema.parse(out.snapshot);
    }

    /** A ticket's linked pull requests, read from github. One that cannot be read is left out. */
    async function linkedPulls(entity: EntitySnapshot): Promise<EntitySnapshot[]> {
      const keys = [...new Set(entity.linkedPulls.map((l) => l.key).filter((k): k is string => k !== null))].slice(0, 5);
      const pulls: EntitySnapshot[] = [];
      for (const key of keys) {
        try {
          const pull = await snapshot("github", key);
          if (pull !== null) pulls.push(pull);
        } catch (error) {
          bb.log.warn(`stewards: could not read ${key}, linked from ${entity.key}: ${errorMessage(error)}`);
        }
      }
      return pulls;
    }

    /**
     * The pull requests linked to a ticket that are leased for it: those
     * still open. One with no snapshot yet (not read, or the read failed) is
     * kept, so a new pull request is watched before its first read.
     */
    function leasedPulls(b: Pick<Binding, "kind" | "lastSnapshot">): string[] {
      if (b.kind !== "ticket" || b.lastSnapshot === null) return [];
      const pulls = b.lastSnapshot.pulls;
      return b.lastSnapshot.entity.linkedPulls
        .map((l) => l.key)
        .filter((k): k is string => k !== null)
        .filter((k) => {
          const seen = pulls.find((p) => lc(p.key) === lc(k));
          return seen === undefined || !["closed", "merged"].includes(lc(seen.state));
        });
    }

    // The interest set: what linear and github should lease and ring us
    // about. Sent whole, only when it changed, a moment after the change.
    const lastInterest = new Map<Source, string>();
    function pushInterest(): void {
      debounce("interest", () => serial("interest", sendInterest));
    }
    async function sendInterest(): Promise<void> {
      const projects = [...configs.values()].map((c) => c.value).filter((c): c is ProjectConfig => c !== null);
      const open = store.open();
      const sets: Record<Source, { units: string[]; entities: string[] }> = {
        linear: {
          units: [...new Set(projects.flatMap((p) => p.file.linear.teams))].sort(),
          entities: [...new Set(open.filter((b) => b.source === "linear").map((b) => b.entityId))].sort(),
        },
        github: {
          units: [...new Set(projects.flatMap((p) => p.repos))].sort(),
          entities: [
            ...new Set([
              ...open.filter((b) => b.source === "github").map((b) => b.entityId),
              ...open.flatMap((b) => leasedPulls(b)),
            ]),
          ].sort(),
        },
      };
      for (const source of ["linear", "github"] as const) {
        const body = JSON.stringify(sets[source]);
        if (lastInterest.get(source) === body) continue;
        try {
          await sourceRpc(source, "sourceSetInterest", sets[source], sourceContract.sourceSetInterest.output);
          lastInterest.set(source, body);
        } catch (error) {
          bb.log.warn(`stewards: could not tell ${source} what to watch: ${errorMessage(error)}`);
        }
      }
    }

    // ---- threads ----------------------------------------------------------------------------

    type ThreadInfo = { id: string; title: string | null; status: string; archivedAt: number | null; deletedAt: number | null; environmentId: string | null; environmentHostId: string | null; providerId: string; parentThreadId: string | null; sectionId: string | null };

    async function threadInfo(threadId: string): Promise<ThreadInfo | null> {
      try {
        const t = (await bb.sdk.threads.get({ threadId })) as unknown as Partial<ThreadInfo> & { environment?: { hostId?: string | null } | null };
        return {
          id: threadId,
          title: t.title ?? null,
          status: String(t.status ?? "idle"),
          archivedAt: t.archivedAt ?? null,
          deletedAt: t.deletedAt ?? null,
          environmentId: t.environmentId ?? null,
          // The SDK's thread carries its machine on `environment`, not at the top level.
          environmentHostId: t.environment?.hostId ?? t.environmentHostId ?? null,
          providerId: String(t.providerId ?? ""),
          parentThreadId: t.parentThreadId ?? null,
          sectionId: t.sectionId ?? null,
        };
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return null;
        throw error;
      }
    }

    const busy = (status: string) => status === "active" || status === "starting" || status === "pending" || status === "stopping";

    /** Message a thread; "gone" when it no longer exists. */
    async function send(threadId: string, text: string): Promise<"sent" | "gone" | "failed"> {
      try {
        await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "auto" });
        return "sent";
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return "gone";
        bb.log.warn(`stewards: could not message thread ${threadId}: ${errorMessage(error)}`);
        return "failed";
      }
    }

    /**
     * Message a thread, bringing it back first if it was archived while it
     * waited. A function for the text is called just before the send, after
     * those awaits, so it reads the store as of the send.
     */
    async function sendTo(threadId: string, text: string | (() => string)): Promise<"sent" | "gone" | "failed"> {
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return "gone";
      if (info.archivedAt !== null) await quietly(`unarchive ${threadId}`, () => bb.sdk.threads.unarchive({ threadId }));
      return send(threadId, typeof text === "string" ? text : text());
    }

    async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
      } catch (error) {
        bb.log.warn(`stewards: could not ${what}: ${errorMessage(error)}`);
      }
    }

    const modelArgs = (spec: ModelSpec | null) =>
      spec === null ? {} : { providerId: spec.providerId, ...(spec.model === null ? {} : { model: spec.model }), ...(spec.reasoningLevel === null ? {} : { reasoningLevel: spec.reasoningLevel }) };

    function parseModel(text: string | null): ModelSpec | null {
      if (text === null) return null;
      const parsed = modelSpecSchema.safeParse(text);
      return parsed.success ? parsed.data : null;
    }

    /** A model as `bb thread spawn` flags, for the worker command a wake shows. */
    const workerFlags = (spec: ModelSpec | null) =>
      spec === null ? "" : [`--provider ${spec.providerId}`, spec.model === null ? null : `--model ${spec.model}`, spec.reasoningLevel === null ? null : `--reasoning-level ${spec.reasoningLevel}`].filter((f) => f !== null).join(" ");

    const stewardModel = (b: Binding, playbook: Playbook) => parseModel(b.modelSteward) ?? playbook.models.steward;
    const workerModel = (b: Binding, playbook: Playbook) => parseModel(b.modelWorker) ?? playbook.models.worker;

    /**
     * The machine a project's threads run on: the host of its checkout.
     *
     * `{ type: "project-default" }` would leave it to core, which picks the
     * server's own machine; a server with no host daemon of its own (bb-gate's)
     * then fails every spawn with "Local host daemon is not initialized".
     * A connected machine is preferred, then the default source. Null when the
     * project has no checkout bb knows of, and core's default is all there is.
     */
    async function projectHost(projectId: string): Promise<string | null> {
      try {
        const [project, hosts] = await Promise.all([bb.sdk.projects.get({ projectId }), bb.sdk.hosts.list().catch(() => [])]);
        const sources = project.sources.filter((source) => source.type === "local_path");
        const connected = new Set(hosts.filter((host) => host.status === "connected").map((host) => host.id));
        const pick =
          sources.find((source) => source.isDefault && connected.has(source.hostId)) ??
          sources.find((source) => connected.has(source.hostId)) ??
          sources.find((source) => source.isDefault) ??
          sources[0];
        return pick?.hostId ?? null;
      } catch (error) {
        bb.log.warn(`stewards: could not find the machine for ${projectId} (${errorMessage(error)}); leaving it to bb's default`);
        return null;
      }
    }

    /** A fresh environment for a project's thread: a multi-repo workspace on its machine. */
    const freshEnvironment = (hostId: string | null) =>
      hostId === null
        ? ({ type: "project-default" } as const)
        : ({ type: "provider", environmentProviderId: MULTI_REPO_ENVIRONMENT_PROVIDER_ID, inputs: null, machine: { type: "existing", hostId } } as const);

    /** The same, as `bb thread spawn` flags, for the worker command a wake shows. */
    const environmentFlags = (hostId: string | null) => (hostId === null ? "" : `--environment-provider ${MULTI_REPO_ENVIRONMENT_PROVIDER_ID} --machine ${hostId}`);

    /** The project's name in bb, or "" when bb cannot say. */
    const projectName = (projectId: string): Promise<string> =>
      bb.sdk.projects
        .get({ projectId })
        .then((p) => p.name.trim())
        .catch(() => "");

    /** "<project name> project steward", or the bare role when bb cannot name the project. */
    async function projectStewardTitle(projectId: string): Promise<string> {
      const name = await projectName(projectId);
      return name === "" ? "Project steward" : `${name} project steward`;
    }

    /**
     * The sidebar section a project's stewards are put in, named after the
     * project; null when there is none to use. The one this plugin made is
     * remembered by id, so a rename by hand sticks. One deleted by hand stays
     * deleted: its id is kept as a tombstone, and only a section given the
     * project's name again brings placement back. A section already carrying
     * the project's name is adopted rather than duplicated.
     */
    async function projectSection(projectId: string): Promise<string | null> {
      let sectionId: string | null = null;
      await serial(`section:${projectId}`, async () => {
        const row = store.project(projectId);
        const sections = await bb.sdk.threadSections.list();
        if (row.sectionId !== null && sections.some((s) => s.id === row.sectionId)) {
          sectionId = row.sectionId;
          return;
        }
        const name = await projectName(projectId);
        if (name === "") return;
        const named = sections.find((s) => s.name === name);
        if (named !== undefined) {
          store.patchProject(projectId, { sectionId: named.id });
          sectionId = named.id;
          return;
        }
        if (row.sectionId !== null) return;
        const created = await bb.sdk.threadSections.create({ name });
        store.patchProject(projectId, { sectionId: created.id });
        bb.log.info(`stewards: made the sidebar section ${JSON.stringify(name)} for ${projectId} (${created.id})`);
        sectionId = created.id;
      });
      return sectionId;
    }

    /**
     * Put a steward in its project's section, once. One already in a section
     * is the user's doing and is left there; either way, where it sits from
     * then on is the user's, so a steward dragged out is never pulled back.
     */
    async function placeOnce(projectId: string, info: ThreadInfo): Promise<void> {
      if (store.placed(info.id)) return;
      if (info.sectionId === null) {
        const sectionId = await projectSection(projectId);
        if (sectionId === null) return;
        try {
          await bb.sdk.threads.update({ threadId: info.id, sectionId });
        } catch (error) {
          bb.log.warn(`stewards: could not put ${info.id} in its project's section: ${errorMessage(error)}`);
          return;
        }
      }
      store.markPlaced(info.id);
    }

    /**
     * Delete the section of a project no longer stewarded, once nothing
     * unarchived is left in it. Its stewards are archived as their bindings
     * end, so it empties on its own; a thread the user filed there keeps it.
     */
    async function retireSection(projectId: string, sectionId: string): Promise<void> {
      const sections = await bb.sdk.threadSections.list();
      if (!sections.some((s) => s.id === sectionId)) return;
      const left = await bb.sdk.threads.list({ sectionId, archived: false, limit: 1 });
      if (left.length > 0) return;
      await bb.sdk.threadSections.delete({ id: sectionId });
      store.patchProject(projectId, { sectionId: null });
      bb.log.info(`stewards: deleted the empty sidebar section of ${projectId}, no longer stewarded`);
    }

    /**
     * Ask thread-briefs to leave a steward thread alone, once per thread per
     * process. A spawn seeds it; this covers threads spawned before it was.
     */
    const tagged = new Set<string>();
    async function tagThread(threadId: string, briefs: typeof STEWARD_BRIEFS | typeof PROJECT_BRIEFS): Promise<void> {
      if (tagged.has(threadId)) return;
      try {
        await bb.sdk.threads.updatePluginMetadata({ threadId, set: { threadBriefs: briefs } });
        tagged.add(threadId);
      } catch (error) {
        bb.log.warn(`stewards: could not tag thread ${threadId} for thread-briefs: ${errorMessage(error)}`);
      }
    }

    /**
     * Keep the project steward's title on its project's name, and tag it. A
     * title someone else put there is left alone: only one still showing what
     * this plugin last wrote is updated, or one this plugin never titled (the
     * old "Project steward", or whatever a summarizer renamed it to).
     */
    async function keepProjectSteward(projectId: string): Promise<void> {
      const row = store.project(projectId);
      if (row.threadId === null) return;
      const info = await threadInfo(row.threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return;
      await tagThread(row.threadId, PROJECT_BRIEFS);
      await placeOnce(projectId, info);
      if (row.title !== null && info.title !== row.title) return;
      const title = await projectStewardTitle(projectId);
      if (info.title !== title) await quietly(`retitle the project steward ${row.threadId}`, () => bb.sdk.threads.update({ threadId: row.threadId!, title }));
      if (row.title !== title) store.patchProject(projectId, { title });
    }

    async function ensureProjectSteward(config: ProjectConfig): Promise<string | null> {
      let threadId: string | null = null;
      await serial(`project:${config.projectId}`, async () => {
        const row = store.project(config.projectId);
        if (row.threadId !== null) {
          const info = await threadInfo(row.threadId);
          if (info !== null && info.deletedAt === null) {
            threadId = row.threadId;
            return;
          }
        }
        const title = await projectStewardTitle(config.projectId);
        const sectionId = await projectSection(config.projectId);
        const thread = await bb.sdk.threads.spawn({
          projectId: config.projectId,
          environment: freshEnvironment(await projectHost(config.projectId)),
          prompt: PROJECT_STEWARD_INTRO,
          title,
          ...modelArgs(config.file.projectSteward.model ?? null),
          ...(sectionId === null ? {} : { sectionId }),
          pluginMetadata: { role: "project", threadBriefs: PROJECT_BRIEFS },
        });
        tagged.add(thread.id);
        if (sectionId !== null) store.markPlaced(thread.id);
        store.patchProject(config.projectId, { threadId: thread.id, title });
        bb.log.info(`stewards: started the project steward for ${config.projectId} (${thread.id})`);
        threadId = thread.id;
      });
      return threadId;
    }

    /**
     * A steward is no thread's child. bb tells a parent every time a child
     * finishes a turn, and a steward's parent — the project steward, or the
     * parent ticket's steward — hears what it needs from the plugin instead:
     * escalations, and a child's status when it moves. The hierarchy lives in
     * the bindings. Stewards spawned before this were children; they are let
     * go here, once per run.
     */
    const kept = new Set<string>();
    async function keepSteward(projectId: string, threadId: string): Promise<void> {
      if (kept.has(threadId)) return;
      await tagThread(threadId, STEWARD_BRIEFS);
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return;
      const parent = info.parentThreadId;
      if (parent !== null && (store.byThread(parent) !== null || store.projectByThread(parent) !== null)) {
        try {
          await bb.sdk.threads.update({ threadId, parentThreadId: null });
        } catch (error) {
          bb.log.warn(`stewards: could not un-parent steward ${threadId}: ${errorMessage(error)}`);
          return;
        }
      }
      await placeOnce(projectId, info);
      kept.add(threadId);
    }

    async function spawnSteward(b: Binding, config: ProjectConfig, playbook: Playbook, prompt: string): Promise<string | null> {
      const projectThread = await ensureProjectSteward(config);
      // Stewards decide and delegate; they need no checkout of their own. They
      // share the project steward's environment, and workers get fresh ones.
      const env = projectThread === null ? null : (await threadInfo(projectThread))?.environmentId ?? null;
      const sectionId = await projectSection(b.projectId);
      const base = {
        projectId: b.projectId,
        ...(sectionId === null ? {} : { sectionId }),
        prompt,
        title: b.kind === "review" ? `Review ${b.entityKey}: ${b.title ?? ""}`.trim() : `${b.entityKey}: ${b.title ?? ""}`.trim(),
        ...modelArgs(stewardModel(b, playbook)),
        pluginMetadata: { role: "steward", bindingId: b.id, threadBriefs: STEWARD_BRIEFS },
      };
      let thread: { id: string };
      try {
        thread = await bb.sdk.threads.spawn({ ...base, environment: env === null ? freshEnvironment(await projectHost(b.projectId)) : { type: "reuse", environmentId: env } });
      } catch (error) {
        if (env === null) throw error;
        bb.log.warn(`stewards: could not share the project steward's environment for ${b.entityKey} (${errorMessage(error)}); giving it its own`);
        thread = await bb.sdk.threads.spawn({ ...base, environment: freshEnvironment(await projectHost(b.projectId)) });
      }
      tagged.add(thread.id);
      kept.add(thread.id);
      if (sectionId !== null) store.markPlaced(thread.id);
      store.patch(b.id, { threadId: thread.id });
      bb.log.info(`stewards: ${b.entityKey} is stewarded by thread ${thread.id}`);
      return thread.id;
    }

    // ---- the reconcile loop ------------------------------------------------------------------

    const ownThreads = (b: Binding) => new Set([b.threadId, ...store.workers(b.id).map((w) => w.threadId)].filter((t): t is string => t !== null));

    function routedTo(b: Binding): Array<{ escalation: Escalation; from: Binding }> {
      return store.children(b.id).flatMap((child) => store.openEscalations(child.id).filter((x) => x.route === "parent").map((escalation) => ({ escalation, from: child })));
    }

    /** Wake the steward, spawning its thread on the first wake. */
    async function wake(b: Binding, config: ProjectConfig, playbook: Playbook, observed: Observed, changes: string[], reason: WakeReason): Promise<void> {
      const gate = gateState(playbook, b.ready, specHash(observed.entity, b.threadId));
      const text = formatWake({
        reason,
        binding: b,
        playbook,
        observed,
        gate,
        escalations: store.openEscalations(b.id),
        routedToMe: routedTo(b),
        workers: store.workers(b.id),
        children: store.children(b.id).map((c) => ({ binding: c, openEscalations: store.openEscalations(c.id) })),
        workerFlags: [environmentFlags(await projectHost(b.projectId)), workerFlags(workerModel(b, playbook))].filter((f) => f !== "").join(" "),
        changes,
        own: ownThreads(b),
        label: config.file.label,
        now: now(),
      });
      if (b.threadId === null) {
        await spawnSteward(b, config, playbook, text);
      } else {
        const sent = await sendTo(b.threadId, text);
        if (sent === "gone") {
          // The user deleted the thread: that is a detach they meant.
          store.patch(b.id, { endedAt: now(), endReason: "deleted", manualDetach: true });
          pushInterest();
          return;
        }
        if (sent === "failed") return;
      }
      const cursor = newestCommentAt(observed);
      store.patch(b.id, {
        awaitingReport: true,
        wokeAt: now(),
        lastJudgmentAt: now(),
        commentCursor: cursor > b.commentCursor ? cursor : b.commentCursor,
        pending: [],
        archiveWhenIdle: false,
        // A fallback until the report names its own.
        requeueAt: now() + playbook.requeueDefaultMs,
      });
    }

    /**
     * One reconcile of one binding: snapshot, lifecycle, compare, and wake
     * when something actionable changed (or `force` says this is a turn
     * regardless: adoption, the nightly pass). A linked pull request that
     * appeared, closed or merged changes what is leased, so the interest set
     * is pushed again.
     */
    async function reconcileBinding(bindingId: string, force: WakeReason | null): Promise<void> {
      const before = store.binding(bindingId);
      const leased = before === null ? "" : leasedPulls(before).join(" ");
      try {
        await reconcileOnce(bindingId, force);
      } finally {
        const after = store.binding(bindingId);
        if (after !== null && leasedPulls(after).join(" ") !== leased) pushInterest();
      }
    }

    async function reconcileOnce(bindingId: string, force: WakeReason | null): Promise<void> {
      let b = store.binding(bindingId);
      if (b === null) return;
      const config = await loadConfig(b.projectId);
      if (config === null) return;
      const playbook = playbookFor(config, b.kind);
      if (playbook === null) return;

      let entity: EntitySnapshot | null;
      try {
        entity = await snapshot(b.source, b.entityId);
      } catch (error) {
        bb.log.warn(`stewards: could not read ${b.entityKey}: ${errorMessage(error)}`);
        return;
      }
      if (entity === null) {
        if (b.endedAt === null) await finishEnding(b, "gone");
        return;
      }
      const observed: Observed = { entity, pulls: b.kind === "ticket" ? await linkedPulls(entity) : [] };
      const prev = b.lastSnapshot;

      const life = lifecycle(b, playbook, entity, config.file.label);
      let reason: WakeReason | null = force;
      if (life.kind === "stay-ended") {
        const labelled = b.kind === "review" || hasLabel(entity, config.file.label);
        store.patch(b.id, { lastSnapshot: observed, ...(b.manualDetach && !labelled ? { manualDetach: false } : {}) });
        return;
      }
      if (life.kind === "reopen") {
        b = await reopen(b, life.why);
        reason = "reopen";
      }
      if (life.kind === "terminal" || life.kind === "detach") {
        if (b.ending === null) {
          await beginEnding(b, config, playbook, life.kind, observed);
          return;
        }
        // Following through, the steward is woken as before; otherwise its
        // one last turn is under way and there is nothing to add to it.
        if (life.kind !== "terminal" || !followingThrough(b)) {
          store.patch(b.id, { lastSnapshot: observed });
          return;
        }
        if (b.followThroughUntil !== null && now() >= b.followThroughUntil) {
          await followThroughRanOut(b);
          return;
        }
      } else if (b.ending !== null) {
        store.patch(b.id, { lastSnapshot: observed });
        return;
      }

      const { phase, stage } = phaseAndStage(playbook, entity.state);
      const currentSpec = specHash(entity, b.threadId);
      const changes: Change[] = [];
      let ready = b.ready;
      const approval = playbook.ready?.approval;
      if (typeof approval === "object" && lc(entity.state) === lc(approval["linear-state"]) && ready.approval === null) {
        ready = { ...ready, approval: { at: now(), specHash: currentSpec, by: "linear" }, voidedAt: null };
        changes.push({ text: `Approved in Linear (now ${entity.state})`, actionable: true });
      }
      const workerRunning = store.workers(b.id).some((w) => w.status === "running");
      const fresh = prev === null ? [] : diffObserved(prev, observed, { own: ownThreads(b), stewardThreadId: b.threadId, approved: ready.approval !== null, cursor: b.commentCursor, workerRunning });
      changes.push(...fresh);
      const gate = gateState(playbook, ready, currentSpec);
      if (stage === "build" && b.stage !== "build" && !gate.passed && prev !== null) {
        changes.push({ text: `Moved into a build stage (${entity.state}) before the ready gate passed`, actionable: true });
      }
      if (b.requeueAt !== null && b.requeueAt <= now()) changes.push({ text: "Requeue time came", actionable: true });
      if (b.playbookVersion !== playbook.version) changes.push({ text: `Playbook ${playbook.name} updated (${b.playbookVersion} → ${playbook.version})`, actionable: false });
      // A note queued while the steward was busy, or kept quiet, can say what
      // this comparison says again. Comment news is counted from the cursor,
      // which only a wake moves, so the comparison's count is the current one
      // and a queued count is stale; anything else is kept once, and is
      // actionable if either says so.
      const queued = b.pending;
      const loudQueued = queued.filter((n) => n.quiet !== true).length;
      for (const n of queued) {
        if (isCommentNews(n.text)) continue;
        const same = changes.find((c) => c.text === n.text);
        if (same !== undefined) same.actionable ||= n.quiet !== true;
        else changes.push({ text: n.text, actionable: n.quiet !== true });
      }

      b = store.patch(b.id, { lastSnapshot: observed, phase, stage, title: entity.title, url: entity.url, entityKey: entity.key, playbookVersion: playbook.version, ready });
      /**
       * Keep news for the next turn: what is actionable as a reason for it, the
       * rest as quiet notes. A quiet comment count is not kept: the next wake
       * counts from the cursor again.
       */
      const keep = (which: Change[]) => {
        for (const c of which) {
          if (!c.actionable && isCommentNews(c.text)) continue;
          if (!queued.some((n) => n.text === c.text && (n.quiet === true) === !c.actionable)) store.note(b.id, c.text, !c.actionable);
        }
      };
      await toldWhileWithUser(b, fresh);
      const due = reason !== null || changes.some((c) => c.actionable);
      if (!due) {
        // Nothing for a turn now; the steward hears it with the next one.
        keep(changes);
        // No turn is coming to report the gate, so look at it here: a gate
        // left waiting on its approver (a report from before this check, a
        // request declined, then the spec changed) is asked for now.
        if (!b.awaitingReport && (await syncApprovalRequest(b, playbook)) !== null) await wakeProject(b.projectId, `approval requested for ${b.entityKey}`, { digestDue: false });
        return;
      }
      const lines = [...new Set(changes.map((c) => c.text))];

      // Not now: keep the news as notes, delivered at the next turn. A held
      // binding still hears from its people (guidance, approvals, lifecycle).
      const deferred = (await settings.get()).paused || (b.hold !== null && reason === null && loudQueued === 0);
      const info = b.threadId === null ? null : await threadInfo(b.threadId);
      if (deferred || (info !== null && busy(info.status))) {
        keep(changes);
        if (reason !== null && reason !== "changed") store.note(b.id, `Due: ${reason}`);
        return;
      }
      await wake(b, config, playbook, observed, lines, reason ?? (followingThrough(b) ? "follow-through" : b.requeueAt !== null && b.requeueAt <= now() && loudQueued === 0 ? "requeue" : "changed"));
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    async function stopWorkers(b: Binding): Promise<void> {
      for (const w of store.workers(b.id)) {
        if (w.status !== "running") continue;
        store.setWorker(w.threadId, "stopped", w.result);
        await quietly(`stop worker ${w.threadId}`, () => bb.sdk.threads.stop({ threadId: w.threadId }));
      }
    }

    /**
     * The one wrap-up (terminal) or stop (detach) turn before the binding
     * ends. A detach stops the workers now: someone took the label off. A
     * terminal state leaves them running through the wrap-up turn, in which
     * the steward may keep the binding open to follow through (a deploy to
     * watch, production to verify); they are stopped when it ends.
     */
    async function beginEnding(b: Binding, config: ProjectConfig, playbook: Playbook, kind: "terminal" | "detach", observed: Observed): Promise<void> {
      b = store.patch(b.id, { ending: kind, endingAt: now(), followThrough: null, followThroughUntil: null, lastSnapshot: observed });
      if (kind === "detach") await stopWorkers(b);
      bb.log.info(`stewards: ${b.entityKey} ${kind === "terminal" ? `reached ${observed.entity.state}` : "was detached"}; one last turn`);
      if (b.threadId === null) {
        await finishEnding(b, kind);
        return;
      }
      const info = await threadInfo(b.threadId);
      if (info === null || info.deletedAt !== null) {
        await finishEnding(b, kind);
        return;
      }
      await wake(b, config, playbook, observed, [kind === "terminal" ? `Terminal: ${observed.entity.state}` : `The ${config.file.label} label was removed`], kind);
    }

    /**
     * End the binding, archive its thread, and hand its children to the next
     * ancestor. Its last turn said the work is done; workers are archived with
     * it, as their lifecycle owner. thread-briefs is asked not to archive
     * stewards, because between wakes a steward reads done while its entity
     * is still open. A thread still running (an ending that timed out) is left
     * in the sidebar rather than archived mid-turn.
     */
    async function finishEnding(b: Binding, reason: string): Promise<void> {
      b = store.patch(b.id, { ending: null, endingAt: null, followThrough: null, followThroughUntil: null, endedAt: now(), endReason: reason, awaitingReport: false, requeueAt: null });
      for (const x of store.openEscalations(b.id)) store.resolve(x.id, "The binding ended.");
      await stopWorkers(b);
      const info = b.threadId === null ? null : await threadInfo(b.threadId).catch(() => null);
      if (info !== null && info.deletedAt === null && info.archivedAt === null && !busy(info.status)) {
        await quietly(`archive ${b.entityKey}'s steward`, () => bb.sdk.threads.archive({ threadId: info.id }));
      }
      // Parent ends first: promoted children still open move up a level.
      const up = b.parentBindingId === null ? null : store.binding(b.parentBindingId);
      const next = up !== null && up.endedAt === null ? up : null;
      for (const child of store.children(b.id)) {
        store.patch(child.id, { parentBindingId: next?.id ?? null });
        store.note(child.id, `Your parent ${b.entityKey} ended (${reason}); you now report to ${next === null ? "the project steward" : next.entityKey}.`);
      }
      bb.log.info(`stewards: ${b.entityKey} ended (${reason})`);
      pushInterest();
    }

    async function reopen(b: Binding, why: string): Promise<Binding> {
      // The wake that follows brings the thread back if it was archived meanwhile.
      b = store.patch(b.id, { endedAt: null, endReason: null, ending: null, endingAt: null, followThrough: null, followThroughUntil: null, awaitingReport: false, missedReports: 0 });
      bb.log.info(`stewards: ${b.entityKey} resumed (${why})`);
      pushInterest();
      return store.note(b.id, why);
    }

    /**
     * The playbook's cap on follow-through came before the steward said it
     * was done. The binding ends as any terminal one does, and the project
     * steward hears what was left, since nobody else will.
     */
    async function followThroughRanOut(b: Binding): Promise<void> {
      const what = b.followThrough ?? "(not said)";
      const stopped = store.workers(b.id).filter((w) => w.status === "running").map((w) => w.title);
      bb.log.warn(`stewards: ${b.entityKey}'s follow-through ran out (${what})`);
      await finishEnding(b, "terminal");
      await wakeProject(b.projectId, `follow-through ran out on ${b.entityKey}`, {
        digestDue: false,
        notes: [
          `${b.entityKey} reached a terminal state and its steward kept it open to follow through: ${JSON.stringify(what)}. That ran out before the steward said it was done, so the binding ended${stopped.length > 0 ? ` and these workers were stopped: ${stopped.join("; ")}` : ""}.`,
          "Decide from the project's guidance whether the work needs finishing. Reopening the entity resumes its steward; do not do a steward's work yourself.",
        ],
      });
    }

    // ---- adoption ------------------------------------------------------------------------------

    const projectFor = (configs: ProjectConfig[], entity: Pick<EntitySnapshot, "source" | "unit">) =>
      configs.find((c) => (entity.source === "linear" ? c.file.linear.teams.includes(entity.unit.toUpperCase()) : c.repos.some((r) => lc(r) === lc(entity.unit)))) ?? null;

    /** Which kind of binding an entity wants in this project, or null for none. */
    function adoptionKind(config: ProjectConfig, e: { source: Source; kind: "issue" | "pull"; state: string; labels: string[]; author: string | null; draft: boolean }, viewer: string | null): BindingKind | null {
      const labelled = e.labels.some((l) => lc(l) === lc(config.file.label));
      if (e.source === "linear") {
        const playbook = playbookFor(config, "ticket");
        return labelled && playbook !== null && !isTerminal(playbook, e.state) ? "ticket" : null;
      }
      if (e.kind !== "pull") return null;
      if (labelled) {
        const playbook = playbookFor(config, "pr");
        return playbook !== null && !isTerminal(playbook, e.state) ? "pr" : null;
      }
      const review = playbookFor(config, "review");
      if (review === null || !config.file.reviews.enabled || e.draft || e.state !== "open") return null;
      if (e.author === null || viewer === null || lc(e.author) === lc(viewer)) return null;
      if (review.skipAuthors.some((a) => lc(a) === lc(e.author))) return null;
      return "review";
    }

    /** The nearest bound ancestor of a Linear issue, walking up a few parents. */
    async function managedAncestor(entity: EntitySnapshot): Promise<Binding | null> {
      let parent = entity.parent;
      for (let depth = 0; parent !== null && depth < 5; depth++) {
        const bound = store.byEntity("linear", parent.id);
        if (bound !== null && bound.endedAt === null) return bound;
        const snap = await snapshot("linear", parent.id).catch(() => null);
        parent = snap?.parent ?? null;
      }
      return null;
    }

    /** Adopt an entity if it should be. Returns the new binding, or null. */
    async function maybeAdopt(entity: EntitySnapshot, projects: ProjectConfig[]): Promise<Binding | null> {
      if ((await settings.get()).paused) return null;
      const config = projectFor(projects, entity);
      if (config === null) return null;
      if (store.byEntity(entity.source, entity.id) !== null) return null;
      const kind = adoptionKind(config, { ...entity, draft: entity.pull?.draft ?? false }, entity.viewer);
      if (kind === null) return null;
      const playbook = playbookFor(config, kind)!;
      const parent = kind === "ticket" ? await managedAncestor(entity) : null;
      const { phase, stage } = phaseAndStage(playbook, entity.state);
      let b: Binding;
      try {
        b = store.create({
          projectId: config.projectId,
          source: entity.source,
          entityId: entity.id,
          entityKey: entity.key,
          url: entity.url,
          title: entity.title,
          kind,
          playbook: playbook.name,
          playbookVersion: playbook.version,
          parentBindingId: parent?.id ?? null,
          phase,
          stage,
        });
      } catch {
        return null; // adopted concurrently
      }
      bb.log.info(`stewards: adopted ${entity.key} as a ${kind} binding (${playbook.name})`);
      if (parent !== null) {
        store.note(parent.id, `Sub-issue ${entity.key} was promoted and has its own steward now.`);
        scheduleReconcile(parent.id);
      }
      await serial(`b:${b.id}`, () => reconcileBinding(b.id, "adopted"));
      pushInterest();
      return b;
    }

    /** A ring from a source: look at the binding(s) it concerns, or consider adopting. */
    async function onRing(source: Source, id: string): Promise<void> {
      const bound = store.byEntity(source, id);
      if (bound !== null) scheduleReconcile(bound.id);
      if (source === "github") {
        for (const t of store.open()) {
          if (t.kind === "ticket" && (t.lastSnapshot?.entity.linkedPulls ?? []).some((l) => lc(l.key) === lc(id))) scheduleReconcile(t.id);
        }
      }
      if (bound !== null) return;
      const projects = await stewardedProjects();
      if (projects.length === 0) return;
      const entity = await snapshot(source, id);
      if (entity === null) return;
      await maybeAdopt(entity, projects);
    }

    /**
     * The nightly backstop for adoption: everything adoptable that has no
     * binding, oldest first, at most `perPass` per project per pass so
     * turning stewards on does not start every steward at once.
     */
    async function adoptionPass(config: ProjectConfig): Promise<number> {
      const candidates: Array<{ source: Source; id: string; createdAt: string }> = [];
      const ask = async (source: Source, units: string[]) => {
        if (units.length === 0) return;
        try {
          const out = await sourceRpc(source, "sourceAdoptable", { units, label: config.file.label, limit: 300 }, sourceContract.sourceAdoptable.output);
          for (const e of out.errors) bb.log.warn(`stewards: ${source} adoption list: ${e}`);
          for (const e of out.entities) {
            if (store.byEntity(source, e.id) !== null) continue;
            if (adoptionKind(config, { source, ...e }, out.viewer) === null) continue;
            candidates.push({ source, id: e.id, createdAt: e.createdAt ?? "" });
          }
        } catch (error) {
          bb.log.warn(`stewards: could not list adoptable ${source} entities: ${errorMessage(error)}`);
        }
      };
      await ask("linear", config.file.linear.teams);
      await ask("github", config.repos);
      candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let adopted = 0;
      for (const c of candidates) {
        if (adopted >= config.file.adoption.perPass) break;
        const entity = await snapshot(c.source, c.id).catch(() => null);
        if (entity !== null && (await maybeAdopt(entity, [config])) !== null) adopted++;
      }
      return adopted;
    }

    // ---- escalations -----------------------------------------------------------------------------
    //
    // Up the tree: the parent steward, then the project steward, which
    // decides from the project's guidance and forwards to the user only what
    // the project file calls a big decision. A forward to the user is the
    // project steward asking them in its own thread; thread-briefs shows that
    // thread as waiting on them, so nothing here asks for attention itself.

    async function wakeProject(projectId: string, reason: string, opts: { digestDue: boolean; notes?: string[] }): Promise<void> {
      const config = await loadConfig(projectId);
      if (config === null) return;
      const threadId = await ensureProjectSteward(config);
      if (threadId === null) return;
      const records = opts.digestDue ? digestRecords(projectId) : undefined;
      if (opts.digestDue) store.patchProject(projectId, { digestPending: true });
      // Read as of the send, so an escalation resolved meanwhile is left out,
      // and marked delivered in the same step, so a prompt sent right after
      // lists it as still open rather than new. The text is built before the
      // mark, so a throw while building it leaves nothing marked.
      const delivered = { ids: [] as string[], at: 0 };
      const sent = await sendTo(threadId, () => {
        const open = store.open(projectId);
        const routed = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "project").map((escalation) => ({ escalation, from: b })));
        const withUser = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "me" && x.kind !== "approval").map((escalation) => ({ escalation, from: b })));
        const bindings = open.map((binding) => ({ binding, openEscalations: store.openEscalations(binding.id) }));
        const questions = store.openQuestions(projectId).map((question) => ({ question, about: question.bindingId === null ? null : store.binding(question.bindingId) }));
        const text = formatProjectWake({ reason, bindings, routed, withUser, problems: config.problems, digestDue: opts.digestDue, notes: opts.notes ?? [], bigDecisions: config.file.bigDecisions, questions, timeZone: config.file.nightly.timezone, ...(records === undefined ? {} : { records }) });
        delivered.ids = routed.filter((r) => r.escalation.deliveredAt === null).map((r) => r.escalation.id);
        delivered.at = store.markDelivered(delivered.ids);
        return text;
      });
      if (sent !== "sent") store.undeliver(delivered.ids, delivered.at);
    }

    /** What the digest is written from, since the last one (or a day back): read from the tables, never from the project steward's memory. */
    function digestRecords(projectId: string): DigestRecords {
      const row = store.project(projectId);
      const since = row.digestAt ?? now() - 86_400_000;
      const all = store.all(projectId);
      const open = all.filter((b) => b.endedAt === null);
      const openWith = (pick: (x: Escalation) => boolean) => open.flatMap((b) => store.openEscalations(b.id).filter(pick).map((escalation) => ({ escalation, from: b })));
      return {
        previous: row.digest === null ? null : { text: row.digest, at: row.digestAt ?? 0 },
        since,
        moved: open.filter((b) => b.advancedAt !== null && b.advancedAt >= since),
        ended: all.filter((b) => b.endedAt !== null && b.endedAt >= since),
        answered: store.answeredSince(projectId, since),
        withUser: openWith((x) => x.route === "me"),
        stuck: openWith((x) => x.kind === "stuck"),
        held: open.filter((b) => b.hold !== null),
      };
    }

    /** Where an escalation goes next, above where it is. */
    function nextRoute(b: Binding, from: EscalationRoute | null): EscalationRoute {
      if (from === null) {
        const parent = b.parentBindingId === null ? null : store.binding(b.parentBindingId);
        return parent !== null && parent.endedAt === null && parent.threadId !== null ? "parent" : "project";
      }
      if (from === "parent") return "project";
      return "me";
    }

    async function deliver(b: Binding, x: Escalation): Promise<void> {
      if (x.route === "me") return;
      if (x.route === "parent" && b.parentBindingId !== null) {
        store.note(b.parentBindingId, `Escalation ${x.id} from ${b.entityKey} (${x.kind}): ${x.question}`);
        scheduleReconcile(b.parentBindingId);
        return;
      }
      await wakeProject(b.projectId, `escalation from ${b.entityKey}`, { digestDue: false });
    }

    /**
     * Keep the gate's approval request in step with the gate. While the
     * checklist is met, the ticket is substantial and the current spec has
     * no approval, one `approval` escalation is open with the approver: the
     * project steward, or the user with `approval: me`. It is the plugin's,
     * so the approver hears whatever the steward wrote, and it closes itself
     * once the gate passes or no longer needs an approval. A request the
     * approver declined (guidance + resolve) is not made again until the
     * spec changes. A Linear-state approval is the steward's to wait for.
     *
     * Returns a request just filed with the project steward, for the caller
     * to wake it, once, with whatever else it has to say.
     */
    async function syncApprovalRequest(b: Binding, playbook: Playbook): Promise<Escalation | null> {
      const mode = playbook.ready?.approval ?? null;
      if (mode === null || typeof mode === "object" || b.lastSnapshot === null) return null;
      const open = store.openEscalations(b.id).filter((x) => x.kind === "approval");
      const current = specHash(b.lastSnapshot.entity, b.threadId);
      const gate = gateState(playbook, b.ready, current);
      const wanted = approvalWanted(gate) && b.endedAt === null && b.ending === null && b.ready.declinedSpecHash !== current;
      if (!wanted) {
        const why = gate.passed ? "The spec is approved." : !gate.checklistMet ? "Withdrawn: the ready checklist is no longer met." : !gate.approvalNeeded ? "Withdrawn: the ticket is not substantial." : "Withdrawn.";
        for (const x of open) store.resolve(x.id, why);
        return null;
      }
      if (open.length > 0) return null;
      const by = mode === "project" ? "the project steward" : "the user";
      const x = store.escalate({
        bindingId: b.id,
        kind: "approval",
        question:
          `Approve ${b.entityKey}'s spec${b.title === null ? "" : ` (${b.title})`}? The ready checklist is met and the ticket is ${b.ready.substantial === null ? "not yet judged, so treated as substantial" : "substantial"}${b.ready.why === null ? "" : ` (${b.ready.why})`}; ` +
          (gate.approvalStale ? "the spec has changed since its last approval." : "the current spec has no approval."),
        meanwhile: "Waiting: no implementation workers start until it is approved.",
        route: mode === "project" ? "project" : "me",
        recommendation: null,
      });
      bb.log.info(`stewards: ${b.entityKey}'s ready gate waits on ${by}; asked for approval (${x.id})`);
      return x.route === "project" ? x : null;
    }

    /**
     * The bound entity changed while one of its escalations is with the user:
     * they may have answered on the entity (rewritten the description,
     * commented, moved it) rather than in the project steward's thread. The
     * steward hears the change as usual, but only the project steward holds
     * the escalation, so it is told too, to resolve it or leave it open.
     */
    async function toldWhileWithUser(b: Binding, fresh: Change[]): Promise<void> {
      const withUser = store.openEscalations(b.id).filter((x) => x.route === "me" && x.kind !== "approval");
      const news = fresh.filter((c) => c.actionable && c.own !== true);
      if (withUser.length === 0 || news.length === 0 || (await settings.get()).paused) return;
      await wakeProject(b.projectId, `${b.entityKey} changed while the user has its escalation`, {
        digestDue: false,
        notes: [
          `What changed on ${b.entityKey}${b.url === null ? "" : ` (${b.url})`}: ${[...new Set(news.map((c) => c.text))].join("; ")}.`,
          ...withUser.map((x) => `Escalation ${x.id} (${x.kind}) is with the user: ${x.question}`),
          `The user may have answered on the entity instead of here. Read the change (\`bb stewards show ${b.entityKey}\`, or the entity itself). If it answers an escalation, record that with steward_update { binding, guidance, resolve }, which wakes the steward; if it does not, leave the escalation open and do not ask the user again.`,
        ],
      });
    }

    async function raise(b: Binding, kind: EscalationKind, question: string, meanwhile: string): Promise<Escalation> {
      const x = store.escalate({ bindingId: b.id, kind, question, meanwhile, route: nextRoute(b, null), recommendation: null });
      await deliver(b, x);
      return x;
    }

    // ---- thread events ---------------------------------------------------------------------------
    //
    // Workers are started by stewards with `bb thread spawn --parent-self`, so
    // they are recognized here, as children of a steward thread, rather than
    // through a tool of their own.

    bb.events.on("thread.created", async ({ thread }) => {
      // Stewards this plugin spawned (a promoted child under its parent) are not workers.
      if (thread.originPluginId === bb.pluginId) return;
      const owner = [thread.lifecycleOwnerThreadId, thread.parentThreadId].map((t) => (t === null ? null : store.byThread(t))).find((b) => b !== null && b !== undefined && b.endedAt === null);
      if (owner === undefined || owner === null || store.worker(thread.id) !== null) return;
      const limit = (await settings.get()).workerSpawnsPerHour;
      const runaway = store.spawnsSince(owner.id, now() - 3_600_000) >= limit;
      store.addWorker(thread.id, owner.id, thread.title ?? thread.titleFallback ?? thread.id);
      if (!runaway) return;
      // The runaway guard: not a budget, a stop for a looping steward.
      store.setWorker(thread.id, "stopped", null);
      await quietly(`stop runaway worker ${thread.id}`, () => bb.sdk.threads.stop({ threadId: thread.id }));
      bb.log.warn(`stewards: ${owner.entityKey} started more than ${limit} workers in an hour; stopped ${thread.id}`);
      store.note(owner.id, `Runaway guard: more than ${limit} workers in the last hour, so worker ${thread.id} was stopped. If something is looping, stop and escalate.`);
      scheduleReconcile(owner.id);
    });

    bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
      const worker = store.worker(thread.id);
      if (worker !== null) {
        if (worker.status === "stopped") return;
        store.setWorker(thread.id, "finished", lastAssistantText === null ? null : clip(lastAssistantText, 4000));
        const b = store.binding(worker.bindingId);
        if (b === null || b.endedAt !== null) return;
        store.note(b.id, `Worker "${worker.title}" finished its turn.`);
        scheduleReconcile(b.id);
        return;
      }
      const project = store.projectByThread(thread.id);
      if (project !== null) {
        // The digest is the project steward's reply to the nightly wake.
        if (project.digestPending && lastAssistantText !== null && lastAssistantText.trim() !== "") {
          store.patchProject(project.projectId, { digest: clip(lastAssistantText.trim(), 20_000), digestAt: now(), digestPending: false });
        }
        await compactIfLarge(thread.id);
        return;
      }
      const b = store.byThread(thread.id);
      if (b === null || b.endedAt !== null) return;
      if (b.ending !== null) {
        // A steward following through ends when a turn finishes without
        // saying something still remains, or without reporting at all.
        if (followingThrough(b) && !b.awaitingReport) {
          await compactIfLarge(thread.id);
          if (store.binding(b.id)!.pending.some((n) => n.quiet !== true)) scheduleReconcile(b.id);
          return;
        }
        await serial(`b:${b.id}`, () => finishEnding(store.binding(b.id)!, b.ending!));
        return;
      }
      if (b.awaitingReport) {
        const missed = b.missedReports + 1;
        store.patch(b.id, { awaitingReport: false, missedReports: missed });
        bb.log.warn(`stewards: ${b.entityKey}'s turn ended without steward_report (${missed} in a row)`);
        if (missed >= timing.missedReportsForStuck && !store.openEscalations(b.id).some((x) => x.kind === "stuck")) {
          await raise(b, "stuck", `The steward ended ${missed} turns in a row without a status report. Look at the thread and say how to continue.`, "Waiting.");
        }
      }
      // Compaction makes the thread busy; a wake that finds it so waits as notes for the next idle.
      const compacting = await compactIfLarge(thread.id);
      const after = store.binding(b.id)!;
      if (after.pending.some((n) => n.quiet !== true)) scheduleReconcile(b.id);
      // Compaction ends in another idle, which archives.
      else if (after.archiveWhenIdle && !compacting) await archiveWaiting(after);
    });

    /**
     * Archive a steward whose wake turn ended waiting on someone else, so the
     * sidebar holds only stewards with something to do. Its binding stays:
     * the next wake brings it back (sendTo). Not while a worker runs or an
     * escalation is open, which the user should still see.
     */
    async function archiveWaiting(b: Binding): Promise<void> {
      store.patch(b.id, { archiveWhenIdle: false });
      if (b.threadId === null || b.endedAt !== null || b.ending !== null) return;
      if (store.workers(b.id).some((w) => w.status === "running") || store.openEscalations(b.id).length > 0) return;
      const info = await threadInfo(b.threadId).catch(() => null);
      if (info === null || info.deletedAt !== null || info.archivedAt !== null || busy(info.status)) return;
      await quietly(`archive ${b.entityKey}'s waiting steward`, () => bb.sdk.threads.archive({ threadId: info.id }));
      bb.log.info(`stewards: ${b.entityKey} waits on others; archived its steward until the next wake`);
    }

    /**
     * Compact a steward's context once it has grown past the setting, while it
     * is idle. Every wake carries what the steward needs (DESIGN.md §6), so
     * its transcript can go; without this a steward's context only grows, and
     * every later turn reads all of it. A reading already compacted on is not
     * acted on twice, should the provider not report a new one.
     */
    const compactedOn = new Map<string, number>();
    async function compactIfLarge(threadId: string): Promise<boolean> {
      const limit = (await settings.get()).compactAboveTokens;
      if (!(limit > 0)) return false;
      try {
        const [usage] = await bb.sdk.threads.events.list({ threadId, types: ["thread/contextWindowUsage/updated"], order: "desc", limit: "1" });
        const used = (usage?.data as { contextWindowUsage?: { usedTokens?: number | null } } | undefined)?.contextWindowUsage?.usedTokens ?? null;
        if (used === null || used <= limit || compactedOn.get(threadId) === used) return false;
        compactedOn.set(threadId, used);
        await bb.sdk.threads.compact({ threadId });
        bb.log.info(`stewards: compacted ${threadId} at ${used} context tokens`);
        return true;
      } catch (error) {
        bb.log.warn(`stewards: could not compact ${threadId}: ${errorMessage(error)}`);
        return false;
      }
    }

    // A worker that ended its turn to wait (on a watch, a reviewer) is
    // running again when that wakes it; it is working its pull request.
    bb.events.on("thread.active", ({ thread }) => {
      const worker = store.worker(thread.id);
      if (worker !== null && worker.status === "finished") store.setWorker(thread.id, "running", worker.result);
    });

    bb.events.on("thread.failed", ({ thread, error }) => {
      const worker = store.worker(thread.id);
      if (worker === null || worker.status !== "running") return;
      store.setWorker(thread.id, "failed", error);
      store.note(worker.bindingId, `Worker "${worker.title}" failed: ${error ?? "no detail"}`);
      scheduleReconcile(worker.bindingId);
    });

    // An archived steward is still bound: a wake brings it back, whoever
    // archived it. Only a deleted steward thread
    // ends its binding: someone meant it, and the label staying on does not
    // bring it back until it is removed and re-added.
    bb.events.on("thread.archived", ({ thread }) => {
      const worker = store.worker(thread.id);
      if (worker !== null && worker.status === "running") store.setWorker(thread.id, "stopped", worker.result);
    });
    bb.events.on("thread.deleted", ({ thread }) => {
      const worker = store.worker(thread.id);
      if (worker !== null && worker.status === "running") store.setWorker(thread.id, "stopped", worker.result);
      const b = store.byThread(thread.id);
      if (b === null || b.endedAt !== null) return;
      store.patch(b.id, { threadId: null, endedAt: now(), endReason: "deleted", manualDetach: true, awaitingReport: false, ending: null });
      for (const x of store.openEscalations(b.id)) store.resolve(x.id, "The steward was deleted.");
      bb.log.info(`stewards: ${b.entityKey}'s steward was deleted; detached`);
      pushInterest();
    });

    // ---- the RPC -------------------------------------------------------------------------------------

    bb.rpc.register(rpcContract, {
      async stewardsRing({ source, id }, { experimental_caller: caller }) {
        if (caller.kind !== "plugin" || caller.pluginId !== SOURCE_PLUGIN_IDS[source]) throw new Error("only the linear and github-watcher plugins ring stewards, each for its own source");
        debounce(`ring:${source}:${lc(id)}`, () => serial(`ring:${source}:${lc(id)}`, () => onRing(source, id)));
        return { ok: true };
      },
      async stewardsList({ projectId, all }) {
        const rows = all ? store.all(projectId ?? undefined) : store.open(projectId ?? undefined);
        return {
          bindings: rows.map((b) => ({
            id: b.id,
            projectId: b.projectId,
            key: b.entityKey,
            kind: b.kind,
            phase: b.phase,
            threadId: b.threadId,
            summary: b.status?.summary ?? null,
            nextAction: b.status?.nextAction ?? null,
            actor: b.status?.actor ?? null,
            escalations: store.openEscalations(b.id).length,
            ended: b.endedAt !== null,
          })),
        };
      },
      async stewardsOverview() {
        const named = new Map((await bb.sdk.projects.list()).map((p) => [p.id, p.name] as const));
        const configsById = new Map((await stewardedProjects()).map((c) => [c.projectId, c] as const));
        const ids = projectIds(configsById.keys());
        const projects = ids.map((projectId) => {
          const config = configsById.get(projectId) ?? null;
          const row = store.project(projectId);
          const bindings = store.all(projectId);
          const open = bindings.filter((b) => b.endedAt === null);
          return {
            projectId,
            name: named.get(projectId) ?? projectId,
            configured: config !== null,
            label: config?.file.label ?? null,
            linearTeams: config?.file.linear.teams ?? [],
            repos: config?.repos ?? [],
            excludedRepos: config?.file.github.exclude ?? [],
            playbooks:
              config === null
                ? []
                : KINDS.filter((k) => k !== "review" || config.file.reviews.enabled).map((kind) => ({ kind, name: playbookNameFor(config.file, kind), version: config.playbooks[kind]?.version ?? null })),
            problems: config?.problems ?? [],
            nightly: config === null ? null : { at: config.file.nightly.at, timezone: config.file.nightly.timezone },
            lastNight: row.nightlyDate,
            projectStewardThreadId: row.threadId,
            digestAt: row.digestAt,
            endedCount: bindings.length - open.length,
            stewards: open.map((b) => ({
              key: b.entityKey,
              url: b.url,
              title: b.title,
              kind: b.kind,
              phase: b.phase,
              threadId: b.threadId,
              summary: b.status?.summary ?? null,
              nextAction: b.status?.nextAction ?? null,
              actor: b.status?.actor ?? null,
              blockedOn: b.status?.blockedOn ?? null,
              priority: b.priority,
              hold: b.hold,
              ending: b.ending,
              statusAt: b.statusAt,
              createdAt: b.createdAt,
              workers: store.workers(b.id).filter((w) => w.status === "running").length,
              escalations: store.openEscalations(b.id).map((x) => ({ kind: x.kind, route: x.route, question: x.question })),
            })),
          };
        });
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return { paused: (await settings.get()).paused, lastSweepAt, projects };
      },
      async stewardsCheck({ projectId }) {
        return check(projectId);
      },
      async stewardsBoard({ projectId: wanted }) {
        const named = new Map((await bb.sdk.projects.list()).map((p) => [p.id, p.name] as const));
        const projects = projectIds((await stewardedProjects()).map((c) => c.projectId))
          .map((projectId) => ({ projectId, name: named.get(projectId) ?? projectId }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const picked = projects.find((p) => p.projectId === wanted) ?? (wanted === null ? projects[0] : undefined);
        if (picked === undefined) return { projects, board: null };
        const { projectId } = picked;
        const row = store.project(projectId);
        const all = store.all(projectId);
        const open = all.filter((b) => b.endedAt === null);
        const questions = store.openQuestions(projectId);
        const asked = new Set(questions.map((q) => q.escalationId).filter((id) => id !== null));
        const withUser = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "me" && !asked.has(x.id)).map((x) => ({ x, b })));
        const stuck = open.flatMap((b) => [
          ...store.openEscalations(b.id).filter((x) => x.kind === "stuck").map((x) => ({ b, why: `Stuck, with ${x.route === "me" ? "you" : x.route === "parent" ? "the parent steward" : "the project steward"}: ${x.question}`, since: x.createdAt })),
          ...(b.hold === null ? [] : [{ b, why: `On hold: ${b.hold}`, since: null }]),
        ]);
        const ended = all.filter((b) => b.endedAt !== null && b.endedAt >= now() - ENDED_ON_BOARD_MS).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, 30);
        return {
          projects,
          board: {
            projectId,
            name: picked.name,
            paused: (await settings.get()).paused,
            projectStewardThreadId: row.threadId,
            stages: [...STAGES],
            digest: row.digest === null ? null : { text: row.digest, at: row.digestAt ?? 0 },
            questions: questions.map((q) => {
              const b = q.bindingId === null ? null : store.binding(q.bindingId);
              return { id: q.id, question: q.question, context: q.context, key: b?.entityKey ?? null, url: b?.url ?? null, escalationId: q.escalationId, createdAt: q.createdAt };
            }),
            withUser: withUser.map(({ x, b }) => ({ id: x.id, kind: x.kind, question: x.question, recommendation: x.recommendation, key: b.entityKey, url: b.url, threadId: b.threadId, createdAt: x.createdAt })),
            stewards: open.map((b) => ({
              key: b.entityKey,
              url: b.url,
              title: b.title,
              kind: b.kind,
              phase: b.phase,
              stage: b.stage,
              threadId: b.threadId,
              summary: b.status?.summary ?? null,
              nextAction: b.status?.nextAction ?? null,
              actor: b.status?.actor ?? null,
              blockedOn: b.status?.blockedOn ?? null,
              priority: b.priority,
              ending: b.ending,
              advancedAt: b.advancedAt,
              workers: store.workers(b.id).filter((w) => w.status === "running").map((w) => ({ threadId: w.threadId, title: w.title })),
            })),
            stuck: stuck.map(({ b, why, since }) => ({ key: b.entityKey, url: b.url, threadId: b.threadId, why, since })),
            ended: ended.map((b) => ({ key: b.entityKey, url: b.url, title: b.title, kind: b.kind, endReason: b.endReason, endedAt: b.endedAt!, threadId: b.threadId })),
          },
        };
      },
      async stewardsAnswerQuestion({ questionId, answer }, { experimental_caller: caller }) {
        if (caller.kind !== "client") throw new Error("questions are closed by the user, from the stewards page");
        const q = store.question(questionId);
        if (q === null || q.status !== "open") return { ok: false, message: "That question is already closed." };
        const text = answer === null || answer === "" ? null : answer;
        const x = q.escalationId === null ? null : store.escalation(q.escalationId);
        // Closes the escalation it was forwarded for, too.
        store.answer(q.id, text ?? "Closed by the user on the stewards page, without an answer.", "user");
        const b = x === null ? null : store.binding(x.bindingId);
        if (x !== null && b !== null && b.endedAt === null) {
          if (text !== null) store.addGuidance(b.id, text, "user");
          store.note(b.id, text === null ? `Escalation ${x.id} was closed by the user without an answer: carry on as you said you would meanwhile, or escalate again if you still need it.` : `Escalation ${x.id} decided by the user: ${text}`);
          scheduleReconcile(b.id);
          return { ok: true, message: `Closed; ${b.entityKey}'s steward has been told.` };
        }
        return { ok: true, message: "Closed." };
      },
    });

    /** Stewarded projects, and those whose configuration went away but still have stewards. */
    function projectIds(configured: Iterable<string>): string[] {
      return [...new Set([...configured, ...store.all().map((b) => b.projectId)])];
    }

    // ---- the agent surface ---------------------------------------------------------------------------
    //
    // Two tools. steward_report ends a steward's turn with its status record
    // and, when it must, an escalation. steward_update is how one thread
    // steers a binding: the steward saving the user's instructions, a parent
    // or the project steward deciding an escalation, setting priority, holds
    // and models, or approving a spec. Everything else a steward does, it does
    // with the tools every thread has: linear_*, gh, and `bb thread` for
    // workers.

    type Role = { kind: "steward"; binding: Binding } | { kind: "project"; projectId: string } | null;
    function roleOf(threadId: string): Role {
      const b = store.byThread(threadId);
      if (b !== null && b.endedAt === null) return { kind: "steward", binding: b };
      const p = store.projectByThread(threadId);
      if (p !== null) return { kind: "project", projectId: p.projectId };
      return null;
    }

    bb.agents.configure((context) => {
      const role = roleOf(context.thread.id);
      if (role === null) return { tools: [], skills: ["stewards"] };
      if (role.kind === "project") {
        return {
          tools: ["steward_update"],
          skills: ["stewards"],
          instructions:
            "You are this project's steward. Decide escalations from the project's own guidance (AGENTS.md, architecture and design docs); only the project's big decisions go to the user. Read status with `bb stewards list` and `bb stewards show <key>`; steer with steward_update. Do not do a binding's work yourself: when an ended binding left work undone, reopen its entity so its steward resumes. Read the stewards skill for the protocol.",
        };
      }
      const b = role.binding;
      return {
        tools: ["steward_report", "steward_update"],
        skills: ["stewards"],
        instructions:
          `You are the steward of ${JSON.stringify(b.entityKey)} (binding ${b.id}, a ${b.kind} binding under playbook ${JSON.stringify(b.playbook)}), and your thread id is ${context.thread.id}. ` +
          "You act on it as the user, by the playbook. Decide what the project's guidance settles; escalate the rest with steward_report. " +
          "When the user tells you something about how to handle it, save it with steward_update. Every wake message is self-contained; act on it, then end the turn with steward_report. " +
          "Delegate code to workers (`bb thread spawn`, as each wake shows). Sign what you write on GitHub: with gh, end it with " +
          `${JSON.stringify(signatureLine(context.thread.id))}. The linear_ tools sign for you, so add no signature to what you pass them. Read the stewards skill for the protocol.`,
      };
    });

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    function ownBinding(threadId: string): Binding {
      const b = store.byThread(threadId);
      if (b === null || b.endedAt !== null) throw new Error("This thread is not the steward of an open binding.");
      return b;
    }

    const isProjectSteward = (threadId: string, b: Binding) => store.project(b.projectId).threadId === threadId;

    /** Whether `threadId` may steer `target`: its own steward, a steward above it, or its project steward. */
    function mayDirect(threadId: string, target: Binding): boolean {
      if (target.threadId === threadId || isProjectSteward(threadId, target)) return true;
      let up = target.parentBindingId === null ? null : store.binding(target.parentBindingId);
      for (let depth = 0; up !== null && depth < 10; depth++) {
        if (up.threadId === threadId) return true;
        up = up.parentBindingId === null ? null : store.binding(up.parentBindingId);
      }
      return false;
    }

    /** Tell another binding's steward something changed; a binding's own steward already knows. */
    function tell(threadId: string, target: Binding, note: string): void {
      if (target.threadId === threadId) return;
      store.note(target.id, note);
      scheduleReconcile(target.id);
    }

    /** Whether the user said these words in this thread lately. */
    async function userSaid(threadId: string, quote: string): Promise<boolean> {
      const want = quote.replace(/\s+/gu, " ").trim().toLowerCase();
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/start"], order: "desc", limit: "30" });
      for (const row of rows) {
        if (now() - row.createdAt > timing.approvalLookbackMs) break;
        const data = row.data as { initiator?: string; request?: { params?: unknown } };
        if (data.initiator !== "user") continue;
        if (JSON.stringify(data.request?.params ?? {}).replace(/\\n/gu, " ").replace(/\s+/gu, " ").toLowerCase().includes(want)) return true;
      }
      return false;
    }

    bb.agents.registerTool({
      name: "steward_report",
      description:
        "End a steward's turn with its status record: where the entity is, what happens next and who does it, what it waits on, and when to wake it if nothing else does. Also records the ready-gate checklist, voids an approval when the spec changed materially, raises an escalation when something is not yours to decide, and, after a terminal state, keeps the binding open while work remains. Required at the end of every turn you were woken for.",
      presentation: { label: { pending: "Reporting status", completed: "Reported status" } },
      parameters: z.object({
        phase: z.string().trim().min(1).max(100).describe("The entity's phase as you understand it, usually its state."),
        summary: z.string().trim().min(1).max(600).describe("Where the entity is, in a sentence."),
        nextAction: z.string().trim().min(1).max(600).describe("What happens next."),
        actor: z.enum(ACTORS).describe("Who does the next action: me (the user), steward (you or your workers), other (someone else)."),
        blockedOn: z.string().trim().max(300).optional().describe("Who or what outside this thread it waits for."),
        requeueAfter: durationSchema.optional().describe('When to wake you if nothing else does, such as "4h" or "2d". The playbook\'s default when left out.'),
        conditions: z.array(z.string().trim().min(1).max(200)).max(10).optional().describe("Anything else a reader of the status should know at a glance."),
        ready: z
          .object({
            checklist: z
              .array(
                z.object({
                  item: z.union([z.number().int().min(1).max(30), z.string().trim().min(1).max(300)]).describe("The item's number in the wake's ready gate (1 is the first)."),
                  met: z.boolean(),
                  note: z.string().trim().max(300).optional(),
                }),
              )
              .max(30),
            substantial: z.boolean().optional(),
            why: z.string().trim().max(600).optional(),
          })
          .optional()
          .describe("The ready gate as you judge it now: every checklist item from the wake, by its number, met or not, and whether the ticket is substantial."),
        voidApproval: z.boolean().optional().describe("The spec changed materially since approval: void it and ask again."),
        escalate: z
          .object({
            kind: z.enum(ESCALATION_KINDS).describe("blocked, decision, scope (the scope must change), conflict (the entity's state contradicts the playbook), or stuck."),
            question: z.string().trim().min(1).max(1500).describe("One answerable question."),
            meanwhile: z.string().trim().min(1).max(600).describe("What you do meanwhile: wait, continue the unblocked part, or proceed with a stated default."),
          })
          .optional()
          .describe("Something the project's guidance does not let you decide. It goes to your parent steward, then the project steward; the answer comes back as guidance and wakes you."),
        followThrough: z
          .string()
          .trim()
          .min(1)
          .max(600)
          .optional()
          .describe("Only after a terminal state (a wrap-up or follow-through turn): what remains to finish, such as a worker watching the deploy and verifying it. The binding stays open, its workers keep running, and you are woken as usual. Leave it out once the work is done, and the binding ends after this turn."),
      }),
      async execute(input, { threadId }) {
        try {
          let b = ownBinding(threadId);
          if (input.followThrough !== undefined && b.ending !== "terminal") {
            return toolError(new Error(`followThrough is only for after a terminal state, and ${b.entityKey} is not in one now. Report without it.`));
          }
          const config = await loadConfig(b.projectId);
          const playbook = config === null ? null : playbookFor(config, b.kind);
          // Follow-through has one deadline from when it was first declared; a
          // requeue past it is a requeue at it.
          const followThroughUntil = b.ending !== "terminal" ? null : (b.followThroughUntil ?? (input.followThrough === undefined ? null : now() + (playbook?.followThroughMs ?? DEFAULT_FOLLOW_THROUGH_MS)));
          const requeueMs = Math.min(input.requeueAfter ?? playbook?.requeueDefaultMs ?? 2 * 86_400_000, followThroughUntil === null ? Infinity : Math.max(60_000, followThroughUntil - now()));
          let ready = b.ready;
          if (input.ready !== undefined) {
            // Stored in the playbook's own words, so the gate matches what was meant.
            const items = playbook?.ready?.checklist ?? null;
            const checklist = new Map<string, ReadyState["checklist"][number]>();
            const unknown: string[] = [];
            for (const c of input.ready.checklist) {
              const item = items === null ? String(c.item) : resolveChecklistItem(items, c.item);
              if (item === null) unknown.push(JSON.stringify(c.item));
              else checklist.set(item, { item, met: c.met, note: c.note ?? null });
            }
            if (unknown.length > 0) {
              const numbered = items!.map((item, i) => `${i + 1}. ${item}`).join("\n");
              throw new Error(`Nothing was recorded: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a ready checklist item" : "are not ready checklist items"}. Report each item by its number:\n${numbered}`);
            }
            ready = {
              ...ready,
              checklist: [...checklist.values()],
              substantial: input.ready.substantial ?? ready.substantial,
              why: input.ready.why ?? ready.why,
            };
          }
          if (input.voidApproval === true && ready.approval !== null) ready = { ...ready, approval: null, voidedAt: now() };
          // Delivered after the status is written, together with any approval
          // request this report makes due, so the project steward reads the
          // new status and is woken once.
          const raised = input.escalate === undefined ? null : store.escalate({ bindingId: b.id, kind: input.escalate.kind, question: input.escalate.question, meanwhile: input.escalate.meanwhile, route: nextRoute(b, null), recommendation: null });
          const open = store.openEscalations(b.id);
          const status = {
            phase: input.phase,
            summary: input.summary,
            nextAction: input.nextAction,
            actor: input.actor,
            blockedOn: input.blockedOn ?? null,
            requeueAfterMs: requeueMs,
            conditions: [...(input.conditions ?? []), ...open.map((x) => `${x.kind} escalation with ${x.route}`)],
            resources: {
              workers: store.workers(b.id).filter((w) => w.status === "running").map((w) => w.title),
              pullRequests: (b.lastSnapshot?.pulls ?? []).map((p) => p.key).concat(b.lastSnapshot?.entity.pull !== null && b.lastSnapshot !== null ? [b.lastSnapshot.entity.key] : []),
              children: store.children(b.id).map((c) => c.entityKey),
            },
            at: now(),
          };
          const moved = advanced(b.status, status);
          // A wake turn that ends waiting on someone else is archived when it
          // goes idle; a turn the user started is left where they can see it.
          const archiveWhenIdle = input.actor === "other" && (b.awaitingReport || b.archiveWhenIdle);
          b = store.patch(b.id, {
            archiveWhenIdle,
            status,
            statusAt: now(),
            ...(moved ? { advancedAt: now() } : {}),
            requeueAt: now() + requeueMs,
            awaitingReport: false,
            missedReports: 0,
            ready,
            ...(b.ending === "terminal" ? { followThrough: input.followThrough ?? null, followThroughUntil } : {}),
          });
          const requested = playbook === null ? null : await syncApprovalRequest(b, playbook);
          if (raised !== null && !(raised.route === "project" && requested !== null)) await deliver(b, raised);
          if (requested !== null) await wakeProject(b.projectId, raised === null ? `approval requested for ${b.entityKey}` : `escalation and approval request from ${b.entityKey}`, { digestDue: false });
          if (moved && b.parentBindingId !== null) {
            const parent = store.binding(b.parentBindingId);
            if (parent !== null && parent.endedAt === null) tell(threadId, parent, `Child ${b.entityKey}: ${status.summary} Next: ${status.nextAction} (${status.actor})`);
          }
          const escalated = raised === null ? "" : ` Escalation ${raised.id} is with ${raised.route === "parent" ? "your parent steward" : "the project steward"}; do what you said meanwhile.`;
          // Where the gate stands after this report, so a miss shows now and not at the next wake.
          let gateNote = "";
          if (input.ready !== undefined && playbook !== null && playbook.ready !== null) {
            const gate = gateState(playbook, ready, b.lastSnapshot === null ? "" : specHash(b.lastSnapshot.entity, b.threadId));
            const unmet = gate.unmet.map((item) => playbook.ready!.checklist.indexOf(item) + 1);
            const why = !gate.checklistMet ? `unmet: ${unmet.join(", ")}` : gate.approvalStale ? "the approval is stale" : "approval is needed";
            gateNote = gate.passed ? " Ready gate: passed." : ` Ready gate: not passed (${why}).`;
          }
          const request = store.openEscalations(b.id).find((x) => x.kind === "approval");
          if (request !== undefined) {
            gateNote +=
              request.route === "me"
                ? ` Approval of the spec is requested from the user (${request.id}): they approve in this thread, and you record it with steward_update { approve: true, quote }.`
                : ` Approval of the spec is requested from the project steward (${request.id}); wait for it, and do not escalate for it.`;
          }
          if (b.ending === "terminal") {
            if (b.followThrough === null) return `Reported.${escalated} The binding ends when this turn does: running workers are stopped and the thread is archived. End the turn now.`;
            return `Reported.${escalated} The binding stays open to follow through until ${iso(followThroughUntil!)}; running workers keep going. You will be woken when a worker finishes or something actionable changes, or in ${formatDuration(requeueMs)}. End the turn now.`;
          }
          const archived = archiveWhenIdle && store.openEscalations(b.id).length === 0 ? " Your thread is archived when the turn ends, and comes back on that wake." : "";
          return `Reported.${gateNote}${escalated} You will be woken when something actionable changes, or in ${formatDuration(requeueMs)}.${archived} End the turn now.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "steward_update",
      description:
        "Steer a binding. Save standing guidance (re-sent on every wake); decide an escalation (guidance + resolve) or pass it up (forward + recommendation); set priority or a hold; override the steward or worker model; approve a ticket's spec for the ready gate. A steward updates its own binding with the user's instructions; a parent steward or the project steward may update the bindings below it, which wakes them. " +
        "The project steward also records each question it puts to the user (ask, with or without a binding) and closes it when they answer (resolve with the question id, and answer).",
      presentation: { label: { pending: "Updating a binding", completed: "Updated a binding" } },
      parameters: z.object({
        binding: z.string().trim().min(1).max(300).optional().describe("The entity key (ENG-12, owner/repo#3) or binding id. Leave out for this thread's own binding, or, from the project steward, for a question about no one binding."),
        guidance: z.string().trim().min(1).max(4000).optional().describe("Standing guidance, in the user's or your own terms. With resolve, the answer to the escalation."),
        resolve: z.string().trim().min(1).max(100).optional().describe("An open escalation on that binding that the guidance answers; or, from the project steward, an open question (qst_…) the user answered, with answer."),
        answer: z.string().trim().min(1).max(4000).optional().describe("With resolve and a question id: the user's answer, kept on the question."),
        ask: z
          .object({
            question: z.string().trim().min(1).max(1500).describe("The question, as you put it to the user."),
            context: z.string().trim().max(3000).optional().describe("What the user needs to answer it."),
          })
          .optional()
          .describe("Project steward only: record a question you are asking the user in your reply, so it is kept until answered. With binding, it is about that binding."),
        forward: z.string().trim().min(1).max(100).optional().describe("An escalation that reached you and that you should not decide: pass it up. From the project steward it goes to the user — then ask them in your reply."),
        recommendation: z.string().trim().max(1500).optional().describe("Your recommendation, when forwarding."),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        hold: z.string().trim().max(300).optional().describe('Why it is held; "" lifts the hold. A held steward takes no new actions and starts no workers.'),
        stewardModel: modelSpecSchema.optional().describe("The steward thread's model, provider/model/level."),
        workerModel: modelSpecSchema.optional().describe("The model for workers it starts from now."),
        approve: z.boolean().optional().describe("Approve the ticket's current spec for the ready gate."),
        quote: z.string().trim().min(2).max(500).optional().describe("When approving for the user: their words of approval, quoted exactly from a message they sent in this thread."),
      }),
      async execute(input, { threadId }) {
        try {
          const done: string[] = [];
          const notes: string[] = [];
          /** Close the question and record the one asked, once every check has passed. */
          const questionWrites = (closing: { question: Question; answer: string; guidanceDropped: boolean } | null, target: Binding | null): string[] => {
            const out: string[] = [];
            if (closing !== null) {
              const closed = store.answer(closing.question.id, closing.answer, threadId);
              const dropped = closing.guidanceDropped ? " (guidance not saved: it is kept per binding, so name one with binding to give it)" : "";
              out.push(`${closed ? `closed ${closing.question.id}` : `${closing.question.id} already closed with this answer`}${dropped}`);
            }
            if (input.ask !== undefined) {
              const q = store.ask({ projectId: projectOf!, bindingId: target?.id ?? null, escalationId: null, question: input.ask.question, context: input.ask.context ?? null });
              out.push(`question ${q.id} recorded${target === null ? "" : ` about ${target.entityKey}`}: ask the user in your reply, and close it with steward_update { resolve: "${q.id}", answer } once they answer`);
            }
            return out;
          };
          let resolve = input.resolve;
          let guidance = input.guidance;
          let bindingRef = input.binding;

          // Every check comes before the first write, so a call that fails
          // changes nothing and a model can retry it as it was.

          // Questions to the user are the project steward's, and kept until answered.
          const projectOf = store.projectByThread(threadId)?.projectId ?? null;
          let closing: { question: Question; answer: string; guidanceDropped: boolean } | null = null;
          if (input.answer !== undefined && resolve?.startsWith("qst_") !== true) return toolError(new Error('answer closes a question: give it with resolve: "<question id>".'));
          if (projectOf === null && (input.ask !== undefined || resolve?.startsWith("qst_") === true)) {
            return toolError(new Error("Only the project steward keeps questions to the user; a steward escalates with steward_report."));
          }
          if (projectOf !== null && resolve?.startsWith("qst_") === true) {
            const q = store.question(resolve);
            if (q === null || q.projectId !== projectOf) return toolError(new Error(`No question ${resolve} in this project.`));
            const answer = input.answer ?? guidance;
            if (answer === undefined) return toolError(new Error("Give the user's answer (answer) when closing a question."));
            const x = q.escalationId === null ? null : store.escalation(q.escalationId);
            if (x !== null) {
              // A forwarded escalation: decided as one, which closes the question with it.
              // Closed already (the binding ended, a retry) is answered the same way.
              resolve = x.id;
              guidance ??= answer;
              bindingRef ??= x.bindingId;
            } else {
              // A retry of the close that already happened changes nothing.
              if (q.status !== "open" && q.answer !== answer) return toolError(new Error(`Question ${q.id} is already closed.`));
              closing = { question: q, answer, guidanceDropped: false };
              resolve = undefined;
              if (input.guidance !== undefined && (input.answer !== undefined || q.bindingId !== null)) bindingRef ??= q.bindingId ?? undefined;
              else guidance = undefined;
              if (guidance !== undefined && bindingRef === undefined) {
                // A question about the project as a whole: closed all the same; guidance belongs to a binding.
                guidance = undefined;
                closing.guidanceDropped = true;
              }
            }
          }

          const target = bindingRef === undefined ? (projectOf !== null ? null : ownBinding(threadId)) : store.find(bindingRef);
          if (bindingRef !== undefined && target === null) return toolError(new Error(`No binding for ${bindingRef}.`));
          if (target === null) {
            const forBinding = [guidance, resolve, input.forward, input.recommendation, input.priority, input.hold, input.stewardModel, input.workerModel, input.approve, input.quote];
            if (forBinding.some((v) => v !== undefined)) return toolError(new Error("Name the binding (binding: ENG-12 or owner/repo#3) for that."));
            if (closing === null && input.ask === undefined) return toolError(new Error("Nothing to update: name a binding, ask a question, or close one."));
            return `${questionWrites(closing, null).join("; ")}.`;
          }
          if (input.ask !== undefined && target.projectId !== projectOf) return toolError(new Error(`${target.entityKey} is not in this project.`));
          const self = target.threadId === threadId;

          const forwarding = input.forward === undefined ? null : store.escalation(input.forward);
          if (input.forward !== undefined) {
            if (forwarding === null || forwarding.status !== "open" || forwarding.bindingId !== target.id) return toolError(new Error(`No open escalation ${input.forward} on ${target.entityKey}.`));
            const holder = forwarding.route === "parent" ? store.binding(target.parentBindingId ?? "")?.threadId : forwarding.route === "project" ? store.project(target.projectId).threadId : null;
            if (holder !== threadId) return toolError(new Error(`Escalation ${forwarding.id} is not with this thread, so it cannot forward it.`));
          }

          const directs = mayDirect(threadId, target);
          if (!directs && forwarding === null) return toolError(new Error(`This thread does not steer ${target.entityKey}: only its own steward, a steward above it, or the project steward does.`));
          let approval: { entity: EntitySnapshot; byUser: boolean } | null = null;
          let resolving: Escalation | null = null;
          if (directs) {
            if (self && (input.priority !== undefined || input.hold !== undefined || input.stewardModel !== undefined)) {
              return toolError(new Error("A steward does not set its own priority, hold or model; its parent or the project steward does."));
            }
            if (input.approve === true) {
              const config = await loadConfig(target.projectId);
              const playbook = config === null ? null : playbookFor(config, target.kind);
              const mode = playbook?.ready?.approval ?? null;
              if (mode === null) return toolError(new Error(`${target.entityKey}'s playbook has no ready gate to approve.`));
              if (typeof mode === "object") return toolError(new Error(`${target.entityKey} is approved by moving it to ${mode["linear-state"]} in Linear.`));
              if (target.lastSnapshot === null) return toolError(new Error("Nothing has been observed for this binding yet."));
              const byProject = mode === "project" && isProjectSteward(threadId, target);
              const byUser = input.quote !== undefined && (await userSaid(threadId, input.quote));
              if (!byProject && !byUser) {
                return toolError(
                  new Error(
                    mode === "me"
                      ? "This spec is approved by the user: quote their words from a message they sent in this thread."
                      : "This spec is approved by the project steward (or by the user, quoting their words from this thread). Escalate a decision instead.",
                  ),
                );
              }
              // Pinned to the spec as it is now, not as last observed: a spec
              // comment posted since the last ring is part of what was read.
              approval = { entity: (await snapshot(target.source, target.entityId).catch(() => null)) ?? target.lastSnapshot.entity, byUser };
            }
            if (resolve !== undefined) {
              if (guidance === undefined) return toolError(new Error("Give the answer as guidance when resolving."));
              resolving = store.escalation(resolve);
              if (resolving === null || resolving.bindingId !== target.id) return toolError(new Error(`No escalation ${resolve} on ${target.entityKey}.`));
            }
            if (input.stewardModel !== undefined && target.threadId !== null) {
              const info = await threadInfo(target.threadId);
              if (info !== null && info.providerId !== "" && info.providerId !== input.stewardModel.providerId) return toolError(new Error(`${target.entityKey}'s steward runs on ${info.providerId}; a model can be changed, the provider cannot.`));
            }
            const asked = [guidance, resolve, input.forward, input.priority, input.hold, input.stewardModel, input.workerModel, input.approve === true ? true : undefined, input.ask, closing ?? undefined];
            if (asked.every((v) => v === undefined)) return toolError(new Error("Nothing to update: give guidance, resolve, forward, priority, hold, a model, approve, or ask."));
          }

          done.push(...questionWrites(closing, target));
          if (forwarding !== null) {
            const route = nextRoute(target, forwarding.route);
            const recommendation = input.recommendation ?? forwarding.recommendation;
            store.reroute(forwarding.id, route, recommendation);
            // Kept as a question to the user too, which closes when the escalation is resolved. Made
            // before the await below, so the escalation cannot be resolved in between and leave it open.
            const q =
              route !== "me"
                ? null
                : store.ask({
                    projectId: target.projectId,
                    bindingId: target.id,
                    escalationId: forwarding.id,
                    question: forwarding.question,
                    context: [`A ${forwarding.kind} escalation from ${target.entityKey}${target.title === null ? "" : ` (${target.title})`}.`, `Meanwhile: ${forwarding.meanwhile}`, recommendation === null ? null : `Recommendation: ${recommendation}`].filter((c) => c !== null).join(" "),
                  });
            await deliver(target, store.escalation(forwarding.id)!);
            if (q !== null) done.push(`forwarded ${forwarding.id} to the user as question ${q.id}: ask them in your reply, then record their answer with guidance + resolve`);
            else done.push(`forwarded ${forwarding.id} to the project steward`);
          }
          if (!directs) return `${target.entityKey}: ${done.join("; ")}.`;

          if (approval !== null) {
            const by = approval.byUser ? ` by the user: "${input.quote}"` : " by the project steward";
            store.patch(target.id, { ready: { ...target.ready, approval: { at: now(), specHash: specHash(approval.entity, target.threadId), by: threadId }, voidedAt: null, declinedSpecHash: null } });
            for (const x of store.openEscalations(target.id).filter((e) => e.kind === "approval")) store.resolve(x.id, `Approved${by}.`);
            const others = store.openEscalations(target.id).filter((x) => x.id !== resolve);
            done.push(others.length === 0 ? "spec approved" : `spec approved; still open on it: ${others.map((x) => `${x.id} (${x.kind}, with ${x.route}): ${x.question}`).join(" | ")} — resolve any this approval answers`);
            notes.push(`The spec was approved${by}.`);
          }

          if (guidance !== undefined) {
            // The same guidance again within minutes is a retry: saved once.
            const saved = store.addGuidance(target.id, guidance, threadId);
            done.push(saved ? "guidance saved" : "guidance already saved");
            if (saved && resolve === undefined) notes.push(`New guidance: ${guidance}`);
          }
          if (resolving !== null) {
            // Already resolved (the binding ended, a retry) is no error: the answer is added to the record.
            const outcome = store.answerEscalation(resolving.id, guidance!, threadId);
            if (resolving.kind === "approval" && resolving.status === "open" && input.approve !== true && target.lastSnapshot !== null) {
              const fresh = store.binding(target.id)!;
              store.patch(target.id, { ready: { ...fresh.ready, declinedSpecHash: specHash(fresh.lastSnapshot!.entity, fresh.threadId) } });
            }
            if (resolving.status === "open") done.push(`resolved ${resolving.id}`);
            else if (outcome === "appended") done.push(`recorded the answer on ${resolving.id}, which was already resolved (${resolving.resolution ?? "no answer"})`);
            else done.push(`${resolving.id} already has this answer`);
            if (outcome !== "unchanged") notes.push(`Escalation ${resolving.id} decided: ${guidance}`);
          }
          if (input.priority !== undefined || input.hold !== undefined) {
            store.patch(target.id, { ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.hold === undefined ? {} : { hold: input.hold === "" ? null : input.hold }) });
            const what = [input.priority === undefined ? null : `priority ${input.priority}`, input.hold === undefined ? null : input.hold === "" ? "hold lifted" : `on hold: ${input.hold}`].filter((s) => s !== null).join("; ");
            done.push(what);
            notes.push(`Set by your ${isProjectSteward(threadId, target) ? "project" : "parent"} steward: ${what}`);
          }
          if (input.stewardModel !== undefined && target.threadId !== null) {
            await bb.sdk.threads.update({ threadId: target.threadId, ...(input.stewardModel.model === null ? {} : { model: input.stewardModel.model }), ...(input.stewardModel.reasoningLevel === null ? {} : { reasoningLevel: input.stewardModel.reasoningLevel }) });
          }
          if (input.stewardModel !== undefined || input.workerModel !== undefined) {
            store.patch(target.id, { ...(input.stewardModel === undefined ? {} : { modelSteward: input.stewardModel.text }), ...(input.workerModel === undefined ? {} : { modelWorker: input.workerModel.text }) });
            done.push(`models: steward ${input.stewardModel?.text ?? "unchanged"}, workers ${input.workerModel?.text ?? "unchanged"}`);
          }
          for (const n of notes) tell(threadId, target, n);
          return `${target.entityKey}: ${done.join("; ")}.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    function formatBindings(rows: Binding[]): string {
      if (rows.length === 0) return "No bindings.";
      return rows
        .map((b) => {
          const s = b.status;
          const open = store.openEscalations(b.id);
          const flags = [b.endedAt === null ? null : `ended: ${b.endReason}`, b.priority === null ? null : `priority ${b.priority}`, b.hold === null ? null : `HOLD: ${b.hold}`, ...open.map((x) => `${x.kind} escalation ${x.id} with ${x.route}`), unheardWait(s, open)].filter((f) => f !== null);
          return `${b.entityKey} — ${b.kind}, ${b.phase ?? "?"}${b.threadId === null ? "" : `, thread ${b.threadId}`}\n  ${s === null ? "no report yet" : `${s.summary} Next: ${s.nextAction} (${s.actor})${s.blockedOn === null ? "" : `; blocked on ${s.blockedOn}`}`}${flags.length > 0 ? `\n  [${flags.join("; ")}]` : ""}`;
        })
        .join("\n");
    }

    // ---- timers: requeue, the sweep, the nightly pass ----------------------------------------------

    async function requeueTick(): Promise<void> {
      if ((await settings.get()).paused) return;
      for (const b of store.dueRequeue()) scheduleReconcile(b.id);
    }

    /** The mechanical backstop: adoption, stuck, overdue endings, and a look at every binding. */
    let lastSweepAt: number | null = null;
    async function sweep(): Promise<void> {
      lastSweepAt = now();
      const projects = await stewardedProjects(true);
      pushInterest();
      for (const config of projects) {
        if (!(await settings.get()).paused) await adoptionPass(config);
        await keepProjectSteward(config.projectId);
        const playbooks = config.playbooks;
        for (const b of store.open(config.projectId)) {
          if (b.threadId !== null) await keepSteward(config.projectId, b.threadId);
          const deadline = endingDeadline(b, timing.endingTimeoutMs);
          if (deadline !== null && now() > deadline) {
            await serial(`b:${b.id}`, async () => {
              const fresh = store.binding(b.id);
              if (fresh === null || fresh.ending === null || fresh.endedAt !== null) return;
              if (followingThrough(fresh)) await followThroughRanOut(fresh);
              else await finishEnding(fresh, fresh.ending!);
            });
            continue;
          }
          const playbook = playbooks[b.kind];
          if (playbook !== undefined) {
            const limit = stuckDue(b, playbook, store.openEscalations(b.id), now());
            if (limit !== null) await raise(b, "stuck", `${b.entityKey}'s status has not moved in ${formatDuration(limit)} (phase ${b.phase}). What should happen?`, "Carrying on as before.");
          }
          scheduleReconcile(b.id);
        }
      }
      const stewarded = new Set(projects.map((c) => c.projectId));
      for (const row of store.projects()) {
        if (stewarded.has(row.projectId) || row.sectionId === null) continue;
        await quietly(`retire the section of ${row.projectId}`, () => retireSection(row.projectId, row.sectionId!));
      }
    }

    const running = new Set<string>();

    /** One night for one project: adoption, a turn for every binding, then the project steward's digest. */
    async function nightlyPass(config: ProjectConfig, night: string, anytime = false): Promise<void> {
      // `bb stewards pass --nightly` runs now, whatever the hour, for at most two hours.
      const deadline = now() + 2 * 60 * 60_000;
      const inNight = () => (anytime ? now() < deadline : stillNight(now(), config.file.nightly, night));
      if (running.has(config.projectId)) return;
      running.add(config.projectId);
      try {
        bb.log.info(`stewards: nightly pass for ${config.projectId} (${night})`);
        if (!(await settings.get()).paused) await adoptionPass(config);
        const order = store
          .open(config.projectId)
          .filter((b) => b.hold === null && b.ending === null)
          .sort((a, b) => (PRIORITY_ORDER[a.priority ?? "normal"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "normal"] ?? 2) || (a.lastJudgmentAt ?? 0) - (b.lastJudgmentAt ?? 0));
        const woken: string[] = [];
        for (const b of order.slice(0, config.file.nightly.max)) {
          if (disposed || !inNight()) break;
          await serial(`b:${b.id}`, () => reconcileBinding(b.id, "nightly"));
          if (store.binding(b.id)?.threadId) woken.push(store.binding(b.id)!.threadId!);
          await new Promise((r) => setTimeout(r, timing.nightlyStaggerMs));
        }
        // The project steward reads the fresh records, so it waits for the turns.
        while (!disposed && inNight()) {
          const states = await Promise.all(woken.map((t) => threadInfo(t).catch(() => null)));
          if (!states.some((s) => s !== null && busy(s.status))) break;
          await new Promise((r) => setTimeout(r, 30_000));
        }
        if (!disposed) await wakeProject(config.projectId, `nightly pass ${night}`, { digestDue: true, notes: [`${woken.length} binding(s) had a turn tonight.`] });
      } finally {
        running.delete(config.projectId);
      }
    }

    async function nightlyTick(): Promise<void> {
      for (const config of await stewardedProjects()) {
        const row = store.project(config.projectId);
        const night = nightlyDue(now(), config.file.nightly, row.nightlyDate);
        if (night === null) continue;
        store.patchProject(config.projectId, { nightlyDate: night });
        void nightlyPass(config, night).catch((error: unknown) => bb.log.warn(`stewards: nightly pass for ${config.projectId}: ${errorMessage(error)}`));
      }
    }

    bb.background.schedule("nightly", "*/5 * * * *", nightlyTick);
    bb.background.service("loop", {
      async start(signal) {
        const requeue = setInterval(() => void requeueTick().catch((e: unknown) => bb.log.warn(`stewards: requeue: ${errorMessage(e)}`)), timing.requeueTickMs);
        const sweeper = setInterval(() => void sweep().catch((e: unknown) => bb.log.warn(`stewards: sweep: ${errorMessage(e)}`)), timing.sweepMs);
        // The first sweep tells linear and github what to watch after a restart.
        void sweep().catch((e: unknown) => bb.log.warn(`stewards: sweep: ${errorMessage(e)}`));
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        clearInterval(requeue);
        clearInterval(sweeper);
      },
    });

    // ---- the CLI --------------------------------------------------------------------------------------

    const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
    const PROJECT_OPTION = { type: "string", description: "The project id; the invoking thread's project when left out" } as const;

    function projectOf(option: string | undefined, ctx: { projectId?: string }): string {
      const id = option ?? ctx.projectId;
      if (id === undefined || id === "") throw new PluginCliError("No project: run this from a thread, or pass --project.", { code: "no_project" });
      return id;
    }

    function bindingOrThrow(key: string, projectId?: string): Binding {
      const b = store.find(key, projectId);
      if (b === null)
        throw new PluginCliError(`No binding for ${key}${projectId === undefined ? "" : ` in project ${projectId}`}.`, {
          code: "binding_not_found",
          hint: "bb stewards list --all shows the project's bindings; pass --project for another project's.",
        });
      return b;
    }

    async function check(projectId: string): Promise<{ ok: boolean; lines: string[] }> {
      const config = await loadConfig(projectId, true);
      if (config === null) return { ok: false, lines: [`No ${PROJECT_FILE} on the project's .bb (committed HEAD). Run bb stewards init.`] };
      const lines: string[] = [...config.problems.map((p) => `problem: ${p}`)];
      const ticket = config.playbooks.ticket;
      lines.push(`Linear teams: ${config.file.linear.teams.join(", ") || "(none)"}; repos: ${config.repos.join(", ") || "(none)"}${config.file.github.exclude.length > 0 ? ` (excluded: ${config.file.github.exclude.join(", ")})` : ""}; label ${config.file.label}`);
      for (const kind of KINDS) {
        const p = config.playbooks[kind];
        lines.push(`${kind}: ${p === undefined ? `no usable playbook (${playbookNameFor(config.file, kind)})` : `${p.name}@${p.version}`}`);
      }
      const validate = async (source: Source, units: string[], states: string[]) => {
        if (units.length === 0) return;
        try {
          const out = await sourceRpc(source, "sourceValidate", { units, label: config.file.label, states }, sourceContract.sourceValidate.output);
          if (out.error !== null) lines.push(`problem: ${source}: ${out.error}`);
          for (const u of out.units) {
            if (!u.found) lines.push(`problem: ${source}: ${u.unit} is not visible`);
            else if (!u.labelFound) lines.push(`problem: ${source}: ${u.unit} has no label ${config.file.label}`);
            if (u.missingStates.length > 0) lines.push(`problem: ${source}: ${u.unit} has no state ${u.missingStates.join(", ")}`);
          }
        } catch (error) {
          lines.push(`problem: could not validate against ${source}: ${errorMessage(error)}`);
        }
      };
      await validate("linear", config.file.linear.teams, ticket === undefined ? [] : playbookStates(ticket));
      await validate("github", config.repos, []);
      return { ok: !lines.some((l) => l.startsWith("problem:")), lines };
    }

    bb.cli.register(
      defineCli({
        name: "stewards",
        summary: "Long-lived threads that manage labelled Linear tickets and GitHub pull requests",
        description: "Configuration lives in the project's .bb (stewards/project.json and stewards/playbooks/), read from committed HEAD through multi-repo.",
        commands: {
          init: cliCommand({
            summary: "Write stewards/project.json and the default playbooks into a .bb checkout",
            description:
              "Run from a thread in a multi-repo workspace: writes into <cwd>/.bb on the thread's machine unless --dir is given. Existing files are left alone unless --force. Then commit inside .bb and publish it (workspace_publish_guidance); stewards reads committed HEAD only.",
            options: {
              teams: { type: "string", description: "Linear team keys, comma-separated; the teams you belong to when left out" },
              dir: { type: "string", description: "The .bb directory to write into" },
              force: { type: "boolean", description: "Overwrite existing files" },
            },
            async run(input, ctx) {
              let teams = (input.options.teams ?? "").split(",").map((t) => t.trim().toUpperCase()).filter((t) => t !== "");
              if (teams.length === 0) {
                try {
                  const out = await rpc("linear", "sourceValidate", { units: [], label: "bb-managed", states: [] }, sourceContract.sourceValidate.output);
                  teams = out.mine.map((m) => m.unit);
                } catch (error) {
                  throw new PluginCliError(`Could not ask Linear for your teams: ${errorMessage(error)}`, { code: "linear_unavailable", hint: "Pass --teams ENG,OPS." });
                }
              }
              const dir = input.options.dir ?? (ctx.cwd === undefined ? undefined : `${ctx.cwd.replace(/\/$/u, "")}/.bb`);
              if (dir === undefined) throw new PluginCliError("No directory: run from a thread or pass --dir.", { code: "no_dir" });
              // Write on the thread's machine, else the project's: left to core, the
              // write lands on the server's own daemon, which bb-gate's servers lack.
              const hostId =
                (ctx.threadId === undefined ? null : ((await threadInfo(ctx.threadId))?.environmentHostId ?? null)) ??
                (ctx.projectId === undefined ? null : await projectHost(ctx.projectId)) ??
                undefined;
              const files: Array<[string, string]> = [[PROJECT_FILE, projectFileTemplate(teams)], ...Object.entries(PLAYBOOK_TEMPLATES).map(([name, text]) => [playbookPath(name), text] as [string, string])];
              const lines: string[] = [];
              for (const [rel, content] of files) {
                const path = `${dir}/${rel}`;
                await bb.sdk.files.mkdir({ path: path.slice(0, path.lastIndexOf("/")), recursive: true, ...(hostId === undefined ? {} : { hostId }) } as never).catch(() => undefined);
                const result = (await bb.sdk.files.write({ path, content, ...(input.options.force ? {} : { expectedSha256: null }), ...(hostId === undefined ? {} : { hostId }) } as never)) as { outcome: string };
                lines.push(`${result.outcome === "written" ? "wrote" : "kept existing"} ${rel}`);
              }
              lines.push("", `Teams: ${teams.join(", ") || "(none; add them to linear.teams)"}`, "Next: review the files, commit inside .bb, publish with workspace_publish_guidance, merge the guidance branch, then run bb stewards check.");
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),

          check: cliCommand({
            summary: "Validate the project file and every playbook against Linear and GitHub",
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const result = await check(projectOf(input.options.project, ctx));
              return { exitCode: result.ok ? 0 : 1, stdout: [...result.lines, result.ok ? "OK" : "Problems found."].join("\n") };
            },
          }),

          list: cliCommand({
            summary: "Bindings and their status records",
            options: { all: { type: "boolean", description: "Include ended bindings" }, project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const projectId = input.options.project ?? ctx.projectId;
              const rows = input.options.all ? store.all(projectId) : store.open(projectId);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(rows.map(({ lastSnapshot: _s, ...rest }) => rest)) : formatBindings(rows) };
            },
          }),

          show: cliCommand({
            summary: "One binding in full: status, ready gate, guidance, escalations, workers, action log",
            positionals: [{ name: "key", description: "The entity key (ENG-12, owner/repo#3) or binding id", required: true }],
            options: { project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const b = bindingOrThrow(input.positionals.key, input.options.project ?? ctx.projectId);
              const detail = { binding: b, escalations: store.escalations(b.id), workers: store.workers(b.id), children: store.children(b.id).map((c) => c.entityKey) };
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(detail) };
              const lines = [formatBindings([b]), "", `Playbook ${b.playbook}@${b.playbookVersion}; stage ${b.stage ?? "?"}; created ${iso(b.createdAt)}${b.requeueAt === null ? "" : `; requeue ${iso(b.requeueAt)}`}`];
              lines.push(`Ready: ${b.ready.checklist.map((c) => `[${c.met ? "x" : " "}] ${c.item}`).join("; ") || "not reported"}; substantial ${b.ready.substantial ?? "?"}; approval ${b.ready.approval === null ? "none" : iso(b.ready.approval.at)}`);
              for (const g of b.guidance) lines.push(`Guidance ${iso(g.at)}: ${g.text}`);
              for (const x of detail.escalations) lines.push(`Escalation ${x.id} ${x.kind} (${x.status}, ${x.route}): ${x.question}${x.resolution === null ? "" : ` → ${x.resolution}`}`);
              for (const w of detail.workers) lines.push(`Worker ${w.threadId} ${w.title}: ${w.status}`);
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),

          detach: cliCommand({
            summary: "Stop stewarding an entity: its steward gets one stop turn",
            description: "It stays detached until its label is removed and added again.",
            positionals: [{ name: "key", description: "The entity key or binding id", required: true }],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const b = bindingOrThrow(input.positionals.key, input.options.project ?? ctx.projectId);
              if (b.endedAt !== null) return { exitCode: 0, stdout: `${b.entityKey} has already ended (${b.endReason}).` };
              store.patch(b.id, { manualDetach: true });
              const config = await loadConfig(b.projectId);
              const playbook = config === null ? null : playbookFor(config, b.kind);
              await serial(`b:${b.id}`, async () => {
                const fresh = store.binding(b.id)!;
                if (config === null || playbook === null || fresh.lastSnapshot === null) await finishEnding(fresh, "detach");
                else await beginEnding(fresh, config, playbook, "detach", fresh.lastSnapshot);
              });
              return { exitCode: 0, stdout: `Detaching ${b.entityKey}.` };
            },
          }),

          pass: cliCommand({
            summary: "Run a pass now: the mechanical sweep, or with --nightly the full nightly pass",
            options: { project: PROJECT_OPTION, nightly: { type: "boolean", description: "Give every binding a judgment turn and wake the project steward for a digest" } },
            async run(input, ctx) {
              const projectId = projectOf(input.options.project, ctx);
              const config = await loadConfig(projectId, true);
              if (config === null) throw new PluginCliError(`Project ${projectId} has no ${PROJECT_FILE}.`, { code: "not_configured" });
              if (input.options.nightly) {
                void nightlyPass(config, `manual-${iso(now())}`, true).catch((e: unknown) => bb.log.warn(`stewards: manual pass: ${errorMessage(e)}`));
                return { exitCode: 0, stdout: "Started the nightly pass; follow it with bb stewards list." };
              }
              await sweep();
              return { exitCode: 0, stdout: `Swept. ${store.open(projectId).length} open binding(s).` };
            },
          }),

          digest: cliCommand({
            summary: "The project steward's latest morning digest",
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const row = store.project(projectOf(input.options.project, ctx));
              return { exitCode: 0, stdout: row.digest === null ? "No digest yet." : `${iso(row.digestAt ?? 0)}\n\n${row.digest}` };
            },
          }),
        },
      }),
    );

    // Exposed for tests: drive the loop without timers.
    const forgetTags = () => {
      tagged.clear();
      kept.clear();
    };
    testHooks.set(bb.pluginId, { sweep, store, db, forgetTags, nightlyPass: (projectId: string, night: string) => loadConfig(projectId, true).then((c) => (c === null ? undefined : nightlyPass(c, night, true))), settle: () => Promise.all([...chains.values()]).then(() => undefined) });
  };
}

/** Test seams, keyed by plugin id. Not part of any contract. */
export const testHooks = new Map<string, { sweep(): Promise<void>; store: Store; db: { prepare(sql: string): { run(...args: unknown[]): unknown } }; forgetTags(): void; nightlyPass(projectId: string, night: string): Promise<void>; settle(): Promise<void> }>();

export { DEFAULT_PLAYBOOKS, STEWARDS_PLUGIN_ID };

export default createStewardsPlugin({ now: () => Date.now() });
