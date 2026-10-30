import { z } from "zod";
import type { RunDb } from "./runstore.js";
import { canonicalPrUrl } from "./pr-holds.js";
import { approvalEvidenceSchema, evidenceText, handled, type ApprovalEvidence, type UserConfirmation } from "./approval-evidence.js";

export const approvalFeedbackSchema = z.object({
  status: z.enum(["none", "present", "unknown"]),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  sourceIds: z.array(z.string().min(1).max(300)).max(300),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.status === "present" ? snapshot.fingerprint === null || snapshot.sourceIds.length === 0 : snapshot.fingerprint !== null || snapshot.sourceIds.length > 0) {
    ctx.addIssue({ code: "custom", message: "Feedback identity must match its status" });
  }
});
export type ApprovalFeedbackSnapshot = z.infer<typeof approvalFeedbackSchema>;

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceId = z.string().min(1).max(300);
export const feedbackFindingSchema = z.object({
  sourceId,
  resolution: z.enum(["fixed", "already-satisfied", "no-change-needed"]),
  evidence: z.string().trim().min(10).max(1_500),
  validation: z.object({
    outcome: z.enum(["passed", "not-needed", "failed", "blocked"]),
    detail: z.string().trim().min(3).max(800),
  }).strict(),
}).strict();
export const feedbackReportSchema = z.object({
  attemptId: z.string().min(1).max(100),
  headOid: sha,
  fingerprint,
  findings: z.array(feedbackFindingSchema).min(1).max(300),
  blockers: z.array(z.string().max(500)).max(20),
}).strict();
export const approvalFeedbackProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worker") }).strict(),
  z.object({ kind: z.literal("legacy-reconciliation"), auditThreadId: z.string().trim().min(1).max(200),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(100) }).strict(),
  // You confirmed the feedback handled from the inventory: your word, not a worker's evidence. The merge preview and every other reader
  // read it as verified all the same, as they read every variant: provenance is the record's audit trail, not a gate.
  // `evidence` is what GitHub showed since the approval when you confirmed; a record without it predates that check.
  z.object({ kind: z.literal("user"), evidence: approvalEvidenceSchema.optional() }).strict(),
]);
export type ApprovalFeedbackProvenance = z.infer<typeof approvalFeedbackProvenanceSchema>;
const recordSchema = feedbackReportSchema.extend({
  prUrl: z.string().max(500),
  threadId: z.string().min(1).max(200),
  verifiedAt: z.number().int().nonnegative(),
  // Older worker records predate explicit provenance; only audited recovery uses the legacy variant.
  provenance: approvalFeedbackProvenanceSchema.default({ kind: "worker" }),
  equivalence: z.object({ sourceHeadOid: sha, sourceVerifiedAt: z.number().int().nonnegative(),
    treeOid: sha, checkedAt: z.number().int().nonnegative() }).strict().optional(),
});

// Callers may still construct pre-provenance records; parsing supplies the worker default.
export type ApprovalFeedbackRecord = z.input<typeof recordSchema>;
export const APPROVAL_FEEDBACK_MIGRATION =
  "CREATE TABLE IF NOT EXISTS approval_feedback_verifications (pr_url TEXT PRIMARY KEY, body TEXT NOT NULL)";
/** Append-only: server.ts adds this after Linear seed provenance (id 65). Each confirmation you record or revoke, with what it covered. */
export const APPROVAL_CONFIRMATION_AUDIT_MIGRATION =
  "CREATE TABLE IF NOT EXISTS approval_confirmation_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, pr_url TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL)";
export function feedbackVerified(snapshot: ApprovalFeedbackSnapshot, headOid: string | null, record: ApprovalFeedbackRecord | null): boolean {
  if (snapshot.status === "none") return true;
  if (snapshot.status !== "present" || snapshot.fingerprint === null || headOid === null || record === null) return false;
  return record.headOid === headOid && record.fingerprint === snapshot.fingerprint && record.blockers.length === 0 &&
    record.findings.every((finding) => finding.validation.outcome === "passed" || finding.validation.outcome === "not-needed") &&
    JSON.stringify(record.findings.map((item) => item.sourceId).sort()) === JSON.stringify([...snapshot.sourceIds].sort());
}

export function feedbackVerificationState(snapshot: ApprovalFeedbackSnapshot | undefined, headOid: string | null,
  record: ApprovalFeedbackRecord | null): "none" | "verified" | "missing" | "head-changed" | "feedback-changed" | "unknown" {
  if (snapshot?.status === "none") return "none";
  if (snapshot?.status !== "present" || headOid === null) return "unknown";
  if (record === null) return "missing";
  if (!feedbackVerified(snapshot, record.headOid, record)) return "feedback-changed";
  if (record.headOid !== headOid) return "head-changed";
  return "verified";
}

