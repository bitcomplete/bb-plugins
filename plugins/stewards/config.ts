// Configuration: the project file and the playbooks, as text read from the
// project's `.bb` through multi-repo, parsed into typed values. Pure: nothing
// here reads a file or calls a plugin; server.ts hands the text in.
//
// Both files are written by people, so every parse returns an error a person
// can act on rather than throwing, and the error names the file.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { decideEntrySchema, defaultDecideList, globError } from "./decisions.js";
import { SENTRY_SLUG, opsTargetKey, type DependabotTarget, type K8sTarget, type OpsTarget, type SentryTarget } from "./ops.js";
import { DEPENDABOT_SEVERITIES, REPO_NAME } from "./source-contract.js";

export const STEWARDS_DIR = "stewards";
export const PROJECT_FILE = `${STEWARDS_DIR}/project.json`;
/** The per-person roles: which watches and the project stewardship a GitHub login's server runs. */
export const ROLES_FILE = `${STEWARDS_DIR}/roles.json`;
export const playbookPath = (name: string) => `${STEWARDS_DIR}/playbooks/${name}.md`;

export const DEFAULT_LABEL = "bb-managed";

/**
 * The label an initiative ticket carries besides the adoption label, and the
 * playbook that stewards it (BB-243). A ticket is an initiative when it
 * carries the label or runs under the playbook: the project steward's wake and
 * digest read an initiative's progress from the `**Met:**` comments, and the
 * playbook name is known even before the first snapshot, so an unread history
 * reads `unknown`, never `0`.
 */
export const INITIATIVE_LABEL = "initiative";
export const INITIATIVE_PLAYBOOK = "initiative";

/**
 * Authors whose pull requests the dependency watch adopts under deps-prs
 * (BB-164). The synthesized Dependabot watch names them as its `match.author`,
 * so the bot path and a declared watch are the same matcher.
 */
export const DEPENDENCY_BOTS = new Set(["dependabot", "dependabot[bot]"]);

// ---- durations ------------------------------------------------------------------

const DURATION = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/u;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "45m", "3h", "2d", "1w", or { days, hours, minutes }. */
export const durationSchema = z
  .union([
    z.string().trim().regex(DURATION, 'a duration such as "45m", "3h" or "2d"'),
    z.object({ days: z.number().nonnegative().optional(), hours: z.number().nonnegative().optional(), minutes: z.number().nonnegative().optional() }).strict(),
  ])
  .transform((value) => {
    if (typeof value === "string") {
      const m = DURATION.exec(value)!;
      return Math.round(Number(m[1]) * UNIT_MS[m[2]!]!);
    }
    return Math.round((value.days ?? 0) * UNIT_MS.d! + (value.hours ?? 0) * UNIT_MS.h! + (value.minutes ?? 0) * UNIT_MS.m!);
  })
  .refine((ms) => ms >= 60_000, "at least one minute");

export function formatDuration(ms: number): string {
  if (ms % UNIT_MS.d! === 0) return `${ms / UNIT_MS.d!}d`;
  if (ms % UNIT_MS.h! === 0) return `${ms / UNIT_MS.h!}h`;
  return `${Math.round(ms / UNIT_MS.m!)}m`;
}

/**
 * BB-247: how far out a dated wait may be before the project steward is told
 * once. The playbook's `max-wait` overrides it; the default is 90 days.
 */
export const DEFAULT_MAX_WAIT_MS = 90 * 86_400_000;

// ---- models ---------------------------------------------------------------------

/** "claude" is how people write the Claude Code provider; bb calls it claude-code. */
const PROVIDER_ALIASES: Record<string, string> = { claude: "claude-code" };
const REASONING = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ReasoningLevel = (typeof REASONING)[number];

export type ModelSpec = { text: string; providerId: string; model: string | null; reasoningLevel: ReasoningLevel | null };

/**
 * "provider/model/level", "provider/model" or "provider". A model id may
 * itself hold slashes (Pi's are "fireworks/accounts/…/deepseek-v4p1-flash"),
 * so the level is the last part only when it names one.
 */
export const modelSpecSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((text, ctx): ModelSpec => {
    const [provider = "", ...rest] = text.split("/");
    const last = rest.length >= 2 ? rest.at(-1)! : "";
    const level = (REASONING as readonly string[]).includes(last) ? (last as ReasoningLevel) : null;
    const model = (level === null ? rest : rest.slice(0, -1)).join("/");
    if (provider === "" || (rest.length > 0 && (model === "" || model.split("/").includes("")))) {
      ctx.addIssue({ code: "custom", message: `${JSON.stringify(text)} is not provider/model/level, such as claude/claude-sonnet-5-5/medium` });
      return z.NEVER;
    }
    return { text, providerId: PROVIDER_ALIASES[provider] ?? provider, model: model === "" ? null : model, reasoningLevel: level };
  });

// ---- the project file -------------------------------------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'a time such as "01:00"');

export const KINDS = ["ticket", "pr", "review", "ops"] as const;
export type BindingKind = (typeof KINDS)[number];

export const DEFAULT_PLAYBOOKS: Record<BindingKind, string> = { ticket: "linear-tickets", pr: "github-prs", review: "github-reviews", ops: "ops-watch" };

/** The ticket playbook a GitHub-tracked project carries; the default for a project with no Linear teams. */
export const DEFAULT_GITHUB_TICKET_PLAYBOOK = "github-issues";

/** The label a GitHub issue carries to mean "todo", the phase a filed autoAdopt issue starts in (BB-234, BB-235). */
export const GITHUB_TODO_LABEL = "status:todo";

/** The playbooks the dependency watch uses: one for alert targets, one for the bot's pull requests. */
export const DEPS_ALERTS_PLAYBOOK = "deps-alerts";
export const DEPS_PRS_PLAYBOOK = "deps-prs";

const playbookName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, "a playbook name: lowercase letters, digits and dashes");

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const teamKey = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]*$/u, "a team key such as ENG").transform((s) => s.toUpperCase());

/**
 * A filing target (BB-235): where an ops or dependency watch files its
 * tickets, either a Linear team key or a GitHub `owner/repo`. A repo is kept
 * as GitHub spells it; a team key is folded to upper case. The source is read
 * from the shape; membership in `linear.teams` (checked here) or in the repo
 * set (`filingTargetProblems`, where the repo set is known) is a separate
 * question. This is what `ops.team` and a role's `ops.team` accept.
 */
export const filingTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value, ctx): string => {
    if (REPO_NAME.test(value)) return value;
    if (/^[A-Za-z][A-Za-z0-9]*$/u.test(value)) return value.toUpperCase();
    ctx.addIssue({ code: "custom", message: `${JSON.stringify(value)} is not a Linear team key or a GitHub owner/repo` });
    return z.NEVER;
  });

/** Where a filing target lives: a Linear team or a GitHub repo. */
export type FilingTargetSource = "linear" | "github";
export type FilingTarget = { target: string; source: FilingTargetSource };

/** The source of a filing target from its shape: a repo has a slash, a team key does not. */
export const filingTargetOf = (target: string): FilingTarget => ({ target, source: REPO_NAME.test(target) ? "github" : "linear" });

/** Linear's priorities, as `ops.autoAdopt` names them. */
export const LINEAR_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

const k8sNamespaceTargetSchema = z
  .object({
    kind: z.literal("k8s-namespace"),
    name: z.string().trim().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u, "a namespace name such as bb-gate-production"),
  })
  .strict();

/** A repository whose Dependabot alerts an ops steward watches. */
export const dependabotRepoSchema = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "a repo such as acme/web");

const dependabotTargetSchema = z.object({ kind: z.literal("dependabot"), repo: dependabotRepoSchema }).strict();

/** A Sentry slug as Sentry spells it in URLs; upper case is folded, since Sentry's are always lower. */
const sentrySlug = z.string().trim().toLowerCase().regex(SENTRY_SLUG, "a Sentry slug such as acme or web-api");

/** A Sentry project whose issues an ops steward watches, read with the plugin's Sentry token. */
const sentryProjectTargetSchema = z.object({ kind: z.literal("sentry-project"), org: sentrySlug, project: sentrySlug }).strict();

const opsTargetSchema = z.discriminatedUnion("kind", [k8sNamespaceTargetSchema, dependabotTargetSchema, sentryProjectTargetSchema]);

/** The per-severity SLA and batch window for Dependabot alerts. */
const slaValueSchema = z.union([z.literal("asap"), durationSchema]);

