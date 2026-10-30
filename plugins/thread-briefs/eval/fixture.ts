import type { BriefFields, StoredBriefStatus } from "../contract.js";
import type { OutlineItem } from "../transcript.js";

/** One frozen thread, as `eval/export.ts` writes it. */
export interface EvalFixture {
  threadId: string;
  title: string | null;
  outline: OutlineItem[];
  lastAssistantText: string | null;
  /** The brief stored when the fixture was taken: the next summary's starting point. */
  previousBrief: BriefFields | null;
  /** What the live plugin showed for this thread when the fixture was taken. */
  stored: { status: string; statusOverride: string | null } | null;
}

/** `labels.json`: the status a person says each thread should read. */
export type EvalLabels = Record<string, StoredBriefStatus>;
