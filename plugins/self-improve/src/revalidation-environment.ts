import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Store } from "./store.js";
import { stableJson } from "./domain/shared.js";
import { revalidationEnvironmentSchema, type RevalidationEnvironment } from "./revalidation-contract.js";

export type RevalidationEnvironmentSdk = Pick<BbPluginApi["sdk"], "environments" | "plugins" | "skills" | "system">;
const text = z.string().min(1).max(500).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pluginSchema = z.object({ id: text, presence: z.enum(["present", "missing", "unknown"]), version: text.nullable(), enabled: z.boolean().nullable(), status: text.nullable(), metadataDigest: digest.nullable(), codeDigest: z.null() }).strict();
const filePath = text.refine(value => value.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)));
const fileSchema = z.object({ path: filePath, revision: text.nullable(), sha256: digest.nullable() }).strict();
const skillSchema = z.object({ id: text, presence: z.enum(["present", "missing", "unknown"]), files: z.array(fileSchema).max(100), complete: z.boolean(), manifestDigest: digest.nullable() }).strict();
const contentSchema = z.object({
  schemaVersion: z.literal(1), declaredEnvironmentDigest: digest,
  environment: z.object({ id: text, projectId: text, status: z.literal("ready"), hostLifecycle: z.literal("active"), phase: z.literal("active") }).strict(),
  bbVersion: text.nullable(), plugins: z.array(pluginSchema).max(100), skills: z.array(skillSchema).max(100),
  unobservedDependencies: z.array(z.object({ kind: z.enum(["tool", "runtime"]), name: text, reason: z.literal("unsupported-observation-surface") }).strict()).max(100),
  unknowns: z.array(text).max(500),
}).strict();
export const observedRevalidationEnvironmentSchema = contentSchema.extend({ digest, capturedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export type ObservedRevalidationEnvironment = z.infer<typeof observedRevalidationEnvironmentSchema>;
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const bytesDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export function observedRevalidationEnvironmentDigest(value: Omit<ObservedRevalidationEnvironment, "digest" | "capturedAtMs">): string {
  return hash(contentSchema.parse(value));
}
export function validateObservedRevalidationEnvironment(raw: unknown): ObservedRevalidationEnvironment {
  const parsed = observedRevalidationEnvironmentSchema.parse(raw), { digest: saved, capturedAtMs: _time, ...content } = parsed;
  if (saved !== observedRevalidationEnvironmentDigest(content)) throw new Error("revalidation-observation-digest-mismatch");
  for (const plugin of parsed.plugins) {
    const expected = plugin.presence === "present" ? hash({ id: plugin.id, version: plugin.version, enabled: plugin.enabled, status: plugin.status }) : null;
    if (plugin.metadataDigest !== expected || (plugin.presence === "present"
      ? plugin.version === null || plugin.enabled === null || plugin.status === null
      : plugin.version !== null || plugin.enabled !== null || plugin.status !== null)) throw new Error("revalidation-plugin-observation-invalid");
  }
  for (const skill of parsed.skills) {
    if (skill.manifestDigest !== (skill.complete ? hash(skill.files) : null) ||
      skill.presence !== "present" && (skill.complete || skill.files.length > 0) ||
      skill.complete && (!skill.files.length || skill.files.some(file => file.sha256 === null)) ||
      skill.files.some(file => (file.sha256 === null) !== (file.revision === null)) ||
      new Set(skill.files.map(file => file.path)).size !== skill.files.length) throw new Error("revalidation-skill-observation-invalid");
  }
  if (new Set(parsed.plugins.map(item => item.id)).size !== parsed.plugins.length || new Set(parsed.skills.map(item => item.id)).size !== parsed.skills.length) throw new Error("revalidation-observation-duplicate");
  return parsed;
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("revalidation-environment-observation-aborted")); };
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
const snapshots = "revalidation-observed-environments", heads = "revalidation-environment-observation-heads", cursors = "revalidation-environment-observation-cursors";
/** Observes selected declarations only. Metadata/content fingerprints do not attest isolation or tool availability. */
export function createRevalidationEnvironmentObserver(options: { sdk: RevalidationEnvironmentSdk; store: Store; redact: (value: string) => string; now?: () => number }) {
  const clean = (value: unknown): string => {
    const parsed = text.parse(value); if (options.redact(parsed) !== parsed) throw new Error("revalidation-environment-private-identifier"); return parsed;
  };
  function declaration(raw: RevalidationEnvironment) {
    const environment = revalidationEnvironmentSchema.parse(raw);
    clean(environment.execution.projectId); clean(environment.execution.environmentId);
    for (const dependency of environment.dependencies) clean(dependency.name);
    return { environment, declaredDigest: hash(environment) };
  }
  function resolve(raw: RevalidationEnvironment): ObservedRevalidationEnvironment {
    const { environment, declaredDigest } = declaration(raw), saved = options.store.get<{ snapshotId: string; digest: string }>(heads, declaredDigest);
    if (!saved) throw new Error("revalidation-environment-not-observed");
    const observed = validateObservedRevalidationEnvironment(options.store.get(snapshots, saved.snapshotId));
    if (saved.digest !== observed.digest || observed.declaredEnvironmentDigest !== declaredDigest || observed.environment.id !== environment.execution.environmentId || observed.environment.projectId !== environment.execution.projectId) throw new Error("revalidation-environment-observation-binding-mismatch");
    return observed;
  }
  async function observe(raw: RevalidationEnvironment, parentSignal?: AbortSignal): Promise<ObservedRevalidationEnvironment> {
    const { environment, declaredDigest } = declaration(raw), selection = environment.execution;
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(parentSignal ? [parentSignal] : [])]);
    signal.throwIfAborted();
    const sequence = options.store.transaction(() => {
      const previous = options.store.get<number>(cursors, declaredDigest) ?? 0;
      if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error("revalidation-observation-cursor-invalid");
      options.store.put(cursors, declaredDigest, previous + 1); return previous + 1;
    });
    const sdk = options.sdk, unknowns = new Set(["provider-context-not-observed", "hidden-configuration-not-observed", "workspace-cleanliness-not-observed", "tool-side-effects-not-observed", "snapshot-is-not-an-atomic-lock"]);
    const read = <T>(operation: () => Promise<T>) => { signal.throwIfAborted(); return bounded(operation(), signal); };
    const optional = async <T>(operation: () => Promise<T>): Promise<T | null> => { try { return await read(operation); } catch { signal.throwIfAborted(); return null; } };
    const rawEnvironment = await read(() => sdk.environments.get({ environmentId: selection.environmentId, signal }));
    const ready = z.object({ id: text, projectId: text, status: z.literal("ready"), hostLifecycle: z.literal("active"), lifecycle: z.object({ phase: z.literal("active") }) }).safeParse(rawEnvironment);
    if (!ready.success || ready.data.id !== selection.environmentId || ready.data.projectId !== selection.projectId) throw new Error("revalidation-environment-not-ready-or-mismatched");
    const pluginIds = [...new Set(environment.dependencies.filter(item => item.kind === "plugin").map(item => item.name))].sort();
    const skillIds = [...new Set(environment.dependencies.filter(item => item.kind === "skill").map(item => item.name))].sort();
    const [versionResult, pluginsResult, skillsResult] = await Promise.all([
      optional(() => sdk.system.version({ signal })), pluginIds.length ? optional(() => sdk.plugins.list({ signal })) : null,
      skillIds.length ? optional(() => sdk.skills.list({ projectId: selection.projectId, environmentId: selection.environmentId, signal })) : null,
    ]);
    let bbVersion: string | null = null;
    try { bbVersion = clean(versionResult?.currentVersion); } catch { unknowns.add("bb-version-not-observed"); }
    const pluginInventory = z.object({ plugins: z.array(z.object({ id: text }).passthrough()) }).safeParse(pluginsResult);
    const skillInventory = z.object({ skills: z.array(z.object({ id: text }).passthrough()) }).safeParse(skillsResult);
    const plugins: ObservedRevalidationEnvironment["plugins"] = [];
    for (const id of pluginIds) {
      const matches = pluginInventory.success ? pluginInventory.data.plugins.filter(item => item.id === id) : null;
      const item: ObservedRevalidationEnvironment["plugins"][number] = { id, presence: matches ? matches.length === 0 ? "missing" : "unknown" : "unknown", version: null, enabled: null, status: null, metadataDigest: null, codeDigest: null };
      if (matches?.length === 1) {
        try {
          const selected = z.object({ id: text, version: text, enabled: z.boolean(), status: text }).parse(matches[0]);
          item.version = clean(selected.version); item.status = clean(selected.status); item.enabled = selected.enabled; item.presence = "present";
          item.metadataDigest = hash({ id, version: item.version, enabled: item.enabled, status: item.status });
        } catch { /* Missing or unsupported metadata remains explicitly unknown. */ }
      }
      if (item.presence !== "present") unknowns.add(`plugin-${item.presence}:${id}`);
      unknowns.add("plugin-code-not-observed"); plugins.push(item);
    }
    const skills: ObservedRevalidationEnvironment["skills"] = [];
    let totalCharacters = 0;
    for (const id of skillIds) {
      const matches = skillInventory.success ? skillInventory.data.skills.filter(item => item.id === id) : null;
      const item: ObservedRevalidationEnvironment["skills"][number] = { id, presence: matches ? matches.length === 0 ? "missing" : "unknown" : "unknown", files: [], complete: false, manifestDigest: null };
      if (matches?.length === 1) {
        item.presence = "present";
        const listing = await optional(() => sdk.skills.listFiles({ projectId: selection.projectId, environmentId: selection.environmentId, skillId: id, signal }));
        const paths = listing?.files;
        if (listing?.truncated === false && Array.isArray(paths) && paths.length > 0 && paths.length <= 100 && new Set(paths).size === paths.length) {
          let complete = true;
          for (const rawPath of [...paths].sort()) {
            let path: string;
            try { path = filePath.parse(clean(rawPath)); }
            catch { complete = false; unknowns.add(`skill-file-path-not-observed:${id}`); continue; }
            const content = await optional(() => sdk.skills.getContent({ projectId: selection.projectId, environmentId: selection.environmentId, skillId: id, path, signal }));
            let revision: string | null = null, sha256: string | null = null;
            try {
              if (!content || typeof content.content !== "string" || content.content.length > 200000 || totalCharacters + content.content.length > 1000000 || options.redact(content.content) !== content.content) throw new Error();
              totalCharacters += content.content.length; revision = clean(content.revision); sha256 = bytesDigest(content.content);
            } catch { complete = false; unknowns.add(`skill-content-not-observed:${id}`); }
            item.files.push({ path, revision, sha256 });
          }
          item.complete = complete; item.manifestDigest = complete ? hash(item.files) : null;
        } else unknowns.add(`skill-manifest-not-observed:${id}`);
      }
      if (item.presence !== "present") unknowns.add(`skill-${item.presence}:${id}`);
      skills.push(item);
    }
    const unobservedDependencies = environment.dependencies.filter((item): item is typeof item & { kind: "tool" | "runtime" } => item.kind === "tool" || item.kind === "runtime").map(item => ({ kind: item.kind, name: item.name, reason: "unsupported-observation-surface" as const })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    for (const item of unobservedDependencies) unknowns.add(`${item.kind}-version-not-observed:${item.name}`);
    const content = contentSchema.parse({ schemaVersion: 1, declaredEnvironmentDigest: declaredDigest,
      environment: { id: ready.data.id, projectId: ready.data.projectId, status: ready.data.status, hostLifecycle: ready.data.hostLifecycle, phase: ready.data.lifecycle.phase },
      bbVersion, plugins, skills, unobservedDependencies, unknowns: [...unknowns].sort() });
    const capturedAtMs = options.now?.() ?? Date.now(), observed = validateObservedRevalidationEnvironment({ ...content, digest: observedRevalidationEnvironmentDigest(content), capturedAtMs });
    signal.throwIfAborted();
    return options.store.transaction(() => {
      const snapshotId = `${observed.digest}:${sequence}`;
      if (!options.store.insert(snapshots, snapshotId, observed, capturedAtMs)) throw new Error("revalidation-observation-already-recorded");
      if (options.store.get<number>(cursors, declaredDigest) === sequence) options.store.put(heads, declaredDigest, { snapshotId, digest: observed.digest }, capturedAtMs);
      return observed;
    });
  }
  async function verify(environment: RevalidationEnvironment, expectedDigest: string, signal?: AbortSignal) {
    digest.parse(expectedDigest); const current = await observe(environment, signal);
    if (current.digest !== expectedDigest) throw new Error("revalidation-environment-drift"); return current;
  }
  return { observe, resolve, verify };
}