export const depsSchema = z
  .object({
    sla: z
      .object({
        critical: slaValueSchema.default("asap"),
        high: slaValueSchema.default(86_400_000),
        medium: slaValueSchema.default(7 * 86_400_000),
        low: slaValueSchema.default(30 * 86_400_000),
      })
      .strict()
      .default({ critical: "asap", high: 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 }),
    batch: z
      .object({ medium: durationSchema.default(7 * 86_400_000), low: durationSchema.default(30 * 86_400_000) })
      .strict()
      .default({ medium: 7 * 86_400_000, low: 30 * 86_400_000 }),
    /** Severities whose tickets are labelled and moved to Todo when filed, without an escalation. */
    autoAdopt: z.array(z.enum(DEPENDABOT_SEVERITIES)).max(4).default(["critical", "high"]),
  })
  .strict()
  .default({ sla: { critical: "asap", high: 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 }, batch: { medium: 7 * 86_400_000, low: 30 * 86_400_000 }, autoAdopt: ["critical", "high"] });
export type DepsConfig = z.infer<typeof depsSchema>;

/**
 * The mechanical lesson lifecycle's rules (BB-35 step 3): when a trial lesson
 * is promoted or retired, how many a wake may carry, and how many promoted
 * lessons a file holds. The defaults are the design's; a project overrides
 * any part under `lessons` and the rest fall back. `decayHalfLifeDays`
 * weights a citation by age, so an old burst of use does not keep a lesson
 * alive when the lowest-scoring one has to be displaced.
 */
export const lessonRulesSchema = z
  .object({
    trial: z
      .object({
        /** At most this many trial lessons in one wake. */
        max: z.number().int().min(1).max(50).default(5),
        /** A trial lesson uncited this long is retired. */
        retireDays: z.number().positive().max(3650).default(30),
      })
      .strict()
      .default({ max: 5, retireDays: 30 }),
    promote: z
      .object({
        /** Distinct bindings a trial lesson must be cited on to be promoted. */
        hits: z.number().int().min(1).max(50).default(3),
        /** Days a trial lesson must have been in trial before it may be promoted. */
        days: z.number().positive().max(3650).default(14),
      })
      .strict()
      .default({ hits: 3, days: 14 }),
    promoted: z
      .object({
        /** At most this many promoted lessons in one file; a promotion into a full file displaces the lowest-scoring one. */
        maxPerFile: z.number().int().min(1).max(100).default(10),
        /** A promoted lesson uncited this long is retired. */
        retireDays: z.number().positive().max(3650).default(90),
        /** Corrections that retire a promoted lesson. */
        corrections: z.number().int().min(1).max(50).default(2),
      })
      .strict()
      .default({ maxPerFile: 10, retireDays: 90, corrections: 2 }),
    /** A citation's weight halves every this many days. */
    decayHalfLifeDays: z.number().positive().max(3650).default(30),
    /**
     * Validation escalations (BB-35 step 5): the two rare conditions that ask
     * the user to confirm a lesson. `perWeek` caps how many of this project's
     * validation items may be filed in a rolling week, ordered by score; the
     * rest wait. The budget includes a boundary Merge/Drop the project steward
     * files by hand, so the user is not asked twice in one week.
     */
    validations: z
      .object({
        /** At most this many validation escalations (a boundary Merge/Drop, a mixed-evidence Keep/Retire) may be filed per rolling week, per project. */
        perWeek: z.number().int().min(0).max(50).default(1),
      })
      .strict()
      .default({ perWeek: 1 }),
  })
  .strict()
  .default({ trial: { max: 5, retireDays: 30 }, promote: { hits: 3, days: 14 }, promoted: { maxPerFile: 10, retireDays: 90, corrections: 2 }, decayHalfLifeDays: 30, validations: { perWeek: 1 } });
export type LessonRules = z.infer<typeof lessonRulesSchema>;

/**
 * One workflow dispatch a merge triggers (BB-216): when a pull request in
 * `repo` merges, the plugin dispatches `workflow` in `workflowRepo` on `ref`
 * with `inputs`, through the same GitHub writer the merge uses. `workflowRepo`
 * defaults to the merged repo and `ref` to the workflow repo's default branch.
 * With nothing configured, a merge dispatches nothing.
 */
export const mergeDispatchSchema = z
  .object({
    /** The merged pull request's repo, as GitHub spells it, e.g. bitcomplete/bb-plugins. */
    repo: z.string().trim().regex(REPO_NAME, "a repo such as bitcomplete/bb-plugins"),
    /** The workflow file or id to dispatch, e.g. bb-server.yaml. */
    workflow: z.string().trim().min(1).max(300),
    /** The repo the workflow lives in; the merged repo when omitted. */
    workflowRepo: z.string().trim().regex(REPO_NAME, "a repo such as bitcomplete/bb-gate").optional(),
    /** The ref to dispatch on; the workflow repo's default branch when omitted. */
    ref: z.string().trim().min(1).max(300).optional(),
    /** The workflow_dispatch inputs, as strings (a boolean input is "true"/"false"). */
    inputs: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type MergeDispatch = z.infer<typeof mergeDispatchSchema>;

/**
 * One ticket watch's match fields (BB-246): `labels` means every named label
 * is present on the issue, ignoring case, and `title` is a glob in the decide
 * list's `*`/`**` dialect. The same shape the pull watches use, without a
 * repo: a ticket watch is project-level.
 */
export const ticketMatchSchema = z
  .object({
    labels: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
    title: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/**
 * One project-level ticket watch (BB-246): an issue that already carries the
 * adoption label and is assigned to this server's login, and whose shape
 * matches, is adopted under `playbook`. The first matching watch wins; with
 * none, adoption is unchanged. A label change after adoption does not
 * re-route the binding.
 */
export const ticketWatchSchema = z.object({ match: ticketMatchSchema.default({}), playbook: playbookName }).strict();
export type TicketWatch = z.infer<typeof ticketWatchSchema>;

/**
 * The stable id of a ticket watch, recorded on the binding it adopts as
 * `adoptedBy` (BB-246): `<playbook>@ticket`. A ticket keeps its adoption
 * label, so unlike a pull watch this never replaces the label path.
 */
export const ticketWatchId = (watch: Pick<TicketWatch, "playbook">): string => `${watch.playbook}@ticket`;

export const projectFileSchema = z
  .object({
    version: z.literal(1),
    linear: z.object({ teams: z.array(teamKey).max(50).default([]) }).strict().default({ teams: [] }),
    /**
     * GitHub repos are the project's repos.json; these are left out of it,
     * for repos in the workspace that stewards should not manage.
     */
    github: z.object({ exclude: z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "a repo such as acme/web")).max(64).default([]) }).strict().default({ exclude: [] }),
    label: z.string().trim().min(1).max(100).default(DEFAULT_LABEL),
    nightly: z
      .object({
        at: clock.default("01:00"),
        timezone: z.string().refine(validTimezone, "an IANA time zone such as America/New_York").default("America/New_York"),
        /** Nothing new is started after this; bb-gate's quiet window restarts servers at 03:00 US Eastern. */
        until: clock.default("02:45"),
        /** At most this many binding turns per night. */
        max: z.number().int().min(0).max(1000).default(100),
      })
      .strict()
      .default({ at: "01:00", timezone: "America/New_York", until: "02:45", max: 100 }),
    projectSteward: z.object({ model: modelSpecSchema.optional() }).strict().default({}),
    /** Which playbook governs each kind of binding, and the two the dependency watch uses. */
    playbooks: z
      .object({
        ticket: playbookName.optional(),
        pr: playbookName.optional(),
        review: playbookName.optional(),
        ops: playbookName.optional(),
        [DEPS_ALERTS_PLAYBOOK]: playbookName.optional(),
        [DEPS_PRS_PLAYBOOK]: playbookName.optional(),
      })
      .strict()
      .default({}),
    /** Reviews: on unless turned off. */
    reviews: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
    /**
     * The stewards' needs-you pushes (BB-253): on unless turned off. Off
     * disables the pushes only; the steward threads are still muted.
     */
    notifications: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
    adoption: z.object({ perPass: z.number().int().min(1).max(100).default(10) }).strict().default({ perPass: 10 }),
    /**
     * Project-level ticket watches (BB-246): a labelled, assigned issue whose
     * shape matches is adopted under the named ticket playbook, before the
     * kind's default. The first match wins. Empty, adoption is unchanged.
     */
    tickets: z.array(ticketWatchSchema).max(50).default([]),
    /**
     * The decisions that reach the user. Everything else is decided by the
     * stewards and the project steward, from the project's own guidance.
     */
    bigDecisions: z.array(decideEntrySchema).max(60).default(() => defaultDecideList()),
    /**
     * The limits that already bind every pull request in this project, shown
     * in an approval wake so the project steward adds only what they do not
     * cover. Short rule lines; the plugin hard-codes none.
     */
    standingRules: z.array(z.string().trim().min(1).max(400)).max(40).default([]),
    /**
     * Production to watch: one ops binding per target, which files a Linear
     * ticket for each problem it finds and escalates it to the project
     * steward. `team` is where tickets are filed (the first of linear.teams
     * when left out); `context` is the kubeconfig context kubectl reads it
     * with; `autoAdopt` names the priorities whose tickets are labelled for
     * a steward when filed, without asking.
     */
    ops: z
      .object({
        targets: z.array(opsTargetSchema).max(10).default([]),
        team: filingTargetSchema.optional(),
        /** The kubeconfig context kubectl uses on the developer's machine; its current context when left out. */
        context: z.string().trim().min(1).max(200).regex(/^[^\s-][^\s]*$/u, "a kubeconfig context name").optional(),
        autoAdopt: z.array(z.enum(LINEAR_PRIORITIES)).max(4).default([]),
        /**
         * The Sentry write, off by default. On, the Sentry look resolves a
         * mapped issue whose ticket is Done and which Sentry still shows as
         * unresolved; Sentry's own regression detection reopens it if it fires
         * again. The token needs `event:write` for it.
         */
        sentry: z.object({ resolveOnDone: z.boolean().default(false) }).strict().default({ resolveOnDone: false }),
      })
      .strict()
      .default({ targets: [], autoAdopt: [], sentry: { resolveOnDone: false } }),
    /** The dependency watch: per-severity SLA, the batch window, and what auto-adopts. */
    deps: depsSchema,
    /** The mechanical lesson lifecycle's thresholds and caps (BB-35 step 3). */
    lessons: lessonRulesSchema,
    /**
     * Workflows a merge dispatches (BB-216): each entry names a merged repo
     * and the workflow to run after its pull requests merge. Empty, a merge
     * dispatches nothing and behaves exactly as before.
     */
    mergeDispatch: z.array(mergeDispatchSchema).max(20).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.ops.targets.forEach((t, i) => {
      const key = t.kind === "k8s-namespace" ? `${t.kind}/${t.name}` : t.kind === "dependabot" ? `${t.kind}/${t.repo.toLowerCase()}` : `${t.kind}/${t.org}/${t.project}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["ops", "targets", i], message: `${key} is listed twice` });
      seen.add(key);
    });
    if (file.ops.targets.length === 0) return;
    // A ticket filed outside the project's teams is never adopted, so the project steward could not act on it.
    if (file.ops.team === undefined && file.linear.teams.length === 0) ctx.addIssue({ code: "custom", path: ["ops", "team"], message: "ops needs a Linear team to file tickets in: set ops.team or linear.teams" });
    // A repo target (BB-235) is checked against the repo set by
    // `filingTargetProblems`, which the caller runs where repos are known; a
    // team key is checked here against the project's own teams.
    if (file.ops.team !== undefined && !REPO_NAME.test(file.ops.team) && !file.linear.teams.includes(file.ops.team)) ctx.addIssue({ code: "custom", path: ["ops", "team"], message: `${file.ops.team} is not one of linear.teams, so a ticket filed there would never be stewarded` });
  });
export type ProjectFile = z.infer<typeof projectFileSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length === 0 ? "" : `${i.path.join(".")}: `}${i.message}`).join("; ");
}

export function parseProjectFile(text: string): Parsed<ProjectFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${PROJECT_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = projectFileSchema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `${PROJECT_FILE}: ${zodMessage(parsed.error)}` };
}

// ---- roles: per-person watches, keyed by GitHub login ------------------------------

/**
 * The per-person roles file (BB-105). It is read like the project file — a git
 * repo at the canonical checkout's committed HEAD, a plain project directory
 * from `.bb` on disk — and each server runs only the entry whose key is its own
 * signed-in GitHub login. The watches with no natural
 * owner (namespace, Sentry project, Dependabot repo) are assigned here; the
 * ticket and review stewards are dispatched by the Linear assignee and the
 * GitHub requested reviewer, and need no entry.
 */

/** A GitHub login, folded to lower case by the parser. GitHub caps logins at 39 characters. */
const githubLogin = z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u, "a GitHub login such as jane-doe");

const sentryProjectSchema = z.object({ org: sentrySlug, project: sentrySlug }).strict();

const roleSentrySchema = z
  .object({
    projects: z.array(sentryProjectSchema).max(50).default([]),
    /** On, the Sentry look resolves a mapped issue whose ticket is Done (the project file's `ops.sentry.resolveOnDone`). */
    resolveOnDone: z.boolean().default(false),
  })
  .strict()
  .default({ projects: [], resolveOnDone: false });

/** One pull-request watch's match fields: every given field must match, and `paths` means every changed file matches one of its globs. */
export const pullMatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    branch: z.string().trim().min(1).max(300).optional(),
    author: z.string().trim().min(1).max(100).optional(),
    paths: z.array(z.string().trim().min(1).max(300)).min(1).max(200).optional(),
  })
  .strict();

