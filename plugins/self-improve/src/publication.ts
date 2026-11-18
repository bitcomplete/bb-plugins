import { createHash } from "node:crypto";
import type { Actor, Store } from "./store.js";
import type { HeldOutProof, ModelIdentity, Solution } from "./domain/types.js";
import { checkAdoption } from "./domain/solutions.js";
import { finite, stableId, stableJson, text, unique } from "./domain/shared.js";
import { performanceHistory } from "./performance.js";

/** Only the trusted evaluator writes this namespace; no public RPC accepts receipt records. */
export interface TrustedEvaluation {
  id: string; solutionId: string; revision: string; artifactDigest: string; heldOutManifestDigest: string;
  createdAtMs: number; status: "passed"; executionCount: number; kind: "evaluation";
  model: ModelIdentity; proof: HeldOutProof;
}
/** Only the adoption/wiring operation writes the currently active artifact. */
export interface ValidatedArtifact {
  solutionId: string; revision: string; kind: "instruction"; content: string; artifactDigest: string;
  evaluationId: string; wiringLocation: string; activatedAtMs: number;
}
export interface ExportInput {
  solutionId: string; revision: string; format: "skill" | "plugin"; name: string;
  description: string; scopeProjectIds: string[];
}
export interface ArtifactFile { path: string; content: string }
export interface ExportDraft {
  id: string; solutionId: string; revision: string; format: "skill" | "plugin"; name: string;
  status: "draft"; createdAtMs: number; requestDigest: string; bundleSha256: string;
  evaluationId: string; files: ArtifactFile[];
}
export interface PublicationTarget { repository: string; branch: string; directory: string; bundleSha256: string }
export interface PublicationApproval { id: string; draftId: string; status: "approved-for-publication"; target: PublicationTarget; approvedAtMs: number }
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function assertSafeArtifactPath(path: string): void {
  if (typeof path !== "string" || path.length > 300 || !path.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) || path.split("/").some(part => part === "." || part === ".." || part.toLowerCase().endsWith(".lock"))) throw new Error("artifact path must be a safe relative path");
}
function privacyPreserved(value: string, redact: (value: string) => string, name: string): string {
  text(value, name);
  if (redact(value) !== value) throw new Error(`${name} failed the publication privacy check; review and revalidate a clean artifact`);
  return value;
}
function safeMetadata(value: string, redact: (value: string) => string): string { const result = redact(value); text(result, "export metadata"); return result; }
function checkEvidenceFields(value: unknown, citation: string | null, redact: (value: string) => string): void {
  // Check fields before rendering. Applying an excerpt redactor to a whole document
  // could truncate valid multi-window evidence and is not a publication privacy check.
  if (typeof value === "string") {
    if (value !== citation) privacyPreserved(value, redact, "export evidence field");
  } else if (Array.isArray(value)) value.forEach(item => checkEvidenceFields(item, citation, redact));
  else if (value && typeof value === "object") Object.values(value).forEach(item => checkEvidenceFields(item, citation, redact));
}

function exportedPlugin(instruction: string, scopes: string[]): string {
  return `import type { BbPluginApi } from "@get-bb/plugin-sdk";

const instruction = ${JSON.stringify(instruction)};
function projectScope(value: string): Set<string> {
  try {
    const ids: unknown = JSON.parse(value);
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))) return new Set();
    return new Set(ids);
  } catch { return new Set(); }
}
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Enable validated instruction", default: false },
    projectIds: { type: "string", label: "Allowed project IDs (JSON array)", default: ${JSON.stringify(JSON.stringify(scopes))} },
  });
  const initial = await settings.get();
  let enabled = initial.enabled;
  let projects = projectScope(initial.projectIds);
  settings.onChange(next => { enabled = next.enabled; projects = projectScope(next.projectIds); });
  bb.agents.configure(context => enabled && projects.has(context.project.id) ? { tools: [], skills: [], instructions: instruction } : { tools: [], skills: [] });
}
`;
}

