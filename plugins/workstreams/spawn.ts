// Starting a BB thread from a Board row: the plugin's one write-ish action.
// Kept out of server.ts behind a narrow SDK interface, so the exact spawn
// request can be tested against a fake without a live BB.
import { withinPath } from "./threads.js";

/** The slice of `bb.sdk` this needs. */
export type SpawnSdk = {
  projects: {
    list(): Promise<readonly { id: string; sources: readonly { hostId: string; path: string }[] }[]>;
  };
  threads: {
    spawn(args: {
      projectId: string;
      environment: {
        type: "host";
        hostId: string;
        workspace: { type: "unmanaged"; path: string };
      };
      prompt: string;
      pluginMetadata: { ticket: string };
      /** Set for a subthread: BB files it under this parent and tells the parent when it finishes. */
      parentThreadId?: string;
    }): Promise<{ id: string }>;
  };
};

export type StartResult = { ok: true; threadId: string; ticket: string } | { ok: false; error: string };

/**
 * The BB project whose source contains `path`, and the machine that source is
 * on. The deepest source wins, so a project rooted at a checkout beats one
 * rooted at the directory holding every checkout. Null when none contains it:
 * a guessed project would file the thread somewhere the user did not choose.
 */
export function projectForPath(
  projects: Awaited<ReturnType<SpawnSdk["projects"]["list"]>>,
  path: string,
): { projectId: string; hostId: string } | null {
  let best: { projectId: string; hostId: string; depth: number } | null = null;
  for (const project of projects) {
    for (const source of project.sources) {
      if (!withinPath(path, source.path)) continue;
      const depth = source.path.replace(/\/+$/u, "").length;
      if (best === null || depth > best.depth) best = { projectId: project.id, hostId: source.hostId, depth };
    }
  }
  return best === null ? null : { projectId: best.projectId, hostId: best.hostId };
}

/**
 * Spawn a thread that works IN the checkout: an unmanaged workspace at the
 * checkout's own path, so the new thread's environment is that checkout. No
 * provider or model is named, so BB applies the project's own defaults. The
 * cluster ticket is seeded into this plugin's thread metadata at spawn time,
 * which links the thread to its row before it has done anything.
 *
 * `unit` comes from the server's own scan, never from the client: the client
 * names a path, and only a path the last scan saw can be started.
 */
export async function startThread(
  sdk: SpawnSdk,
  unit: { path: string; ticket: string } | undefined,
  prompt: string,
  parentThreadId?: string,
): Promise<StartResult> {
  if (unit === undefined) return { ok: false, error: "That checkout is not on the board any more. Rescan and try again." };
  const text = prompt.trim();
  if (text === "") return { ok: false, error: "The prompt is empty." };
  const project = projectForPath(await sdk.projects.list(), unit.path);
  if (project === null) {
    return {
      ok: false,
      error: `No BB project contains ${unit.path}. Add a project whose folder holds this checkout, then try again.`,
    };
  }
  const thread = await sdk.threads.spawn({
    projectId: project.projectId,
    environment: { type: "host", hostId: project.hostId, workspace: { type: "unmanaged", path: unit.path } },
    prompt: text,
    pluginMetadata: { ticket: unit.ticket },
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
  });
  return { ok: true, threadId: thread.id, ticket: unit.ticket };
}
