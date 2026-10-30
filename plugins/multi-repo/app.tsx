/**
 * Frontend registrations.
 *
 * Four surfaces, each answering something bb cannot answer for a workspace
 * whose root is not a git repo: a nav panel for the repo set (there is no
 * project-settings slot to put it in), a thread panel for diff and pull
 * requests (the native diff tab and PR badge never appear for these threads),
 * a composer banner so the thread view says a diff exists at all (bb's own
 * changed-files section reads the thread checkout and finds a plain directory),
 * and a file opener so a workspace file link lands with its repo named.
 */
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract.js";
import { ChangesBanner } from "./changes-banner.js";
import { ChangesPanel } from "./changes-panel.js";
import { ReposPanel } from "./repos-panel.js";
import {
  CHANGES_ACTION_ID,
  CHANGES_BANNER_ID,
  CHANGES_TAB_TITLE,
  COMPOSER_CUSTOMIZATION_ID,
  REPOS_PANEL_ID,
  REPOS_PANEL_PATH,
} from "./shared.js";

/**
 * Extensions the file opener claims.
 *
 * Deliberately a short list of source and config files rather than everything:
 * registering an opener makes this plugin the default for those extensions
 * app-wide, in every project, and the component below delegates straight to
 * bb's own preview whenever the file is not in a multi-repo workspace. The
 * addition is a one-line header naming the repo, which is worth having for a
 * path like `src/index.ts` that exists in three of the repos at once and is
 * worth nothing anywhere else. Users can pin bb's preview per extension under
 * Settings → File openers.
 */
const CLAIMED_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "json", "yaml", "yml", "toml", "sql", "sh", "css", "scss", "html",
];

interface FileOpenerProps {
  path: string;
  source: {
    kind: "workspace" | "host" | "thread-storage";
    threadId: string | null;
    environmentId: string | null;
    projectId: string | null;
  };
  Original: ComponentType<Record<string, never>>;
}

/**
 * bb's preview, with the repo named above it when the file is in one of ours.
 *
 * A multi-repo workspace path is `<repo>/<path-inside-the-repo>`, and the
 * repo half is exactly the context a bare `src/index.ts` in the tab title
 * loses. Everything else — loading, editing, syntax, the CAS save — stays
 * bb's, because reimplementing a file viewer to add a breadcrumb would be a
 * bad trade for the user and for this plugin.
 */
function WorkspaceFileOpener({ path, source, Original }: FileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [repoDir, setRepoDir] = useState<string | null>(null);
  const threadId = source.threadId;

  useEffect(() => {
    if (source.kind !== "workspace" || threadId === null) {
      setRepoDir(null);
      return;
    }
    let cancelled = false;
    void rpc
      .call("workspace", { threadId })
      .then((result) => {
        if (cancelled || result.workspace === null) return;
        const segment = path.split("/")[0];
        const match = result.workspace.repos.find((repo) => repo.dir === segment);
        setRepoDir(match === undefined ? null : match.dir);
      })
      .catch(() => {
        // A thread with no multi-repo workspace is the overwhelmingly common
        // case here — this opener is registered app-wide. Silence is right.
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, source.kind, path]);

  if (repoDir === null) return <Original />;
  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground border-b px-3 py-1 font-mono text-xs">
        <span className="text-foreground">{repoDir}</span>
        {" · "}
        {path.slice(repoDir.length + 1)}
      </div>
      <div className="min-h-0 flex-1">
        <Original />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: REPOS_PANEL_ID,
    title: "Repos",
    icon: "FolderGit",
    path: REPOS_PANEL_PATH,
    component: ReposPanel,
  });

  app.slots.threadPanelAction({
    id: CHANGES_ACTION_ID,
    title: "Changes",
    // `flush`, not the default padding: this panel owns a header row, its own
    // scroll region and a diff viewer that needs the full width.
    layout: "flush",
    component: ChangesPanel,
    run: ({ openPanel }) => {
      openPanel({ title: CHANGES_TAB_TITLE });
    },
  });

  // Scoped to the thread composer: this is a fact about one thread's checkout,
  // so it has nothing to say in root compose, and a queued message being
  // edited is not the place to put it either.
  app.composer.customize({
    id: COMPOSER_CUSTOMIZATION_ID,
    scopes: ["thread"],
    banners: [{ id: CHANGES_BANNER_ID, chrome: "card", component: ChangesBanner }],
  });

  app.slots.fileOpener({
    id: "workspace-file",
    title: "Multi-repo file",
    extensions: CLAIMED_EXTENSIONS,
    component: WorkspaceFileOpener,
  });
});