/**
 * One pull-request watch a role declares (BB-164): PRs in `repo` whose shape
 * matches, adopted under `playbook` on the holder's server alone. `match` is
 * a glob per field, using the decide list's `*`/`**` dialect.
 */
export const pullWatchSchema = z.object({ repo: dependabotRepoSchema, match: pullMatchSchema.default({}), playbook: playbookName }).strict();

/**
 * A pull watch as the matcher reads it. `author` is a string on a declared
 * watch; the synthesized Dependabot watch names every bot login, so the type
 * allows a list there.
 */
export type PullMatch = { title?: string; branch?: string; author?: string | string[]; paths?: string[] };
export type PullWatch = { repo: string; match: PullMatch; playbook: string };

/**
 * The stable id of a watch, recorded on the binding it adopts as `adoptedBy`
 * and shown by `bb stewards list` (BB-164): `<playbook>@<repo>`. It is what a
 * binding reads to know a watch, not a label or review path, adopted it.
 */
export const pullWatchId = (watch: Pick<PullWatch, "repo" | "playbook">): string => `${watch.playbook}@${watch.repo.toLowerCase()}`;

/** A role's watches: namespaces, Sentry projects, Dependabot repos, pull watches, and where its tickets file. */
export const roleOpsSchema = z
  .object({
    k8sNamespaces: z.array(z.string().trim().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u, "a namespace name such as bb-gate-production")).max(50).default([]),
    /** The kubeconfig context kubectl uses on this person's machine; its current context when left out. */
    context: z.string().trim().min(1).max(200).regex(/^[^\s-][^\s]*$/u, "a kubeconfig context name").optional(),
    /** Where this person's ops tickets are filed (the first of linear.teams when left out): a Linear team key or a GitHub owner/repo. */
    team: filingTargetSchema.optional(),
    autoAdopt: z.array(z.enum(LINEAR_PRIORITIES)).max(4).default([]),
    sentry: roleSentrySchema,
    /** Repos whose Dependabot alerts this person watches; `"all"` is every repo in repos.json less github.exclude. */
    dependabot: z.union([z.literal("all"), z.array(dependabotRepoSchema).max(200)]).optional(),
    /** Pull requests this role's server adopts by shape, under a playbook, with no label (BB-164). */
    pulls: z.array(pullWatchSchema).max(50).default([]),
  })
  .strict();
export type RoleOps = z.infer<typeof roleOpsSchema>;

/** One person's role: whether their server is the project steward, and the watches it runs. */
export const roleSchema = z.object({ projectSteward: z.boolean().default(false), ops: roleOpsSchema.optional() }).strict();
export type Role = z.infer<typeof roleSchema>;

/** The built-in role name for the project steward. It has no `roles` definition. */
export const PROJECT_STEWARD_ROLE = "projectSteward";

/** A named role in a version 2 file. */
const roleNameSchema = z.string().min(1).max(63).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u, "a role name such as ops");

/**
 * The normalized roles file. Both versions read into this shape: `roles` is
 * the effective role each login runs (the merge of every role it holds), so
 * every consumer of `config.role` is unchanged. `holders` keeps the role
 * names a login holds for display and validation, and `definitions` keeps
 * the named definitions so `check` can report an unknown or unheld one.
 */
export type RolesFile = {
  /** 1 for the login-keyed shape, 2 for named role definitions and holders. */
  version: 1 | 2;
  /** login -> the effective role: the merge of every role it holds. */
  roles: Record<string, Role>;
  /** login -> the role names it holds, in order. Version 1 synthesizes the login itself. */
  holders: Record<string, string[]>;
  /** role name -> its ops definition. Version 1 synthesizes one per login. `projectSteward` is never a key. */
  definitions: Record<string, RoleOps>;
};

const rolesFileV1RawSchema = z.object({ version: z.literal(1), roles: z.record(z.string(), roleSchema) }).strict();

/**
 * Folds every login to lower case and refuses two keys that name the same
 * login ignoring case. Duplicate JSON keys are collapsed by `JSON.parse`
 * before this runs; the check catches `Jane` and `jane` in one file. Each
 * login becomes one synthesized role named after the login, held by it alone.
 */
