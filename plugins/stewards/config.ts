// Configuration: the project file and the playbooks, as text read from the
// project's `.bb` through multi-repo, parsed into typed values. Pure: nothing
// here reads a file or calls a plugin; server.ts hands the text in.
//
// Both files are written by people, so every parse returns an error a person
// can act on rather than throwing, and the error names the file.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { DependabotTarget, K8sTarget, OpsTarget } from "./ops.js";
import { DEPENDABOT_SEVERITIES } from "./source-contract.js";

export const STEWARDS_DIR = "stewards";
export const PROJECT_FILE = `${STEWARDS_DIR}/project.json`;
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

export const DEFAULT_BIG_DECISIONS = [
  "Changing what a ticket's requester asked for, beyond clarifying it",
  "A public API, data contract or schema change other teams depend on",
  "Anything irreversible in production: data deletion, migrations without a way back",
  "New vendors, services or spending",
  "A conflict between people that the project's guidance does not settle",
];

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

const opsTargetSchema = z.discriminatedUnion("kind", [k8sNamespaceTargetSchema, dependabotTargetSchema]);

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
    bigDecisions: z.array(z.string().trim().min(1).max(300)).max(30).default(DEFAULT_BIG_DECISIONS),
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
      })
      .strict()
      .default({ targets: [], autoAdopt: [] }),
    /** The dependency watch: per-severity SLA, the batch window, and what auto-adopts. */
    deps: depsSchema,
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.ops.targets.forEach((t, i) => {
      const key = t.kind === "k8s-namespace" ? `${t.kind}/${t.name}` : `${t.kind}/${t.repo.toLowerCase()}`;
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

export const playbookNameFor = (project: ProjectFile, kind: BindingKind): string => project.playbooks[kind] ?? DEFAULT_PLAYBOOKS[kind];

/** Whether a project uses a kind of binding at all: reviews can be turned off, and ops needs a target. */
export const usesKind = (project: ProjectFile, kind: BindingKind): boolean => (kind === "review" ? project.reviews.enabled : kind === "ops" ? project.ops.targets.length > 0 : true);

export const opsTargets = (project: ProjectFile): OpsTarget[] => project.ops.targets;

/** The k8s namespaces to watch, which are read with kubectl. */
export const k8sTargets = (project: ProjectFile): K8sTarget[] => project.ops.targets.filter((t): t is K8sTarget => t.kind === "k8s-namespace");

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

// ---- playbooks ---------------------------------------------------------------------

export const STAGES = ["spec", "build", "review"] as const;
export type Stage = (typeof STAGES)[number];

/** What a steward raises. */
export const ESCALATION_KINDS = ["blocked", "decision", "scope", "conflict", "stuck"] as const;
/** Those, and the plugin's own: a ready gate waiting on its approver, and a ready ticket waiting to be scheduled against work already under way. */
export type EscalationKind = (typeof ESCALATION_KINDS)[number] | "approval" | "schedule";

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

export const PLAYBOOK_SOURCES = ["linear", "github", "k8s"] as const;
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
    models: z.object({ steward: modelSpecSchema.optional(), worker: modelSpecSchema.optional() }).strict().default({}),
    "requeue-default": durationSchema.default(2 * 86_400_000),
    /** How long a steward may keep a binding open past a terminal state to finish its work. */
    "follow-through": durationSchema.default(DEFAULT_FOLLOW_THROUGH_MS),
    /** Reviews: pull request authors no review steward is made for (bots). */
    "skip-authors": z.array(z.string().trim().min(1).max(100)).default([]),
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
  models: { steward: ModelSpec | null; worker: ModelSpec | null };
  requeueDefaultMs: number;
  followThroughMs: number;
  skipAuthors: string[];
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
    // Kubernetes namespace reads k8s, and a Dependabot alert target reads
    // github. The playbook says which so its sections can be about the right
    // thing; either is valid.
    if (fm.source !== "k8s" && fm.source !== "github") return { ok: false, error: `${file}: an ops playbook watches k8s or github, not ${fm.source}` };
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
      models: { steward: fm.models.steward ?? null, worker: fm.models.worker ?? null },
      requeueDefaultMs: fm["requeue-default"],
      followThroughMs: fm["follow-through"],
      skipAuthors: fm["skip-authors"],
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
