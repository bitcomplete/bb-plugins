import type { ActivityAccounting } from "./activity-accounting.js";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { Accounting } from "./costs.js";
import type { ProblemRanking, RankedSolution } from "./domain/types.js";
import type { PaperAssessment } from "./stages/native-research.js";
import type { Paper } from "./adapters/types.js";

export function dataDirectory(store: Store): string {
  const rows = store.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const path = rows.find(r => r.name === "main")?.file;
  if (!path) throw new Error("plugin-storage-has-no-file");
  return dirname(path);
}
async function atomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try { file = await open(temp, "wx", 0o600); await file.writeFile(text, "utf8"); await file.sync(); await file.close(); file = undefined; await rename(temp, path); }
  finally { if (file) await file.close(); await rm(temp, { force: true }); }
}
/** The DB is authoritative; any interrupted publication is recreated on the next sweep. */
export class Exports {
  private current: Promise<void> = Promise.resolve();
  constructor(readonly store: Store, readonly directory: string,readonly accounting?:Accounting, readonly activity?: Pick<ActivityAccounting,"summary"|"forRun">) {}
  flush(): Promise<void> {
    this.current = this.current.catch(() => {}).then(async () => {
      const s = this.store;
      const snapshots = s.transaction(() => ({
        problems: s.list("problems"), solutions: s.list("solutions"), votes: s.list("votes"), costs: this.accounting?.summary().events ?? s.list("costs"), externalCosts:s.list("external-costs"),
        activity: this.activity?.summary(),
        runs: s.runs().map(run=>({...run,costs:this.accounting?.forRun(run.id).totals??[],...(this.activity?{activityCosts:this.activity.forRun(run.id)}:{})})), ranking: s.get<ProblemRanking>("ranking", "latest"),
        solutionRanking: s.get<RankedSolution[]>("solution-ranking", "latest") ?? [],
        papers:s.list<Paper>("papers"),assessments:s.list<PaperAssessment&{snapshotId:string}>("paper-assessments").filter(a=>a.snapshotId===s.get("snapshot","latest")),
        research:s.list<{snapshotId:string;warnings:string[]}>("research-results").filter(r=>r.snapshotId===s.get("snapshot","latest")),accessCosts:s.list("access-costs"),
      }));
      await mkdir(this.directory, { recursive: true });
      await mkdir(join(this.directory, "reports"), { recursive: true });
      await mkdir(join(this.directory, "runs"), { recursive: true });
      for (const [name, value] of [["problems.json", snapshots.problems], ["solutions.json", snapshots.solutions], ["solutions-ranked.json", snapshots.solutionRanking]] as const) await atomic(join(this.directory, name), JSON.stringify(value, null, 2) + "\n");
      for (const [name, values] of [["votes.jsonl", snapshots.votes], ["costs.jsonl", snapshots.costs],["cost-attestations.jsonl",snapshots.externalCosts]] as const) await atomic(join(this.directory, name), values.map(v => JSON.stringify(v)).join("\n") + (values.length ? "\n" : ""));
      if (snapshots.activity) await atomic(join(this.directory, "activity-costs.json"), JSON.stringify(snapshots.activity, null, 2) + "\n");
      const ranked = snapshots.ranking;
      await atomic(join(this.directory, "top.md"), "# Problems worth solving\n\n" + (ranked ? ranked.top.map((p,i) => `${i+1}. ${p.problemId} — score ${p.score.toFixed(3)}, ${p.voteCount} observations`).join("\n") + "\n\n## Wildcard discovery\n\n" + ranked.wildcards.map(w => `- ${w.id} — no recorded problem assumed`).join("\n") : "No ranking has completed yet.") + "\n");
      await atomic(join(this.directory, "solutions-ranked.md"), "# Possible solutions\n\n" + snapshots.solutionRanking.map(c => `- ${c.solutionId}: ${c.eligible ? `rank ${c.rank}` : "deferred"}; ${c.reasons.join("; ") || "eligible for a build experiment"}`).join("\n") + "\n");
      const md=(value:string)=>value.replace(/[\r\n]+/g," ").replace(/[\\`*_{}\[\]()<>!|]/g,"\\$&");
      const digest=snapshots.assessments.slice(0,100).map(a=>{
        const paper=snapshots.papers.find(p=>p.id===a.paperId&&p.version===a.version);
        return `- **${md(paper?.title??a.paperId)}** (${md(a.paperId+a.version)}) — ${md(a.problemId??a.wildcardQuery??"wildcard")}. ${a.status}; ${a.score===null?"full score unknown":`estimated Impact × Fit × Strength: ${a.score.toFixed(3)}`}. ${md(a.deferReasons.join("; "))}`;
      }).join("\n");
      await atomic(join(this.directory,"reports","research.md"),"# Research digest\n\nModel estimates describe hypotheses, not measured improvement.\n\n"+(digest||"No paper assessments for the current ranking yet.")+"\n\n"+snapshots.research.flatMap(r=>r.warnings??[]).map(w=>`- ${md(w)}`).join("\n")+"\n");
      await atomic(join(this.directory,"reports","research.json"),JSON.stringify({papers:snapshots.papers,assessments:snapshots.assessments,warnings:snapshots.research.flatMap(r=>r.warnings??[])},null,2)+"\n");
      await atomic(join(this.directory,"access-costs.jsonl"),snapshots.accessCosts.map(v=>JSON.stringify(v)).join("\n")+(snapshots.accessCosts.length?"\n":""));
      for (const run of snapshots.runs) await atomic(join(this.directory, "runs", `${run.id}.json`), JSON.stringify(run, null, 2) + "\n");
    });
    return this.current;
  }
}