const rolesFileV1Schema = rolesFileV1RawSchema.transform((file, ctx): RolesFile => {
  const roles: Record<string, Role> = {};
  const holders: Record<string, string[]> = {};
  const definitions: Record<string, RoleOps> = {};
  for (const [key, role] of Object.entries(file.roles)) {
    const parsed = githubLogin.safeParse(key);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["roles", key], message: `${JSON.stringify(key)} is not a GitHub login` });
      return z.NEVER;
    }
    const login = parsed.data.toLowerCase();
    if (roles[login] !== undefined) {
      ctx.addIssue({ code: "custom", path: ["roles", key], message: `${key} names the same login as another entry, ignoring case` });
      return z.NEVER;
    }
    holders[login] = [login, ...(role.projectSteward ? [PROJECT_STEWARD_ROLE] : [])];
    if (role.ops !== undefined) definitions[login] = role.ops;
    roles[login] = role;
  }
  return { version: 1, roles, holders, definitions };
});

const rolesFileV2RawSchema = z
  .object({
    version: z.literal(2),
    /** The named role definitions: today's `roleOpsSchema` body, once per name. */
    roles: z.record(roleNameSchema, roleOpsSchema),
    /** login -> the role names it holds. `projectSteward` is a built-in name. */
    holders: z.record(z.string(), z.array(roleNameSchema).min(1).max(50)),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (Object.prototype.hasOwnProperty.call(file.roles, PROJECT_STEWARD_ROLE)) {
      ctx.addIssue({ code: "custom", path: ["roles", PROJECT_STEWARD_ROLE], message: `${PROJECT_STEWARD_ROLE} is a built-in role with no definition; remove it from roles` });
    }
  });

/**
 * The merge of a holder's role definitions, in the order the holder lists
 * them. List fields are unioned; `context` and `team` take the first defined
 * value (a disagreement is a `check` problem, never a runtime change);
 * `dependabot: "all"` wins over an explicit list.
 */
function mergeRoleOps(defs: readonly RoleOps[]): RoleOps {
  const k8sNamespaces: string[] = [];
  const autoAdopt: RoleOps["autoAdopt"] = [];
  const projects: RoleOps["sentry"]["projects"] = [];
  const dependabot: string[] = [];
  const pulls: RoleOps["pulls"] = [];
  let dependabotAll = false;
  let context: string | undefined;
  let team: string | undefined;
  let resolveOnDone = false;
  for (const def of defs) {
    for (const name of def.k8sNamespaces) if (!k8sNamespaces.includes(name)) k8sNamespaces.push(name);
    for (const priority of def.autoAdopt) if (!autoAdopt.includes(priority)) autoAdopt.push(priority);
    for (const project of def.sentry.projects) if (!projects.some((p) => p.org === project.org && p.project === project.project)) projects.push(project);
    if (def.context !== undefined && context === undefined) context = def.context;
    if (def.team !== undefined && team === undefined) team = def.team;
    if (def.sentry.resolveOnDone) resolveOnDone = true;
    if (def.dependabot === "all") dependabotAll = true;
    else if (Array.isArray(def.dependabot)) for (const repo of def.dependabot) if (!dependabot.includes(repo)) dependabot.push(repo);
    for (const watch of def.pulls) if (!pulls.some((w) => samePullWatch(w, watch))) pulls.push(watch);
  }
  const ops: RoleOps = { k8sNamespaces, autoAdopt, sentry: { projects, resolveOnDone }, pulls };
  if (context !== undefined) ops.context = context;
  if (team !== undefined) ops.team = team;
  if (dependabotAll) ops.dependabot = "all";
  else if (dependabot.length > 0) ops.dependabot = dependabot;
  return ops;
}

/** Whether two watches are the same declaration, so a holder of several roles does not double them. */
function samePullWatch(a: PullWatch, b: PullWatch): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase() && a.playbook === b.playbook && JSON.stringify(a.match) === JSON.stringify(b.match);
}

/** The effective role a holder runs: the merge of the roles it holds, and whether one is `projectSteward`. */
function effectiveRole(names: readonly string[], definitions: Record<string, RoleOps>): Role {
  const defs = names.filter((name) => name !== PROJECT_STEWARD_ROLE).map((name) => definitions[name]).filter((def): def is RoleOps => def !== undefined);
  return { projectSteward: names.includes(PROJECT_STEWARD_ROLE), ...(defs.length === 0 ? {} : { ops: mergeRoleOps(defs) }) };
}

/** Folds holder logins to lower case and refuses two that name the same login ignoring case. */
const rolesFileV2Schema = rolesFileV2RawSchema.transform((file, ctx): RolesFile => {
  const holders: Record<string, string[]> = {};
  for (const [key, names] of Object.entries(file.holders)) {
    const parsed = githubLogin.safeParse(key);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["holders", key], message: `${JSON.stringify(key)} is not a GitHub login` });
      return z.NEVER;
    }
    const login = parsed.data.toLowerCase();
    if (holders[login] !== undefined) {
      ctx.addIssue({ code: "custom", path: ["holders", key], message: `${key} names the same login as another entry, ignoring case` });
      return z.NEVER;
    }
    holders[login] = [...new Set(names)];
  }
  const roles: Record<string, Role> = {};
  for (const [login, names] of Object.entries(holders)) roles[login] = effectiveRole(names, file.roles);
  return { version: 2, roles, holders, definitions: file.roles };
});

export function parseRolesFile(text: string): Parsed<RolesFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${ROLES_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  const parsed = (version === 2 ? rolesFileV2Schema : rolesFileV1Schema).safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `${ROLES_FILE}: ${zodMessage(parsed.error)}` };
}

// ---- the role one server runs --------------------------------------------------------

/** The k8s namespaces a role watches, which are read with kubectl. */
export const roleK8sTargets = (role: Role | null): K8sTarget[] => (role?.ops?.k8sNamespaces ?? []).map((name) => ({ kind: "k8s-namespace", name }));

/** The Sentry projects a role watches, which are read with the plugin's Sentry token and rung by bb-gate-hooks. */
export const roleSentryTargets = (role: Role | null): SentryTarget[] => (role?.ops?.sentry?.projects ?? []).map((p) => ({ kind: "sentry-project", org: p.org, project: p.project }));

/** The namespace and Sentry targets a role watches; the Dependabot watch is separate because it defaults to every repo. */
export const roleOpsTargets = (role: Role | null): OpsTarget[] => [...roleK8sTargets(role), ...roleSentryTargets(role)];

/**
 * The Dependabot alert targets a role watches: `"all"` is every repo in the
 * project's derived set (`repos.json` less `github.exclude`), an explicit list
 * is exactly those, and no `dependabot` key is none.
 */
export function roleDepsTargets(role: Role | null, repos: readonly string[]): DependabotTarget[] {
  const dep = role?.ops?.dependabot;
  return (dep === "all" ? [...repos] : dep ?? []).map((repo) => ({ kind: "dependabot" as const, repo }));
}

/** The pull watches a role declares, in the order the file lists them. */
export const rolePulls = (role: Role | null): PullWatch[] => role?.ops?.pulls ?? [];

/**
 * Every pull watch a role's server runs: the Dependabot watches synthesized
 * from `dependabot` first, then the role's declared watches, first match wins
 * (BB-164). A synthesized watch names every bot login as its `match.author`
 * and runs the deps-prs playbook.
 */
export function rolePullWatches(role: Role | null, repos: readonly string[], depsPrsName: string): PullWatch[] {
  const synthesized: PullWatch[] = roleDepsTargets(role, repos).map((t) => ({ repo: t.repo, match: { author: [...DEPENDENCY_BOTS] }, playbook: depsPrsName }));
  return [...synthesized, ...rolePulls(role)];
}

/** The Linear team a role's ops steward files in (the first of linear.teams when the role names none), with its source. */
export const roleOpsTeam = (role: Role | null, project: ProjectFile): FilingTarget | null => {
  const target = role?.ops?.team ?? project.linear.teams[0] ?? null;
  return target === null ? null : filingTargetOf(target);
};

/**
 * Whether a role watches a namespace or Sentry project, so the ops-watch
 * playbook is needed. The Dependabot watch runs the separate deps-alerts
 * playbook, so it does not count here.
 */
export const roleUsesOps = (role: Role | null): boolean => roleK8sTargets(role).length > 0 || roleSentryTargets(role).length > 0;

/**
 * Whether a project uses a kind of binding at all: reviews can be turned off,
 * and ops needs a target. `role` is the server's resolved role: omitted, the
 * legacy `project.ops` is read (a project without a roles.json); null, the
 * server has no role and runs no ops.
 */
