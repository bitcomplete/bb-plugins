import type { Pr } from "./contract.js";

/** The open PR an entry is stacked on: another in its repository whose head branch is the entry's base. */
export function stackParent<T extends { repo: string; pr: Pick<Pr, "number" | "baseRefName" | "headRefName"> }>(entry: T, open: readonly T[]): T | null {
  const { pr } = entry;
  return pr.baseRefName === null ? null : open.find((candidate) =>
    candidate.repo.toLowerCase() === entry.repo.toLowerCase() && candidate.pr.number !== pr.number && candidate.pr.headRefName === pr.baseRefName,
  ) ?? null;
}
