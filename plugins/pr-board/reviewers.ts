// Eligible reviewers and CODEOWNERS suggestions share one GitHub boundary.
import { z } from "zod";
import type { CalmRow } from "./board.js";

export type Github = (args: string[]) => Promise<string>;
const loginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
export const reviewerChoiceSchema = z.object({ login: loginSchema, owned: z.boolean(), load: z.number().int().nonnegative() });
export const reviewerOptionsSchema = z.object({ key: z.string(), candidates: z.array(reviewerChoiceSchema), note: z.string().nullable() });
const collaboratorsSchema = z.array(z.array(z.object({ login: loginSchema, type: z.string() })));
const filesSchema = z.array(z.array(z.object({ filename: z.string() })));

/** CODEOWNERS uses the last matching pattern. Teams remain explicit missing individual ownership. */
function ownersOf(text: string, file: string): string[] {
  let owners: string[] = [];
  for (const line of text.split("\n")) {
    const [pattern, ...names] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#")) continue;
    // GitHub CODEOWNERS does not support negation or character ranges.
    if (pattern.startsWith("!") || pattern.includes("[")) continue;
    if (pattern.includes("\\")) throw new Error("Escaped CODEOWNERS patterns need manual reviewer selection");
    const directory = pattern.endsWith("/");
    const glob = pattern.replace(/^\//, "").replace(/\/$/, "");
    const anchored = pattern.startsWith("/") || glob.includes("/");
    let source = "";
    for (let i = 0; i < glob.length; i++) {
      const char = glob[i]!;
      if (glob.slice(i, i + 3) === "**/") { source += "(?:.*/)?"; i += 2; }
      else if (glob.slice(i, i + 2) === "**") { source += ".*"; i++; }
      else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    const expression = (anchored ? "^" : "(?:^|/)") + source + (directory ? "/.*$" : "(?:/.*)?$");
    if (new RegExp(expression).test(file)) {
      const comment = names.findIndex((name) => name.startsWith("#"));
      owners = names.slice(0, comment < 0 ? names.length : comment).filter((name) => name.startsWith("@"));
    }
  }
  return owners;
}

export async function reviewerOptions(github: Github, row: CalmRow, author: string, rows: CalmRow[]) {
  const pages = collaboratorsSchema.parse(JSON.parse(await github(["api", `repos/${row.repo}/collaborators?per_page=100`, "--paginate", "--slurp"])));
  const eligible = new Set(pages.flat().filter((person) => person.type === "User" && person.login !== author).map((person) => person.login));
  let note: string | null = null;
  const owned = new Set<string>();
  try {
    let codeowners: string | null = null;
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      try { codeowners = await github(["api", `repos/${row.repo}/contents/${path}`, "-H", "Accept: application/vnd.github.raw+json"]); break; }
      catch (cause) { if (!(cause instanceof Error) || !/404|not found/i.test(cause.message)) throw cause; }
    }
    if (codeowners !== null) {
      const files = filesSchema.parse(JSON.parse(await github(["api", `repos/${row.repo}/pulls/${row.number}/files?per_page=100`, "--paginate", "--slurp"])));
      for (const file of files.flat()) for (const owner of ownersOf(codeowners, file.filename)) {
        const login = owner.slice(1);
        if (eligible.has(login)) owned.add(login);
      }
    }
    if (owned.size === 0) note = "No eligible individual CODEOWNER found. Pick a reviewer.";
  } catch {
    note = "Ownership suggestions unavailable. Pick an eligible reviewer.";
  }
  const load = new Map<string, number>();
  for (const pr of rows) if (pr.segment === "on-reviewers") for (const person of pr.waiting) load.set(person.login, (load.get(person.login) ?? 0) + 1);
  const candidates = [...eligible].map((login) => ({ login, owned: owned.has(login), load: load.get(login) ?? 0 }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || a.load - b.load || a.login.localeCompare(b.login));
  return { key: row.key, candidates, note };
}

export async function requestReview(github: Github, row: CalmRow, reviewers: string[], author: string, rows: CalmRow[]): Promise<void> {
  if (row.group !== "one-click" || row.segment !== "on-you" || row.blocked) throw new Error("The PR no longer needs a review request. Refresh the board.");
  const { candidates } = await reviewerOptions(github, row, author, rows);
  const eligible = new Set(candidates.map((candidate) => candidate.login));
  const logins = [...new Set(reviewers)];
  if (logins.length === 0 || logins.some((login) => !eligible.has(login))) throw new Error("Choose an eligible reviewer before sending.");
  await github(["api", "--method", "POST", `repos/${row.repo}/pulls/${row.number}/requested_reviewers`, ...logins.flatMap((login) => ["-f", `reviewers[]=${login}`])]);
}