export const usesKind = (project: ProjectFile, kind: BindingKind, role?: Role | null): boolean =>
  kind === "review" ? project.reviews.enabled : kind === "ops" ? (role === undefined ? project.ops.targets.length > 0 : roleUsesOps(role)) : true;

/**
 * The playbook a project file names for a kind. A ticket with no explicit
 * playbook follows the source the project tracks: `github-issues` when it has
 * no Linear teams (a GitHub-tracked project), `linear-tickets` otherwise.
 */
export const playbookNameFor = (project: ProjectFile, kind: BindingKind): string =>
  project.playbooks[kind] ?? (kind === "ticket" && project.linear.teams.length === 0 ? DEFAULT_GITHUB_TICKET_PLAYBOOK : DEFAULT_PLAYBOOKS[kind]);

export const opsTargets = (project: ProjectFile): OpsTarget[] => project.ops.targets;

/** The k8s namespaces to watch, which are read with kubectl. */
export const k8sTargets = (project: ProjectFile): K8sTarget[] => project.ops.targets.filter((t): t is K8sTarget => t.kind === "k8s-namespace");

/** The Sentry projects to watch, which are read with the plugin's Sentry token and rung by bb-gate-hooks. */
export const sentryTargets = (project: ProjectFile): SentryTarget[] => project.ops.targets.filter((t): t is SentryTarget => t.kind === "sentry-project");

/**
 * The Dependabot alert targets: the project file's explicit `dependabot`
 * targets, or every repo in `repos.json` not in `github.exclude` when it
 * lists none. `repos` is the project's derived repo set.
 */
export function depsTargets(project: ProjectFile, repos: readonly string[]): DependabotTarget[] {
  const explicit = project.ops.targets.filter((t): t is DependabotTarget => t.kind === "dependabot").map((t) => t.repo);
  return (explicit.length > 0 ? explicit : [...repos]).map((repo) => ({ kind: "dependabot" as const, repo }));
}

/** The playbook a binding runs under: the deps-alerts one for a Dependabot target, else its kind's. */
export const depsAlertsPlaybookName = (project: ProjectFile): string => project.playbooks[DEPS_ALERTS_PLAYBOOK] ?? DEPS_ALERTS_PLAYBOOK;
export const depsPrsPlaybookName = (project: ProjectFile): string => project.playbooks[DEPS_PRS_PLAYBOOK] ?? DEPS_PRS_PLAYBOOK;

/** The Linear team or GitHub repo an ops steward files in, with its source. */
export const opsTeam = (project: ProjectFile): FilingTarget | null => {
  const target = project.ops.team ?? project.linear.teams[0] ?? null;
  return target === null ? null : filingTargetOf(target);
};

// ---- migration and the project steward's role problems ---------------------------------

/**
 * Whether a project file still carries watches that now belong in roles.json.
 * An empty `ops` block (the init template's) is not carrying anything.
 */
export const legacyOpsPresent = (project: ProjectFile): boolean =>
  project.ops.targets.length > 0 || project.ops.team !== undefined || project.ops.context !== undefined || project.ops.autoAdopt.length > 0 || project.ops.sentry.resolveOnDone;

/**
 * A project file's legacy `ops` as a role, so a project with no roles.json runs
 * exactly as before: every server is the project steward and runs every watch.
 * The Dependabot default (every repo) becomes `"all"`.
 */
export function legacyRole(project: ProjectFile): Role {
  const explicit = project.ops.targets.filter((t): t is DependabotTarget => t.kind === "dependabot").map((t) => t.repo);
  return {
    projectSteward: true,
    ops: {
      k8sNamespaces: k8sTargets(project).map((t) => t.name),
      ...(project.ops.team === undefined ? {} : { team: project.ops.team }),
      ...(project.ops.context === undefined ? {} : { context: project.ops.context }),
      autoAdopt: [...project.ops.autoAdopt],
      sentry: { projects: sentryTargets(project).map((t) => ({ org: t.org, project: t.project })), resolveOnDone: project.ops.sentry.resolveOnDone },
      dependabot: explicit.length > 0 ? explicit : "all",
      pulls: [],
    },
  };
}

/** The words the project steward's problem lines use for one watch. */
function watchLabel(key: string): string {
  if (key.startsWith("k8s-namespace/")) return `the ${key.slice("k8s-namespace/".length)} watch`;
  if (key.startsWith("sentry-project/")) return `the Sentry watch for ${key.slice("sentry-project/".length)}`;
  return `the Dependabot watch for ${key.slice("dependabot/".length)}`;
}

/** Every watch a role runs, keyed as `opsTargetKey` keys the same target. */
function roleWatchKeys(role: Role, repos: readonly string[]): string[] {
  return [...roleOpsTargets(role), ...roleDepsTargets(role, repos)].map(opsTargetKey);
}

/**
 * The watches the project expects someone to run: the legacy `ops` targets,
 * and the Dependabot default (every repo) while the dependency watch is on. A
 * watch in no role is unowned; one in two roles is doubly owned.
 */
export function expectedWatches(project: ProjectFile, repos: readonly string[], depsEnabled: boolean): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label: watchLabel(key) });
  };
  for (const t of k8sTargets(project)) add(opsTargetKey(t));
  for (const t of sentryTargets(project)) add(opsTargetKey(t));
  const explicit = project.ops.targets.filter((t): t is DependabotTarget => t.kind === "dependabot").map((t) => t.repo);
  if (explicit.length > 0) for (const repo of explicit) add(opsTargetKey({ kind: "dependabot", repo }));
  else if (depsEnabled) for (const repo of repos) add(opsTargetKey({ kind: "dependabot", repo }));
  return out;
}

/**
 * The project steward's problem lines about who owns what: a watch nobody
 * runs, and a watch two people run. Credentials are checked on each server,
 * never here: a role whose machine lacks kubectl or a Sentry token is that
 * server's own problem line.
 */
export function watchProblems(project: ProjectFile, roles: RolesFile, repos: readonly string[], depsEnabled: boolean): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string[]>();
  for (const [login, role] of Object.entries(roles.roles)) {
    for (const key of roleWatchKeys(role, repos)) owners.set(key, [...(owners.get(key) ?? []), login]);
  }
  const expected = expectedWatches(project, repos, depsEnabled);
  for (const watch of expected) {
    const list = owners.get(watch.key) ?? [];
    if (list.length === 0) problems.push(`nobody runs ${watch.label}`);
    else if (list.length > 1) problems.push(`two people run ${watch.label}: ${list.join(", ")}`);
  }
  // A watch two roles name that the project does not otherwise expect: a namespace, say.
  for (const [key, list] of owners) {
    if (list.length > 1 && !expected.some((w) => w.key === key)) problems.push(`two people run ${watchLabel(key)}: ${list.join(", ")}`);
  }
  return problems;
}

/**
 * The `check` problems of every declared pull watch (BB-164): its repo must be
 * one the project leases (in `repos.json`, not in `github.exclude`), its
 * playbook must exist and be kind `pr`, its globs must parse, and no two roles
 * with holders may declare a watch on the same repo — an error, not a warning,
 * since it is the only place two servers adopting the same pull request can be
 * caught. `playbooks` holds every watch playbook that parsed; a missing one was
 * already reported where it was read.
 */
export function pullWatchProblems(roles: RolesFile, repos: readonly string[], excluded: readonly string[], playbooks: ReadonlyMap<string, Playbook>): string[] {
  const problems: string[] = [];
  const repoOwners = new Map<string, string[]>();
  for (const [login, role] of Object.entries(roles.roles)) {
    for (const watch of rolePulls(role)) {
      const where = `roles.json: the pull watch on ${watch.repo} for ${JSON.stringify(login)}`;
      if (excluded.some((r) => r.toLowerCase() === watch.repo.toLowerCase())) problems.push(`${where}: the repo is in github.exclude, so it is not stewarded`);
      else if (!repos.some((r) => r.toLowerCase() === watch.repo.toLowerCase())) problems.push(`${where}: the repo is not in repos.json, so the project has no lease for it and gets no doorbells`);
      const playbook = playbooks.get(watch.playbook);
      if (playbook !== undefined && playbook.kind !== "pr") problems.push(`${where}: the playbook ${JSON.stringify(watch.playbook)} is a ${playbook.kind} playbook, not a pr playbook`);
      for (const [field, value] of [
        ["match.title", watch.match.title],
        ["match.branch", watch.match.branch],
        ["match.author", Array.isArray(watch.match.author) ? undefined : watch.match.author],
      ] as const) {
        const bad = value === undefined ? null : globError(value);
        if (bad !== null) problems.push(`${where}: ${field} is not a glob: ${bad}`);
      }
      for (const pattern of watch.match.paths ?? []) {
        const bad = globError(pattern);
        if (bad !== null) problems.push(`${where}: match.paths ${bad}`);
      }
      const owners = repoOwners.get(watch.repo.toLowerCase()) ?? [];
      if (!owners.includes(login)) repoOwners.set(watch.repo.toLowerCase(), [...owners, login]);
    }
  }
  for (const [repo, owners] of repoOwners) {
    if (owners.length > 1) problems.push(`two roles with holders declare pull watches on ${repo}: ${owners.join(", ")} — only one server can adopt a pull request, so remove one`);
  }
  return problems;
}

