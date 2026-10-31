// Configuration: the project file and the playbooks, as text read from the
// project's `.bb` through multi-repo, parsed into typed values. Pure: nothing
// here reads a file or calls a plugin; server.ts hands the text in.
//
// Both files are written by people, so every parse returns an error a person
// can act on rather than throwing, and the error names the file.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { decideEntrySchema, defaultDecideList } from "./decisions.js";
import { SENTRY_SLUG, opsTargetKey, type DependabotTarget, type K8sTarget, type OpsTarget, type SentryTarget } from "./ops.js";
import { DEPENDABOT_SEVERITIES, REPO_NAME } from "./source-contract.js";

export const STEWARDS_DIR = "stewards";
export const PROJECT_FILE = `${STEWARDS_DIR}/project.json`;
/** The per-person roles: which watches and the project stewardship a GitHub login's server runs. */
export const ROLES_FILE = `${STEWARDS_DIR}/roles.json`;
export const playbookPath = (name: string) => `${STEWARDS_DIR}/playbooks/${name}.md`;

export const DEFAULT_LABEL = "bb-managed";

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
    adoption: z.object({ perPass: z.number().int().min(1).max(100).default(10) }).strict().default({ perPass: 10 }),
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
        team: teamKey.optional(),
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
    if (file.ops.team !== undefined && !file.linear.teams.includes(file.ops.team)) ctx.addIssue({ code: "custom", path: ["ops", "team"], message: `${file.ops.team} is not one of linear.teams, so a ticket filed there would never be stewarded` });
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
 * The per-person roles file (BB-105). It is read like the project file, from
 * the canonical checkout's committed HEAD, and each server runs only the entry
 * whose key is its own signed-in GitHub login. The watches with no natural
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

/** A role's watches: namespaces, Sentry projects, Dependabot repos, and where its tickets file. */
export const roleOpsSchema = z
  .object({
    k8sNamespaces: z.array(z.string().trim().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u, "a namespace name such as bb-gate-production")).max(50).default([]),
    /** The kubeconfig context kubectl uses on this person's machine; its current context when left out. */
    context: z.string().trim().min(1).max(200).regex(/^[^\s-][^\s]*$/u, "a kubeconfig context name").optional(),
    /** Where this person's ops tickets are filed (the first of linear.teams when left out). */
    team: teamKey.optional(),
    autoAdopt: z.array(z.enum(LINEAR_PRIORITIES)).max(4).default([]),
    sentry: roleSentrySchema,
    /** Repos whose Dependabot alerts this person watches; `"all"` is every repo in repos.json less github.exclude. */
    dependabot: z.union([z.literal("all"), z.array(dependabotRepoSchema).max(200)]).optional(),
  })
  .strict();
export type RoleOps = z.infer<typeof roleOpsSchema>;

/** One person's role: whether their server is the project steward, and the watches it runs. */
export const roleSchema = z.object({ projectSteward: z.boolean().default(false), ops: roleOpsSchema.optional() }).strict();
export type Role = z.infer<typeof roleSchema>;

export type RolesFile = { version: 1; roles: Record<string, Role> };

const rolesFileRawSchema = z.object({ version: z.literal(1), roles: z.record(z.string(), roleSchema) }).strict();

/**
 * Folds every login to lower case and refuses two keys that name the same
 * login ignoring case. Duplicate JSON keys are collapsed by `JSON.parse`
 * before this runs; the check catches `Jane` and `jane` in one file.
 */
export const rolesFileSchema = rolesFileRawSchema.transform((file, ctx): RolesFile => {
  const roles: Record<string, Role> = {};
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
    roles[login] = role;
  }
  return { version: 1, roles };
});

