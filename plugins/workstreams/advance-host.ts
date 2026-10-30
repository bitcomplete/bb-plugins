// Whether a rewritten PR head kept its content. Nothing in this reader writes to GitHub or a checkout.
import { z } from "zod";
import { prTarget, type GhRunner, type Run } from "./ghactions.js";

const oid = z.string().regex(/^[0-9a-f]{40}$/u);
const commitTrees = new Map<string, string>();

/** Equal Git trees prove a head rewrite changed history without changing PR content. */
export async function readEqualHeadTrees(run: GhRunner, prUrl: string, priorHeadOid: string, currentHeadOid: string): Promise<{
  ok: true; priorTreeOid: string; currentTreeOid: string;
} | { ok: false }> {
  const target = prTarget(prUrl);
  if (!target || !oid.safeParse(priorHeadOid).success || !oid.safeParse(currentHeadOid).success || priorHeadOid === currentHeadOid) return { ok: false };
  const commit = z.object({ sha: oid, tree: z.object({ sha: oid }) });
  const tree = async (sha: string): Promise<string | null> => {
    const key = `${target.host}/${target.owner}/${target.name}/${sha}`.toLowerCase();
    const cached = commitTrees.get(key);
    if (cached) return cached;
    const response = await run(["api", ...(target.host === "github.com" ? [] : ["--hostname", target.host]),
      `repos/${target.owner}/${target.name}/git/commits/${sha}`]);
    const parsed = commit.safeParse(decoded(response));
    if (!parsed.success || parsed.data.sha !== sha) return null;
    if (commitTrees.size >= 256) commitTrees.delete(commitTrees.keys().next().value!);
    commitTrees.set(key, parsed.data.tree.sha);
    return parsed.data.tree.sha;
  };
  const [oldTree, freshTree] = await Promise.all([tree(priorHeadOid), tree(currentHeadOid)]);
  if (!oldTree || !freshTree || oldTree !== freshTree) return { ok: false };
  const final = await run(["pr", "view", String(target.number), "--repo", target.slug, "--json", "url,state,headRefOid"]);
  const view = z.object({ url: z.string(), state: z.literal("OPEN"), headRefOid: oid }).safeParse(decoded(final));
  if (!view.success || view.data.url.toLowerCase() !== prUrl.toLowerCase() || view.data.headRefOid !== currentHeadOid) return { ok: false };
  return { ok: true, priorTreeOid: oldTree, currentTreeOid: freshTree };
}

function decoded(result: Run): unknown {
  if (!result.ok) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}