/**
 * The `check` problems of every declared ticket watch (BB-246): its playbook
 * must exist and be kind `ticket`, and its `title` glob must parse. `playbooks`
 * holds every watch and ticket playbook that parsed; `errors` holds the
 * load-time reason for a ticket watch playbook that did not (the loader
 * reports those here instead, so one watch gets one problem line).
 */
export function ticketWatchProblems(file: ProjectFile, playbooks: ReadonlyMap<string, Playbook>, errors: ReadonlyMap<string, string> = new Map()): string[] {
  const problems: string[] = [];
  file.tickets.forEach((watch, i) => {
    const where = `project.json: tickets[${i}]`;
    const playbook = playbooks.get(watch.playbook);
    if (playbook === undefined) {
      const reason = errors.get(watch.playbook);
      problems.push(reason === undefined ? `${where}: the playbook ${JSON.stringify(watch.playbook)} does not exist` : `${where}: the playbook ${JSON.stringify(watch.playbook)}: ${reason}`);
    } else if (playbook.kind !== "ticket") problems.push(`${where}: the playbook ${JSON.stringify(watch.playbook)} is a ${playbook.kind} playbook, not a ticket playbook`);
    if (watch.match.title !== undefined) {
      const bad = globError(watch.match.title);
      if (bad !== null) problems.push(`${where}: match.title is not a glob: ${bad}`);
    }
  });
  return problems;
}

/**
 * The role names whose definitions produce each of a holder's target keys: what
 * `bb stewards list` and the board attribute a binding to. A login with no
 * roles, or a target no role owns, maps to nothing.
 */
export function bindingRoles(roles: RolesFile | null, login: string | null, repos: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (roles === null || login === null) return out;
  for (const name of roles.holders[login] ?? []) {
    if (name === PROJECT_STEWARD_ROLE) continue;
    const definition = roles.definitions[name];
    if (definition === undefined) continue;
    const role: Role = { projectSteward: false, ops: definition };
    for (const target of [...roleOpsTargets(role), ...roleDepsTargets(role, repos)]) {
      const key = opsTargetKey(target);
      const list = out.get(key) ?? [];
      if (!list.includes(name)) out.set(key, [...list, name]);
    }
    // A pull binding is keyed by the watch that adopted it, not a target key.
    for (const watch of rolePulls(role)) {
      const key = pullWatchId(watch);
      const list = out.get(key) ?? [];
      if (!list.includes(name)) out.set(key, [...list, name]);
    }
  }
  return out;
}

/**
 * The project steward count problem, or null when one or more holders hold it.
 * Two or more holders is normal (BB-230): each server runs only its own login's
 * roles, so every developer whose server runs stewards can hold the role.
 */
export function projectStewardProblem(roles: RolesFile): string | null {
  const stewards = Object.entries(roles.roles).filter(([, role]) => role.projectSteward).map(([login]) => login);
  if (stewards.length === 0) {
    return roles.version === 2
      ? `no one holds ${PROJECT_STEWARD_ROLE}: give one holder the ${PROJECT_STEWARD_ROLE} role in roles.json`
      : "no one is the project steward: set projectSteward: true on one login in roles.json";
  }
  return null;
}

/**
 * The version 2 validation errors a `check` reports: a holder names a role
 * that is neither defined nor the built-in `projectSteward`, or a holder's
 * roles disagree on `context` or `team`. The runtime never acts on these: the
 * effective role is merged deterministically and the same file keeps running.
 */
export function roleProblems(roles: RolesFile): string[] {
  if (roles.version !== 2) return [];
  const problems: string[] = [];
  for (const [login, names] of Object.entries(roles.holders)) {
    for (const name of names) {
      if (name !== PROJECT_STEWARD_ROLE && roles.definitions[name] === undefined) {
        problems.push(`${login} holds an unknown role ${JSON.stringify(name)}: define it under roles, or use ${PROJECT_STEWARD_ROLE}`);
      }
    }
    const defs = names.map((name) => roles.definitions[name]).filter((def): def is RoleOps => def !== undefined);
    const contexts = [...new Set(defs.map((def) => def.context).filter((value): value is string => value !== undefined))];
    if (contexts.length > 1) problems.push(`${login} holds roles with conflicting context (${contexts.join(", ")}): a holder's roles must agree on one context`);
    const teams = [...new Set(defs.map((def) => def.team).filter((value): value is string => value !== undefined))];
    if (teams.length > 1) problems.push(`${login} holds roles with conflicting team (${teams.join(", ")}): a holder's roles must agree on one team`);
  }
  return problems;
}

/** The version 2 warnings a `check` reports: a defined role no holder names. */
export function roleWarnings(roles: RolesFile): string[] {
  if (roles.version !== 2) return [];
  const held = new Set(Object.values(roles.holders).flat());
  return Object.keys(roles.definitions)
    .filter((name) => !held.has(name))
    .map((name) => `role ${JSON.stringify(name)} has no holder`);
}

/**
 * The problems with a project's filing targets (BB-235): a GitHub `owner/repo`
 * that is not in the project's repo set, and a role's Linear team key that is
 * not one of `linear.teams`. A project file's team key is checked by the
 * schema itself; this adds the repo case the schema cannot see (the repo set
 * comes from `repos.json`) and the role cases the schema never checks.
 */
export function filingTargetProblems(project: ProjectFile, roles: RolesFile | null, repos: readonly string[]): string[] {
  const out: string[] = [];
  const repoProblem = (where: string, target: string) => {
    if (!repos.some((r) => r.toLowerCase() === target.toLowerCase())) out.push(`${where}: ${target} is not in repos.json, so a ticket filed there would never be stewarded`);
  };
  const teamProblem = (where: string, target: string) => {
    if (!project.linear.teams.includes(target)) out.push(`${where}: ${target} is not one of linear.teams, so a ticket filed there would never be stewarded`);
  };
  const projectTarget = project.ops.team;
  if (projectTarget !== undefined && REPO_NAME.test(projectTarget)) repoProblem(`${PROJECT_FILE} ops.team`, projectTarget);
  for (const [login, role] of Object.entries(roles?.roles ?? {})) {
    const target = role.ops?.team;
    if (target === undefined) continue;
    if (REPO_NAME.test(target)) repoProblem(`${ROLES_FILE} ${login}'s ops.team`, target);
    else teamProblem(`${ROLES_FILE} ${login}'s ops.team`, target);
  }
  return out;
}

// ---- playbooks ---------------------------------------------------------------------

export const STAGES = ["spec", "build", "review"] as const;
export type Stage = (typeof STAGES)[number];

/** What a steward raises. */
export const ESCALATION_KINDS = ["blocked", "decision", "scope", "conflict", "stuck"] as const;
/** Those, and the plugin's own: a ready gate waiting on its approver, a ready ticket waiting to be scheduled against work already under way, and a binding that has woken by requeue alone with an unchanged wait (BB-154). */
export type EscalationKind = (typeof ESCALATION_KINDS)[number] | "approval" | "schedule" | "stall";

/** A phase key that names a label rather than a workflow state (BB-248): `label:<name>`. */
const LABEL_PHASE = /^label:(.+)$/iu;

/** The label a `label:` phase key names, or null when the key is a workflow state. */
export function labelPhaseName(key: string): string | null {
  const m = LABEL_PHASE.exec(key);
  return m === null ? null : m[1]!;
}

/** A phase key: a workflow state, or `label:<name>` with a non-empty name (BB-248). */
const phaseKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .superRefine((key, ctx) => {
    if (/^label:/iu.test(key) && labelPhaseName(key) === null) ctx.addIssue({ code: "custom", message: "a label: phase key needs a label name after the colon" });
  });

const phaseSchema = z
  .object({
    stage: z.enum(STAGES).optional(),
    /** A status record that has not advanced in this long raises `stuck`. */
    stuck: durationSchema.optional(),
  })
  .strict();

