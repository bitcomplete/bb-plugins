export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface Paper {
  id: string; version: string; title: string; abstract: string; authors: string[];
  publishedAt: string; updatedAt: string; url: string; source: "arxiv" | "dair";
  fwci: number | null; authorSignal: number | null; retrievedAt: string;
  /** URLs supporting the metrics, not merely the paper's abstract URL. */
  credibilityEvidenceUrls?: string[];
}