/** Creates reviewable text files only. It does not write a destination repo, publish, install or enable anything. */
export function prepareExport(store: Store, input: ExportInput, redact: (value: string) => string, nowMs = Date.now()): ExportDraft {
  finite(nowMs, "export time");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.name)) throw new Error("export name must be a lowercase hyphenated name");
  privacyPreserved(input.name, redact, "export name");
  if (input.format !== "skill" && input.format !== "plugin") throw new Error("unsupported export format");
  const description = privacyPreserved(input.description, redact, "export description");
  if (description.length > 500 || /[\r\n]/.test(description)) throw new Error("export description must be one short line");
  const scopes = unique(input.scopeProjectIds);
  if (!scopes.length || scopes.length > 200 || scopes.some(id => !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new Error("export requires explicit project IDs");
  scopes.forEach(scope => privacyPreserved(scope, redact, "project scope"));
  const solution = store.get<Solution>("solutions", input.solutionId);
  if (!solution || (solution.status !== "active" && solution.status !== "proven")) throw new Error("only an active or proven solution can be exported");
  if (!solution.wiring || solution.wiring.activatedAtMs === null || solution.wiring.executionCount <= 0) throw new Error("solution wiring has no confirmed execution");
  const artifact = store.get<ValidatedArtifact>("validated-artifacts", solution.id);
  if (!artifact || artifact.kind !== "instruction" || artifact.revision !== input.revision || artifact.solutionId !== solution.id) throw new Error("active validated artifact is absent or has another revision");
  if (artifact.wiringLocation !== solution.wiring.location || artifact.activatedAtMs !== solution.wiring.activatedAtMs) throw new Error("active artifact wiring differs from the solution");
  if (artifact.activatedAtMs > nowMs || artifact.activatedAtMs < 0) throw new Error("artifact activation time is invalid");
  if (sha256(artifact.content) !== artifact.artifactDigest) throw new Error("validated artifact digest mismatch");
  const receipt = store.get<TrustedEvaluation>("trusted-evaluations", artifact.evaluationId);
  if (!receipt || receipt.kind !== "evaluation" || receipt.status !== "passed" || receipt.executionCount <= 0 || receipt.solutionId !== solution.id || receipt.revision !== artifact.revision || receipt.artifactDigest !== artifact.artifactDigest || !/^[a-f0-9]{64}$/.test(receipt.heldOutManifestDigest)) throw new Error("matching trusted evaluation receipt is absent");
  if (receipt.createdAtMs > artifact.activatedAtMs || receipt.createdAtMs < receipt.proof.patchCreatedAtMs || !checkAdoption(receipt.proof).eligible) throw new Error("trusted held-out proof is not eligible for this artifact");
  if (!solution.validatedWith || stableJson(receipt.model) !== stableJson(solution.validatedWith)) throw new Error("validation model differs from the trusted receipt");
  const instruction = privacyPreserved(artifact.content, redact, "validated instruction");
  const undo = privacyPreserved(solution.wiring.undo, redact, "exact undo");
  const requestDigest = sha256(stableJson({ ...input, scopeProjectIds: scopes, artifactDigest: artifact.artifactDigest }));
  const id = stableId("export", [solution.id, artifact.revision, input.format]);
  const existing = store.get<ExportDraft>("export-drafts", id);
  if (existing) {
    if (existing.requestDigest !== requestDigest) throw new Error("export revision already has an immutable draft with different options");
    return existing;
  }
  const performance = performanceHistory(store, solution.id).filter(p => p.solutionRevision === artifact.revision);
  const citation = solution.sourcePaper?.url ?? null;
  if (citation && !/^https:\/\/arxiv\.org\/abs\/\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(citation)) throw new Error("export requires a canonical public arXiv citation");
  const measurements = performance.map(p => ({ observedAtMs: p.observedAtMs, before: p.before, after: p.after, verification: p.verification, model: p.model, costs: p.costs }));
  const provenance = {
    solutionId: safeMetadata(solution.id, redact), revision: safeMetadata(artifact.revision, redact), artifactDigest: artifact.artifactDigest,
    evaluationId: safeMetadata(receipt.id, redact), validatedWith: receipt.model,
    origin: solution.origin, sourcePaper: solution.sourcePaper ? { id: solution.sourcePaper.id, version: solution.sourcePaper.version, url: solution.sourcePaper.url } : null,
    problemIds: solution.problemIds, measurements,
  };
  checkEvidenceFields(provenance, citation, redact);
  const evidence = `# Evidence and undo\n\nThis export packages an instruction that passed the source solution's trusted held-out evaluation and has recorded execution. It is not a guarantee for another model, provider or project.\n\n${performance.length ? "Recorded longitudinal measurements are included below; their uncertainty and confounders remain part of the result." : "No longitudinal performance snapshot is available for this revision. Held-out adoption is not a measured long-term efficacy claim."}\n\n\`\`\`json\n${JSON.stringify(provenance, null, 2)}\n\`\`\`\n\n## Exact source undo\n\n${undo}\n`;
  const files: ArtifactFile[] = [{ path: "EVIDENCE.md", content: evidence }];
  const scopeLine = `Use only for these project IDs: ${scopes.join(", ")}.`;
  if (input.format === "skill") {
    files.push({ path: `skills/${input.name}/SKILL.md`, content: `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(`${description}. ${scopeLine}`)}\n---\n\n# ${input.name}\n\n${scopeLine}\n\n${instruction}\n\nRead EVIDENCE.md for validation context and undo.\n` });
    files.push({ path: `skills/${input.name}/EVIDENCE.md`, content: evidence });
    files.push({ path: "README.md", content: `# ${input.name}\n\n${description}\n\nThis is a reviewable skill export. Install the skills/${input.name} directory through your skill manager after reviewing EVIDENCE.md. The project scope in a skill is instruction guidance, not an access-control boundary; use the plugin format for enforced project selection.\n\n## Undo\n\nRemove or disable this installed skill in the same skill manager.\n` });
  } else {
    const packageJson = { name: `bb-plugin-${input.name}`, version: "0.1.0", type: "module", description,
      engines: { bb: ">=0.49", bbPluginSdk: ">=0.6.132" },
      bb: { name: input.name, description, branding: { icon: "FlaskConical" }, server: "./server.ts", skills: [] }, keywords: ["bb-plugin"] };
    files.push({ path: "package.json", content: `${JSON.stringify(packageJson, null, 2)}\n` }, { path: "server.ts", content: exportedPlugin(instruction, scopes) });
    files.push({ path: "README.md", content: `# ${input.name}\n\n${description}\n\nInstall this directory with \`bb plugin install .\`. This plugin starts disabled. Review EVIDENCE.md, set the explicit projectIds JSON array in the plugin's settings, then enable its enabled setting. Invalid or empty project selection applies the instruction nowhere. Existing sessions pick configuration up on their next provider-session construction.\n\n## Undo\n\nSet enabled to false to stop contributing the instruction to new session configurations, then restart affected agent sessions. To remove the package, run \`bb plugin remove ${input.name}\`.\n` });
  }
  for (const file of files) { assertSafeArtifactPath(file.path); if (file.content.length > 2_000_000) throw new Error("export artifact exceeds its size bound"); }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const draft: ExportDraft = { id, solutionId: solution.id, revision: artifact.revision, format: input.format, name: input.name, status: "draft", createdAtMs: nowMs, requestDigest, bundleSha256: sha256(stableJson(files)), evaluationId: receipt.id, files };
  return store.transaction(() => {
    const concurrent = store.get<ExportDraft>("export-drafts", id);
    if (concurrent) {
      if (concurrent.requestDigest !== requestDigest) throw new Error("export revision already has a different draft");
      return concurrent;
    }
    store.put("export-drafts", id, draft, nowMs);
    return draft;
  });
}

/** Records consent only. A separate trusted adapter must publish exactly this bundle to exactly this target. */
export function approvePublication(store: Store, draftId: string, target: PublicationTarget, actor: Actor, nowMs = Date.now()): PublicationApproval {
  if (actor.kind !== "owner") throw new Error("publication needs explicit owner approval");
  finite(nowMs, "publication approval time");
  const draft = store.get<ExportDraft>("export-drafts", draftId);
  if (!draft || target.bundleSha256 !== draft.bundleSha256) throw new Error("publication bundle does not match the reviewed draft");
  const url = new URL(target.repository);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) throw new Error("publication target must be an explicit GitHub repository URL");
  if (!target.branch || /[\s~^:?*\[\\]/.test(target.branch) || target.branch.includes("..") || target.branch.includes("@{") || target.branch.startsWith("-") || target.branch.startsWith("/") || target.branch.endsWith("/") || target.branch.endsWith(".") || target.branch.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".lock"))) throw new Error("invalid publication branch");
  assertSafeArtifactPath(target.directory);
  const approval: PublicationApproval = { id: stableId("publication", [draftId, target]), draftId, status: "approved-for-publication", target: { ...target }, approvedAtMs: nowMs };
  return store.transaction(() => {
    const previous = store.get<PublicationApproval>("publication-approvals", approval.id);
    if (previous) return previous;
    store.put("publication-approvals", approval.id, approval, nowMs);
    return approval;
  });
}