/** Who approves a substantial ticket: the project steward (default), the user, or a source state (a Linear workflow state, or a GitHub status label). */
export const approvalModeSchema = z.union([
  z.literal("project"),
  z.literal("user"),
  z
    .object({
      state: z.string().trim().min(1).max(100).optional(),
      /** The pre-BB-232 spelling; accepted and normalised to `state`. */
      "linear-state": z.string().trim().min(1).max(100).optional(),
    })
    .strict()
    .refine((v) => v.state !== undefined || v["linear-state"] !== undefined, { message: "approval needs a state" })
    .refine((v) => v.state === undefined || v["linear-state"] === undefined, { message: "name either state or linear-state, not both" })
    .transform((v) => ({ state: v.state ?? v["linear-state"]! })),
]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

const readySchema = z
  .object({
    checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
    substantial: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    // BB-209: `user` is the canonical value; the pre-rename `me` alias is still
    // accepted and parsePlaybook normalises it to `user` with a warning.
    approval: z.union([approvalModeSchema, z.literal("me")]).default("project"),
  })
  .strict();
export type ReadyConfig = Omit<z.infer<typeof readySchema>, "approval"> & { approval: ApprovalMode };

/** The default cap on follow-through: a deploy and its verification, with room to spare. */
export const DEFAULT_FOLLOW_THROUGH_MS = 6 * 3_600_000;

/**
 * One deployment rule's match: the merged pull request's repo, and optionally
 * the changed paths it must touch. A rule whose `when` matches the merge is
 * the one whose strategy decides whether a deployment carries it.
 */
export const carriesWhenSchema = z
  .object({
    repo: z.string().trim().regex(REPO_NAME, "a repo such as bitcomplete/bb-plugins"),
    paths: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  })
  .strict();
export type CarriesWhen = z.infer<typeof carriesWhenSchema>;

/**
 * How a deployment is judged to carry a merge. `ref-contains-merge` asks
 * whether the deployment's ref has the merge as an ancestor. `image-tag`
 * reads the image tag the manifest applies, finds the workflow run it names,
 * and compares the merge against what that run built: the run's head sha, or
 * the commit whose Dockerfile pinned a consumer (BB-132).
 */
export const carriesStrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ref-contains-merge") }).strict(),
  z
    .object({
      kind: z.literal("image-tag"),
      /** The kustomization file, read at the deployment's ref, e.g. kploy/production/kustomization.yaml. */
      manifest: z.string().trim().min(1).max(500),
      /** The image whose `newTag` names the run, e.g. bb-server. */
      image: z.string().trim().min(1).max(200),
      /** The workflow file whose run number the tag is, e.g. bb-server.yaml. */
      workflow: z.string().trim().min(1).max(300),
      /** The build job whose `started_at` the pin is read as of, when the image is built from a pin. */
      job: z.string().trim().min(1).max(200).optional(),
      /** Where the pin lives and points: the Dockerfile, its ARG and the repo the pin names. */
      consumer: z
        .object({
          dockerfile: z.string().trim().min(1).max(500),
          pinArg: z.string().trim().min(1).max(200),
          repo: z.string().trim().regex(REPO_NAME, "a repo such as bitcomplete/bb-plugins"),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type CarriesStrategy = z.infer<typeof carriesStrategySchema>;

/** One ordered rule: a `when` match and the strategy to apply. */
export const carriesRuleSchema = z.object({ when: carriesWhenSchema, strategy: carriesStrategySchema }).strict();
export type CarriesRule = z.infer<typeof carriesRuleSchema>;

/**
 * A deployment target's `carries`: free text the steward applies (the older
 * behaviour, byte for byte), or an ordered list of rules the plugin evaluates
 * itself, first match wins. All additive: a string still parses.
 */
export const carriesSchema = z.union([z.string().trim().min(1).max(2000), z.array(carriesRuleSchema).min(1).max(20)]);
export type Carries = z.infer<typeof carriesSchema>;

/**
 * Where a merge is confirmed live: the deployment source, the target repo and
 * environment, the rule the steward applies to decide whether a deployment
 * carries its merge, and how long to wait for one. A playbook with no
 * `deployment` behaves exactly as before; the plugin records nothing and the
 * steward follows through however its playbook says.
 */
export const deploymentTargetSchema = z
  .object({
    /** An optional name, so a playbook with more than one target can name it in reports and wakes. */
    name: z.string().trim().min(1).max(100).optional(),
    source: z.literal("github"),
    /** The repo the deployment is created on, as GitHub spells it, e.g. bitcomplete/bb-gate. */
    repo: z.string().trim().regex(REPO_NAME, "a repo such as bitcomplete/bb-gate"),
    /** The deployment environment that confirms it, matched ignoring case. */
    environment: z.string().trim().min(1).max(100),
    /**
     * The rule for whether a deployment carries a merge: free text the steward
     * applies, or an ordered list of rules the plugin evaluates itself, first
     * match wins. A string keeps the older behaviour exactly.
     */
    carries: carriesSchema,
    /** No matching deployment within this long wakes the steward. */
    timeout: durationSchema.default(DEFAULT_FOLLOW_THROUGH_MS),
    /**
     * The GitHub Actions workflows whose failure matters while a merge waits
     * for a deployment (BB-61). Each entry is matched, ignoring case, against
     * a run's file path (`.github/workflows/bb-server.yaml`), its basename
     * (`bb-server.yaml`) or its name (`bb-server`). Empty, or absent, wakes
     * nobody for a `workflow_run` doorbell: today's behaviour exactly. The
     * plugin forwards the fact that a named workflow failed and leaves what
     * that means to the playbook; it reads no image, tag or pin.
     */
    workflows: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict();
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;

/**
 * One deployment target, or an ordered list of them, as a playbook's
 * `deployment` field writes it. A single target is today's shape; a list lets
 * one merge be awaited on more than one deployment (BB-132).
 */
export const deploymentsFieldSchema = z
  .union([deploymentTargetSchema, z.array(deploymentTargetSchema).min(1).max(10)])
  .superRefine((value, ctx) => {
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set<string>();
    for (const target of list) {
      const key = (target.name ?? `${target.repo}@${target.environment}`).toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `${key} is listed twice; each deployment target needs its own name` });
      seen.add(key);
    }
  });

export const PLAYBOOK_SOURCES = ["linear", "github", "k8s", "sentry"] as const;
const SOURCES_OF: Record<BindingKind, readonly (typeof PLAYBOOK_SOURCES)[number][]> = { ticket: ["linear", "github"], pr: ["github"], review: ["github"], ops: ["k8s", "github", "sentry"] };

export const frontMatterSchema = z
  .object({
    name: playbookName,
    kind: z.enum(KINDS),
    /** Where the entity lives; an ops playbook watches k8s, and has no entity state. */
    source: z.enum(PLAYBOOK_SOURCES),
    /** Required for every kind but ops, which has none. */
    phases: z.record(phaseKeySchema, phaseSchema.nullable().transform((p) => p ?? {})).optional(),
    terminal: z.array(z.string().trim().min(1).max(100)).default([]),
    ready: readySchema.optional(),
    /**
     * Reviews (BB-207): the criteria that make a pull request substantial, the
     * way `ready.substantial` lists them for a ticket. The reviewer judges the
     * diff against them and reports the verdict on the binding; a substantial
     * pull request with no approved spec on a referenced ticket is the owner's.
     * A review playbook with no list behaves exactly as before.
     */
    substantial: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    promote: z.string().trim().max(1000).optional(),
    /** What the steward may do on the entity. Policy the wake states, not a wall. */
    may: z.array(z.string().trim().min(1).max(60)).default([]),
    models: z.object({ steward: modelSpecSchema.optional(), worker: modelSpecSchema.optional(), reviewer: modelSpecSchema.optional() }).strict().default({}),
    "requeue-default": durationSchema.default(2 * 86_400_000),
    /**
     * BB-247: the longest dated wait (`steward_report { until }`) a steward may
     * park a binding for without the project steward being told once. The wait
     * is still accepted; the note is informational, not a refusal. Default 90d.
     */
    "max-wait": durationSchema.default(DEFAULT_MAX_WAIT_MS),
    /**
     * How long a binding in a build or review stage may sit with nothing to
     * wait on before the plugin wakes its steward (BB-83). The idle wake fires
     * once per idle period, so this is a grace, not a poll interval.
     */
    "idle-grace": durationSchema.default(15 * 60_000),
    /** How long a steward may keep a binding open past a terminal state to finish its work. */
    "follow-through": durationSchema.default(DEFAULT_FOLLOW_THROUGH_MS),
    /**
     * BB-251: how many recorded assumptions a binding may have open at once.
     * Past the cap the steward asks instead of assuming. Default 5.
     */
    "max-assumptions": z.number().int().min(0).max(50).default(5),
    /** Reviews: pull request authors no review steward is made for (bots). */
    "skip-authors": z.array(z.string().trim().min(1).max(100)).default([]),
    /**
     * Reviews: file the owner's Merge item on a teammate's pull request too
     * (BB-170). Off by default: the owner's approval is their last step and
     * the author merges. Set on the review playbook.
     */
    "owner-merges": z.boolean().default(false),
    /** Where a merge is confirmed live, when the project has a deployment source (BB-53): one target or a list. */
    deployment: deploymentsFieldSchema.optional(),
  })
  .strict();

export type Playbook = {
  name: string;
  kind: BindingKind;
  source: (typeof PLAYBOOK_SOURCES)[number];
  phases: Record<string, { stage?: Stage; stuck?: number }>;
  terminal: string[];
  ready: ReadyConfig | null;
  /** The review playbook's substantial criteria (BB-207); empty on every other kind. */
  substantial: string[];
  promote: string | null;
  may: string[];
  models: { steward: ModelSpec | null; worker: ModelSpec | null; reviewer: ModelSpec | null };
  requeueDefaultMs: number;
  /** BB-247: the longest dated wait accepted without one note to the project steward. */
  maxWaitMs: number;
  /** How long a binding may sit idle in an active stage before its steward is woken (BB-83). */
  idleGraceMs: number;
  followThroughMs: number;
  /** How many recorded assumptions a binding may have open at once (BB-251); past it the steward asks instead. */
  maxAssumptions: number;
  skipAuthors: string[];
  /** Whether a teammate's pull request still files the owner's Merge item (BB-170; off by default). */
  ownerMerges: boolean;
  /** Where a merge is confirmed live, or empty when the playbook names no deployment target. */
  deployments: DeploymentTarget[];
  /** Alias warnings the front matter raised, surfaced by `bb stewards check` (BB-209). */
  warnings: string[];
  /** The text before the first `## ` heading: instructions for every phase. */
  general: string;
  /** Each `## Phase` section's text, keyed by heading as written. */
  sections: Record<string, string>;
  /** A short hash of the file's text: the playbook version a binding runs under. */
  version: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

export function parsePlaybook(text: string, expectedName: string): Parsed<Playbook> {
  const file = playbookPath(expectedName);
  const m = FRONT_MATTER.exec(text);
  if (m === null) return { ok: false, error: `${file} has no YAML front matter between --- lines` };
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch (error) {
    return { ok: false, error: `${file}: the front matter is not YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = frontMatterSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `${file}: ${zodMessage(parsed.error)}` };
  const fm = parsed.data;
  if (fm.name !== expectedName) return { ok: false, error: `${file} names itself ${JSON.stringify(fm.name)}; the file name says ${JSON.stringify(expectedName)}` };
  const expectedSources = SOURCES_OF[fm.kind];
  if (fm.kind === "ops") {
    // An ops binding watches a target, not an entity in a source plugin: a
    // Kubernetes namespace reads k8s, a Dependabot alert target reads
    // github, and a Sentry project reads sentry. The playbook says which so
    // its sections can be about the right thing; any is valid, and the
    // ops-watch playbook serves k8s and Sentry targets alike.
    if (fm.source === "linear") return { ok: false, error: `${file}: an ops playbook watches k8s, sentry or github, not ${fm.source}` };
  } else if (!expectedSources.includes(fm.source)) {
    return { ok: false, error: `${file}: a ${fm.kind} playbook reads ${expectedSources.join(" or ")}, not ${fm.source}` };
  }
  if (fm.kind === "ops") {
    // An ops binding watches a target for as long as it is configured: no state to key phases on, and nothing terminal.
    if (Object.keys(fm.phases ?? {}).length > 0 || fm.terminal.length > 0 || fm.ready !== undefined || fm.promote !== undefined) {
      return { ok: false, error: `${file}: an ops playbook has no phases, terminal states, ready gate or promote rule: it watches a target, not an entity` };
    }
  } else {
    if (fm.phases === undefined) return { ok: false, error: `${file}: phases: map the entity's states to stages` };
    if (fm.terminal.length === 0) return { ok: false, error: `${file}: terminal: name at least one state that ends the binding` };
  }
  const phases = fm.phases ?? {};
  const lowerPhases = new Set(Object.keys(phases).map((p) => p.toLowerCase()));
  const overlap = fm.terminal.filter((t) => lowerPhases.has(t.toLowerCase()));
  if (overlap.length > 0) return { ok: false, error: `${file}: ${overlap.join(", ")} cannot be both a phase and terminal` };
  if (fm.ready === undefined && fm.kind === "ticket" && Object.values(phases).some((p) => p.stage === "build")) {
    return { ok: false, error: `${file}: a ticket playbook with a build stage needs a ready gate` };
  }

  const { general, sections } = splitSections(m[2] ?? "");
  // BB-209: `approval: me` is the pre-rename alias for `user`. Normalise it in
  // the parsed playbook and record one warning, so every comparison sees
  // `user` while `bb stewards check` tells the project to write it.
  const warnings: string[] = [];
  const rawReady = fm.ready ?? null;
  if (rawReady !== null && rawReady.approval === "me") warnings.push('ready.approval "me" is renamed to "user"; write "user"');
  const ready: ReadyConfig | null = rawReady === null ? null : { ...rawReady, approval: rawReady.approval === "me" ? "user" : rawReady.approval };
  return {
    ok: true,
    value: {
      name: fm.name,
      kind: fm.kind,
      source: fm.source,
      phases,
      terminal: fm.terminal,
      ready,
      substantial: fm.substantial,
      promote: fm.promote ?? null,
      may: fm.may,
      models: { steward: fm.models.steward ?? null, worker: fm.models.worker ?? null, reviewer: fm.models.reviewer ?? null },
      requeueDefaultMs: fm["requeue-default"],
      maxWaitMs: fm["max-wait"],
      idleGraceMs: fm["idle-grace"],
      followThroughMs: fm["follow-through"],
      maxAssumptions: fm["max-assumptions"],
      skipAuthors: fm["skip-authors"],
      ownerMerges: fm["owner-merges"],
      deployments: fm.deployment === undefined ? [] : Array.isArray(fm.deployment) ? fm.deployment : [fm.deployment],
      warnings,
      general,
      sections,
      version: createHash("sha256").update(text).digest("hex").slice(0, 12),
    },
  };
}

function splitSections(body: string): { general: string; sections: Record<string, string> } {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const general: string[] = [];
  let lines: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      if (current !== null) sections[current] = lines.join("\n").trim();
      current = heading[1]!;
      lines = [];
      continue;
    }
    if (current === null) general.push(line);
    else lines.push(line);
  }
  if (current !== null) sections[current] = lines.join("\n").trim();
  return { general: general.join("\n").trim(), sections };
}

/** A phase's entry, matched ignoring case, or null when the playbook does not name the state. */
export function phaseOf(playbook: Playbook, state: string): { name: string; stage: Stage | null; stuckMs: number | null } | null {
  const key = Object.keys(playbook.phases).find((p) => p.toLowerCase() === state.toLowerCase());
  if (key === undefined) return null;
  const phase = playbook.phases[key]!;
  return { name: key, stage: phase.stage ?? null, stuckMs: phase.stuck ?? null };
}

export const isTerminal = (playbook: Playbook, state: string): boolean => playbook.terminal.some((t) => t.toLowerCase() === state.toLowerCase());

/** The phase's instructions: its own section, matched ignoring case. */
export function phaseInstructions(playbook: Playbook, state: string): string | null {
  const key = Object.keys(playbook.sections).find((s) => s.toLowerCase() === state.toLowerCase());
  return key === undefined ? null : playbook.sections[key]!;
}

/** Every source state the playbook names, for validation against the source (Linear workflow states, or GitHub status labels). A `label:` phase key is not a state (BB-248). */
export const playbookStates = (playbook: Playbook): string[] => [...Object.keys(playbook.phases).filter((p) => labelPhaseName(p) === null), ...playbook.terminal, ...(playbook.ready !== null && typeof playbook.ready.approval === "object" ? [playbook.ready.approval.state] : [])];

/** The label names the playbook's `label:` phase keys name, for validation against the source (BB-248). */
export const playbookLabels = (playbook: Playbook): string[] => Object.keys(playbook.phases).flatMap((p) => { const name = labelPhaseName(p); return name === null ? [] : [name]; });

/**
 * The states GitHub produces itself rather than reading from a label: an open
 * or closed issue (`closed`, `closed (completed)`, `closed (not planned)`),
 * and a pull request's own states. They cannot be created or validated as
 * labels, so a GitHub issue playbook's label states are the rest.
 */
const derivedGithubState = (state: string): boolean => {
  const s = state.toLowerCase();
  return s === "open" || s === "draft" || s === "merged" || s === "closed" || s.startsWith("closed ");
};

/** The label states a GitHub issue playbook expects: its phases, terminal labels and approval state, less GitHub's derived states. */
export const githubStateLabels = (playbook: Playbook): string[] => playbookStates(playbook).filter((s) => !derivedGithubState(s));