export function parseRolesFile(text: string): Parsed<RolesFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${ROLES_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = rolesFileSchema.safeParse(raw);
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

/** The Linear team a role's ops steward files in (the first of linear.teams when the role names none). */
export const roleOpsTeam = (role: Role | null, project: ProjectFile): string | null => role?.ops?.team ?? project.linear.teams[0] ?? null;

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

export const playbookNameFor = (project: ProjectFile, kind: BindingKind): string => project.playbooks[kind] ?? DEFAULT_PLAYBOOKS[kind];

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

/** The Linear team an ops steward files in. */
export const opsTeam = (project: ProjectFile): string | null => project.ops.team ?? project.linear.teams[0] ?? null;

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

/** The project steward count problem, or null when exactly one login holds it. */
export function projectStewardProblem(roles: RolesFile): string | null {
  const stewards = Object.entries(roles.roles).filter(([, role]) => role.projectSteward).map(([login]) => login);
  if (stewards.length === 0) return "no one is the project steward: set projectSteward: true on one login in roles.json";
  if (stewards.length > 1) return `two people are the project steward: ${stewards.join(", ")}`;
  return null;
}

// ---- playbooks ---------------------------------------------------------------------

export const STAGES = ["spec", "build", "review"] as const;
export type Stage = (typeof STAGES)[number];

/** What a steward raises. */
export const ESCALATION_KINDS = ["blocked", "decision", "scope", "conflict", "stuck"] as const;
/** Those, and the plugin's own: a ready gate waiting on its approver, a ready ticket waiting to be scheduled against work already under way, and a binding that has woken by requeue alone with an unchanged wait (BB-154). */
export type EscalationKind = (typeof ESCALATION_KINDS)[number] | "approval" | "schedule" | "stall";

const phaseSchema = z
  .object({
    stage: z.enum(STAGES).optional(),
    /** A status record that has not advanced in this long raises `stuck`. */
    stuck: durationSchema.optional(),
  })
  .strict();

const readySchema = z
  .object({
    checklist: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
    substantial: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
    /** Who approves a substantial ticket: the project steward (default), the user, or a Linear state. */
    approval: z.union([z.literal("project"), z.literal("me"), z.object({ "linear-state": z.string().trim().min(1).max(100) }).strict()]).default("project"),
  })
  .strict();
export type ReadyConfig = z.infer<typeof readySchema>;

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
const SOURCE_OF: Record<BindingKind, (typeof PLAYBOOK_SOURCES)[number]> = { ticket: "linear", pr: "github", review: "github", ops: "k8s" };

export const frontMatterSchema = z
  .object({
    name: playbookName,
    kind: z.enum(KINDS),
    /** Where the entity lives; an ops playbook watches k8s, and has no entity state. */
    source: z.enum(PLAYBOOK_SOURCES),
    /** Required for every kind but ops, which has none. */
    phases: z.record(z.string().trim().min(1).max(100), phaseSchema.nullable().transform((p) => p ?? {})).optional(),
    terminal: z.array(z.string().trim().min(1).max(100)).default([]),
    ready: readySchema.optional(),
    promote: z.string().trim().max(1000).optional(),
    /** What the steward may do on the entity. Policy the wake states, not a wall. */
    may: z.array(z.string().trim().min(1).max(60)).default([]),
    models: z.object({ steward: modelSpecSchema.optional(), worker: modelSpecSchema.optional(), reviewer: modelSpecSchema.optional() }).strict().default({}),
    "requeue-default": durationSchema.default(2 * 86_400_000),
    /**
     * How long a binding in a build or review stage may sit with nothing to
     * wait on before the plugin wakes its steward (BB-83). The idle wake fires
     * once per idle period, so this is a grace, not a poll interval.
     */
    "idle-grace": durationSchema.default(15 * 60_000),
    /** How long a steward may keep a binding open past a terminal state to finish its work. */
    "follow-through": durationSchema.default(DEFAULT_FOLLOW_THROUGH_MS),
    /** Reviews: pull request authors no review steward is made for (bots). */
    "skip-authors": z.array(z.string().trim().min(1).max(100)).default([]),
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
  promote: string | null;
  may: string[];
  models: { steward: ModelSpec | null; worker: ModelSpec | null; reviewer: ModelSpec | null };
  requeueDefaultMs: number;
  /** How long a binding may sit idle in an active stage before its steward is woken (BB-83). */
  idleGraceMs: number;
  followThroughMs: number;
  skipAuthors: string[];
  /** Where a merge is confirmed live, or empty when the playbook names no deployment target. */
  deployments: DeploymentTarget[];
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
  const expectedSource = SOURCE_OF[fm.kind];
  if (fm.kind === "ops") {
    // An ops binding watches a target, not an entity in a source plugin: a
    // Kubernetes namespace reads k8s, a Dependabot alert target reads
    // github, and a Sentry project reads sentry. The playbook says which so
    // its sections can be about the right thing; any is valid, and the
    // ops-watch playbook serves k8s and Sentry targets alike.
    if (fm.source === "linear") return { ok: false, error: `${file}: an ops playbook watches k8s, sentry or github, not ${fm.source}` };
  } else if (fm.source !== expectedSource) {
    return { ok: false, error: `${file}: a ${fm.kind} playbook reads ${expectedSource}, not ${fm.source}` };
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
  return {
    ok: true,
    value: {
      name: fm.name,
      kind: fm.kind,
      source: fm.source,
      phases,
      terminal: fm.terminal,
      ready: fm.ready ?? null,
      promote: fm.promote ?? null,
      may: fm.may,
      models: { steward: fm.models.steward ?? null, worker: fm.models.worker ?? null, reviewer: fm.models.reviewer ?? null },
      requeueDefaultMs: fm["requeue-default"],
      idleGraceMs: fm["idle-grace"],
      followThroughMs: fm["follow-through"],
      skipAuthors: fm["skip-authors"],
      deployments: fm.deployment === undefined ? [] : Array.isArray(fm.deployment) ? fm.deployment : [fm.deployment],
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

/** Every Linear state the playbook names, for validation against the teams' workflows. */
export const playbookStates = (playbook: Playbook): string[] => [...Object.keys(playbook.phases), ...playbook.terminal, ...(playbook.ready !== null && typeof playbook.ready.approval === "object" ? [playbook.ready.approval["linear-state"]] : [])];
