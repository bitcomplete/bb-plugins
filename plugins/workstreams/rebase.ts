/**
 * `git rev-parse --abbrev-ref HEAD` says `HEAD` during a rebase. Git records
 * the branch being rebased in one of these per-worktree `head-name` files.
 * A detached checkout without that metadata has no branch to look up on GitHub.
 */
export function checkoutBranch(
  head: string | null,
  rebaseHeadNames: readonly { present: boolean; name: string | null }[],
): { branch: string | null; rebasing: boolean } {
  const rebasing = rebaseHeadNames.some((entry) => entry.present);
  if (head !== null && head !== "" && head !== "HEAD") return { branch: head, rebasing };
  if (!rebasing) return { branch: null, rebasing: false };

  const branches = rebaseHeadNames.flatMap((entry) => {
    if (!entry.present || entry.name === null) return [];
    const ref = entry.name.trim();
    if (!ref.startsWith("refs/heads/")) return [];
    const branch = ref.slice("refs/heads/".length);
    // Git's ref restrictions, plus our wire cap. Reject malformed metadata
    // instead of associating an unrelated detached checkout with a PR.
    if (branch === "" || branch === "HEAD" || branch.length > 300 || branch.startsWith("/") || branch.endsWith("/") ||
        branch.includes("//") || branch.includes("..") || branch.includes("@{") ||
        /[\u0000-\u0020\u007f~^:?*\\[]/u.test(branch) ||
        branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) return [];
    return [branch];
  });
  return { branch: branches.length > 0 && branches.every((name) => name === branches[0]) ? branches[0]! : null, rebasing };
}
