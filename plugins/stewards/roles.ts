// The roles file: who stewards are and what each server runs (BB-105). The
// `roles.json` schemas, the version 1 and 2 normalisation, the role a server
// resolves, and the `check` problems about who owns what. This is the roles
// seam, kept in its own module so a change to it is always the owner's.
//
// It reads nothing on its own: the project file's schema primitives and its
// own `check` problems come from config.ts, and the store is passed to the
// functions that need it.
import { z } from "zod";
import { globError } from "./decisions.js";
import { opsTargetKey, type DependabotTarget, type K8sTarget, type OpsTarget, type SentryTarget } from "./ops.js";
import { REPO_NAME } from "./source-contract.js";
import { DEPENDENCY_BOTS, dependabotRepoSchema, filingTargetSchema, filingTargetOf, k8sTargets, LINEAR_PRIORITIES, playbookName, PROJECT_FILE, sentrySlug, sentryTargets, STEWARDS_DIR, zodMessage, type BindingKind, type FilingTarget, type Parsed, type Playbook, type ProjectFile } from "./config.js";

export const ROLES_FILE = `${STEWARDS_DIR}/roles.json`;

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
