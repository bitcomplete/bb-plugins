import type { Prediction, Problem, Solution } from "../domain/types.js";
import { AdapterError } from "./transport.js";

export interface PrivacyPolicy { secrets?: readonly string[]; clientNames?: readonly string[]; maxCharacters?: number }
const SECRET_PATTERNS = [
  /\b(?:sk-(?:ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/g,
  /\b(?:authorization|api[-_ ]?key|password|secret|access[-_ ]?token)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
/** Defense in depth only: free-form unknown names/secrets cannot be detected perfectly. */
function redactValues(text: string, policy: PrivacyPolicy): string {
  let out = String(text);
  for (const value of [...(policy.secrets ?? []), ...(policy.clientNames ?? [])].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    out = out.replace(new RegExp(escape(value),"gi"),"[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern,"[redacted]");
  return out;
}
export function redact(text: string, policy: PrivacyPolicy = {}): string {
  let out = redactValues(text, policy);
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[email]")
    .replace(/https?:\/\/[^\s<>"']+/g,"[url]")
    .replace(/(?:\/(?:home|Users|root|etc|var)\/[^\s<>"']+)/g,"[path]");
  const max = policy.maxCharacters ?? 8000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 100_000) throw new AdapterError("invalid-privacy-policy","Invalid excerpt limit");
  return out.length > max ? out.slice(0,max) + " [omitted]" : out;
}
export function assertLedgerText(text: string, policy: PrivacyPolicy = {}): void {
  if (typeof text !== "string" || text.length === 0 || text.length > (policy.maxCharacters ?? 8000)) throw new AdapterError("unsafe-ledger-text","Ledger text is empty or exceeds its size limit");
  if (redact(text, {...policy,maxCharacters:100_000}) !== text) throw new AdapterError("unsafe-ledger-text","Ledger text contains a disallowed identifier or credential pattern");
}

/** Outbound projections only: never rewrite retained evidence, record keys or artifact identities. */
export function modelPredictionContext(prediction: Prediction, policy: PrivacyPolicy = {}) {
  return { change: redact(prediction.change, policy), kpi: { name: redact(prediction.kpi.name, policy), target: prediction.kpi.target, direction: prediction.kpi.direction } };
}
export function modelProblemContext(problem: Problem, policy: PrivacyPolicy = {}) {
  return { category: redact(problem.category, policy), status: problem.status,
    causes: problem.causes.map(c => redact(c.text, policy)), symptoms: problem.symptoms.map(s => redact(s.text, policy)) };
}
export function modelSolutionContext(solution: Solution, policy: PrivacyPolicy = {}) {
  const paper = solution.sourcePaper;
  return {
    title: redact(solution.title, policy), origin: solution.origin,
    // Public research references have separate provenance; keep their exact URLs and citation metadata.
    sourcePaper: paper ? { id: paper.id, version: paper.version, url: paper.url, publishedAtMs: paper.publishedAtMs,
      credibility: { status: paper.credibility.status, fieldWeightedCitationImpact: paper.credibility.fieldWeightedCitationImpact,
        authorSignal: paper.credibility.authorSignal, evidenceUrls: [...paper.credibility.evidenceUrls] } } : null,
    mechanism: redact(solution.mechanism, policy), assumptions: solution.assumptions.map(a => redact(a, policy)), testPlan: redact(solution.testPlan, policy),
    prediction: modelPredictionContext(solution.prediction, policy), candidateState: solution.candidateState, status: solution.status,
    scores: { fit: solution.scores.fit, benefit: solution.scores.benefit, testability: solution.scores.testability,
      feasibility: solution.scores.feasibility, safety: solution.scores.safety, effort: solution.scores.effort },
    scoreReasons: { fit: redact(solution.scoreReasons.fit, policy), benefit: redact(solution.scoreReasons.benefit, policy),
      testability: redact(solution.scoreReasons.testability, policy), feasibility: redact(solution.scoreReasons.feasibility, policy),
      safety: redact(solution.scoreReasons.safety, policy), effort: redact(solution.scoreReasons.effort, policy) },
    attempts: solution.attempts.map(a => ({ atMs: a.atMs, prediction: modelPredictionContext(a.prediction, policy), outcome: a.outcome, reason: redact(a.reason, policy) })),
    revisitHistory: solution.revisitHistory.map(r => ({ atMs: r.atMs, decision: r.decision, reason: redact(r.reason, policy) })),
  };
}
/** Instructions must stay byte-identical to the content being evaluated or reviewed. Fail before dispatch. */
export function assertInstructionText(instruction: string, policy: PrivacyPolicy = {}): void {
  assertLedgerText(instruction, { ...policy, maxCharacters: 16000 });
}

/** Preserve the tool's JSON structure and edit references; redact only a fresh outbound copy. */
export function modelLedgerRead(value: unknown, policy: PrivacyPolicy = {}): unknown {
  const identity = /(?:^id$|Ids?$|^key$|Key$|Hash$|Digest$|^aliases$|^revision$|^version$|^namespace$|^model$|^provider$|^status$|^kind$|^origin$|^outcome$|^direction$|^phase$|^basis$|^currency$|^decision$|^candidateState$)/;
  const visit = (item: unknown, key = "", publicPaper = false): unknown => {
    if (typeof item === "string") {
      // Audit snapshots are JSON columns, not prose. Decode before applying the projection.
      if (["actor", "before_value", "after_value"].includes(key)) {
        try { return visit(JSON.parse(item), "", publicPaper); }
        catch { throw new AdapterError("invalid-ledger-read", "Ledger audit data cannot be projected"); }
      }
      const citation = publicPaper && (key === "url" || key === "evidenceUrls");
      const clean = citation ? redactValues(item, policy) : redact(item, policy);
      if ((citation || identity.test(key)) && clean !== item) throw new AdapterError("ledger-reference-disallowed", "A ledger reference is disallowed by the current privacy policy; inspect it in the dashboard");
      return clean;
    }
    if (Array.isArray(item)) return item.map(child => visit(child, key, publicPaper));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, child]) => {
      if (redact(name, policy) !== name) throw new AdapterError("ledger-reference-disallowed", "A ledger field is disallowed by the current privacy policy; inspect it in the dashboard");
      return [name, visit(child, name, publicPaper || name === "sourcePaper")];
    }));
    return item;
  };
  return visit(value);
}
