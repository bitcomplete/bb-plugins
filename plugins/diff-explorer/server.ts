import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract, type DiffFile } from "./contract";

// Path installs run server.ts from the plugin root; git and npm installs run the bundled dist/server.js.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONACO_DIR = path.join(path.basename(HERE) === "dist" ? path.dirname(HERE) : HERE, "monaco");

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  host.experimental_onSignal("changed", ({ payload }) => bb.realtime.publish("changed", payload));

  async function environment(environmentId: string) {
    const env = await bb.sdk.environments.get({ environmentId });
    if (!env.path) throw new Error("This environment has no workspace path");
    if (!env.hostId) throw new Error("This environment has no host");
    return { root: env.path, hostId: env.hostId };
  }

  let preview: { baseUrl: string; expiresAtMs: number } | null = null;

  bb.rpc.register(rpcContract, {
    async assets() {
      if (preview === null || preview.expiresAtMs - Date.now() < 5 * 60_000) {
        preview = await bb.sdk.files.createPreview({ rootPath: MONACO_DIR, ttlMs: 60 * 60_000 });
      }
      return { baseUrl: preview.baseUrl };
    },

    async load({ threadId, target }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) throw new Error("This thread has no environment");
      const environmentId = thread.environmentId;
      const env = await bb.sdk.environments.get({ environmentId });
      if (!env.path) throw new Error("This environment has no workspace path");
      if (!env.hostId) throw new Error("This environment has no host");
      const root = env.path;
      const baseBranch = env.mergeBaseBranch ?? env.baseBranch ?? env.defaultBranch;
      if (baseBranch === null) throw new Error("This environment has no base branch");
      // "all" = everything since the merge base with the base branch, committed or not.
      const diff = await bb.sdk.environments.diffFiles(
        target === "uncommitted"
          ? { environmentId, target: "uncommitted" }
          : { environmentId, target: "all", mergeBaseBranch: baseBranch },
      );
      if (diff.outcome !== "available") {
        throw new Error(diff.outcome === "unavailable" ? diff.failure.message : diff.message);
      }
      const { mergeBaseRef } = diff;
      const query = target === "uncommitted" ? ({ target } as const) : mergeBaseRef === null ? null : ({ target, mergeBaseRef } as const);
      if (query === null) throw new Error(`No merge base with ${baseBranch}`);
      const side = async (filePath: string, which: "old" | "new") => {
        const result = await bb.sdk.environments.diffFile({ environmentId, ...query, path: filePath, side: which });
        if (result.contentEncoding !== "utf8") throw new Error(`${filePath} is not text`);
        return result.content;
      };
      const textual = diff.files.filter((f) => !f.binary && f.loadMode !== "too_large");
      // ponytail: loads every file up front; lazy-load per file if big diffs get slow
      const entries: DiffFile[] = await Promise.all(
        textual.map(async (f) => ({
          path: f.path,
          changeKind: f.changeKind,
          additions: f.additions,
          deletions: f.deletions,
          oldText: f.changeKind === "added" || f.origin === "untracked" ? "" : await side(f.previousPath ?? f.path, "old"),
          newText: f.changeKind === "deleted" ? "" : await side(f.path, "new"),
        })),
      );
      // "all" can list one path twice: deleted in a commit, then re-added uncommitted. Show it as one modification.
      const byPath = new Map<string, DiffFile>();
      for (const f of entries) {
        const prev = byPath.get(f.path);
        byPath.set(
          f.path,
          prev === undefined
            ? f
            : { ...f, changeKind: "modified", additions: prev.additions + f.additions, deletions: prev.deletions + f.deletions, oldText: prev.oldText || f.oldText, newText: f.newText || prev.newText },
        );
      }
      const files = [...byPath.values()];
      host.call("watch", { root }, { hostId: env.hostId }).catch((error) => bb.log.warn(`File watch failed: ${error}`));
      host
        .call("warm", { root, paths: files.filter((f) => f.newText !== "").map((f) => path.join(root, f.path)) }, { hostId: env.hostId })
        .catch((error) => bb.log.warn(`Language server warm-up failed: ${error}`));
      const skipped = diff.files.filter((f) => f.binary || f.loadMode === "too_large").map((f) => f.path);
      return { environmentId, root, baseBranch, files, skipped };
    },

    async definition({ environmentId, ...position }) {
      const { root, hostId } = await environment(environmentId);
      return host.call("definition", { root, ...position }, { hostId });
    },

    async read({ environmentId, path: filePath }) {
      const { hostId } = await environment(environmentId);
      return host.call("read", { path: filePath }, { hostId });
    },
  });
}