/** Your confirmation on a PR, as its row shows it: when, whether it still covers this head and these notes, and whether evidence backed it. */
export function userConfirmation(record: ApprovalFeedbackRecord | null, snapshot: ApprovalFeedbackSnapshot | undefined, headOid: string | null): UserConfirmation | null {
  if (record?.provenance?.kind !== "user") return null;
  return { at: record.verifiedAt, current: feedbackVerificationState(snapshot, headOid, record) === "verified",
    evidence: record.provenance.evidence ? handled(record.provenance.evidence) : null };
}

export function createApprovalFeedbackStore(db: RunDb) {
  const store = {
    get(prUrl: string): ApprovalFeedbackRecord | null {
      const key = canonicalPrUrl(prUrl);
      if (key === null) return null;
      const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(key) as { body: string } | undefined;
      if (!row) return null;
      try { return recordSchema.safeParse(JSON.parse(row.body)).data ?? null; } catch { return null; }
    },
    save(prUrl: string, threadId: string, report: z.infer<typeof feedbackReportSchema>, verifiedAt: number,
      provenance: ApprovalFeedbackProvenance = { kind: "worker" }): ApprovalFeedbackRecord {
      const key = canonicalPrUrl(prUrl);
      if (key === null) throw new Error("Invalid PR URL for feedback verification");
      const record = recordSchema.parse({ ...report, prUrl: key, threadId, verifiedAt, provenance });
      db.prepare("INSERT OR REPLACE INTO approval_feedback_verifications (pr_url, body) VALUES (?, ?)").run(key, JSON.stringify(record));
      return record;
    },
    /**
     * A worker's evidence onto a new head whose tree is identical. Your confirmation never carries: it covers the head you confirmed on,
     * and any later head asks for the notes again.
     */
    carryEquivalent(prUrl: string, expected: ApprovalFeedbackRecord, snapshot: ApprovalFeedbackSnapshot,
      currentHeadOid: string, priorTreeOid: string, currentTreeOid: string, checkedAt: number): ApprovalFeedbackRecord | null {
      const key = canonicalPrUrl(prUrl);
      if (key === null || expected.provenance?.kind === "user" || expected.headOid === currentHeadOid || priorTreeOid !== currentTreeOid ||
          !sha.safeParse(currentHeadOid).success || !sha.safeParse(priorTreeOid).success ||
          !feedbackVerified(snapshot, expected.headOid, expected)) return null;
      const row = db.prepare("SELECT body FROM approval_feedback_verifications WHERE pr_url = ?").get(key) as { body: string } | undefined;
      if (!row) return null;
      let body: unknown;
      try { body = JSON.parse(row.body); } catch { return null; }
      const parsed = recordSchema.safeParse(body);
      if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(recordSchema.parse(expected))) return null;
      const next = recordSchema.parse({ ...parsed.data, headOid: currentHeadOid,
        equivalence: { sourceHeadOid: parsed.data.equivalence?.sourceHeadOid ?? parsed.data.headOid,
          sourceVerifiedAt: parsed.data.equivalence?.sourceVerifiedAt ?? parsed.data.verifiedAt,
          treeOid: currentTreeOid, checkedAt } });
      db.prepare("UPDATE approval_feedback_verifications SET body = ? WHERE pr_url = ? AND body = ?")
        .run(JSON.stringify(next), key, row.body);
      const written = db.prepare("SELECT changes() AS count").get() as { count: number };
      return written.count === 1 ? next : null;
    },
    /** Take back your confirmation, at any age; a worker's evidence stays. The record it removed, or null when there was none of yours. */
    revoke(prUrl: string): ApprovalFeedbackRecord | null {
      const key = canonicalPrUrl(prUrl);
      const record = key === null ? null : store.get(key);
      if (record?.provenance?.kind !== "user") return null;
      db.prepare("DELETE FROM approval_feedback_verifications WHERE pr_url = ?").run(key);
      return record;
    },
    /**
     * Your confirmation that approval feedback is handled, bound to exactly this head and feedback: one finding per source that says it
     * is your word, what GitHub showed since the approval, and that no check ran. No thread or attempt did the work, so those fields name
     * the inventory and when you confirmed.
     */
    confirm(prUrl: string, snapshot: ApprovalFeedbackSnapshot, headOid: string, at: number, evidence: ApprovalEvidence): ApprovalFeedbackRecord {
      if (snapshot.status !== "present" || snapshot.fingerprint === null || !sha.safeParse(headOid).success) {
        throw new Error("Only approval feedback read on a known head can be confirmed");
      }
      const seen = `You confirmed this approval feedback handled${handled(evidence) ? "" : " without evidence"}. ${evidenceText(evidence)}.`;
      // Linked follow-ups are only shown, never counted, so the record leaves them out: an older build's strict schema can't read them.
      const { linked: _shown, ...kept } = evidence;
      return store.save(prUrl, "inventory", { attemptId: `confirmed-${at}`, headOid, fingerprint: snapshot.fingerprint, blockers: [],
        findings: snapshot.sourceIds.map((sourceId) => ({ sourceId, resolution: "already-satisfied" as const, evidence: seen,
          validation: { outcome: "not-needed" as const, detail: "Your confirmation; no check ran." } })) }, at, { kind: "user", evidence: kept });
    },
  };
  return store;
}
