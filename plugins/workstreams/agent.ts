// Agent actions: read the row's linked threads live, recommend where the work
// should run, and run it there. Behind a narrow SDK interface, so both halves
// are tested against a fake without a live BB.
import {
  recommendThread,
  type Recommendation,
  type ThreadCandidate,
  type ThreadCapabilities,
  type ThreadMode,
} from "./actions.js";
import { startThread, type SpawnSdk, type StartResult } from "./spawn.js";
import type { ThreadTier } from "./threads.js";

/** The slice of `bb.sdk.threads` agent actions need, on top of spawning. */
export type AgentSdk = SpawnSdk & {
  threads: SpawnSdk["threads"] & {
    get(args: { threadId: string }): Promise<{
      id: string;
      title: string | null;
      titleFallback: string | null;
      status: string;
      updatedAt: number;
      canSpawnChild: boolean;
    }>;
    context?(args: { threadId: string }): Promise<{ usage: { usedTokens: number; modelContextWindow: number } | null }>;
  };
};

/** Board action capabilities; shared-thread sends cannot be tracked by turn. */
export function capabilitiesOf(sdk: AgentSdk): ThreadCapabilities {
  return {
    send: false,
    // `parentThreadId` is part of the spawn request in every SDK this plugin supports (>= 0.4.104).
    subthread: true,
    contextUsage: typeof sdk.threads.context === "function",
  };
}

export type LinkedThread = { id: string; title: string; tier: ThreadTier };

/** At most this many linked threads are read live when a dialog opens. */
export const PLAN_THREADS = 8;

/**
 * Read each linked thread's status, recency and context use. A thread that
 * cannot be read is left out rather than guessed at; a context read that fails
 * is null, which the recommendation treats as "not reported".
 */
export async function candidatesFor(sdk: AgentSdk, links: readonly LinkedThread[]): Promise<ThreadCandidate[]> {
  const read = async (link: LinkedThread): Promise<ThreadCandidate | null> => {
    try {
      const thread = await sdk.threads.get({ threadId: link.id });
      let contextUsed: number | null = null;
      if (sdk.threads.context !== undefined) {
        try {
          const usage = (await sdk.threads.context({ threadId: link.id })).usage;
          if (usage !== null && usage.modelContextWindow > 0) contextUsed = usage.usedTokens / usage.modelContextWindow;
        } catch {
          contextUsed = null;
        }
      }
      return {
        id: thread.id,
        title: (thread.title ?? thread.titleFallback ?? link.title).slice(0, 200),
        tier: link.tier,
        running: thread.status !== "idle" && thread.status !== "error",
        updatedAt: thread.updatedAt,
        contextUsed,
        canSpawnChild: thread.canSpawnChild,
      };
    } catch {
      return null;
    }
  };
  const results = await Promise.all(links.slice(0, PLAN_THREADS).map(read));
  return results.filter((candidate): candidate is ThreadCandidate => candidate !== null);
}

export type Plan = { candidates: ThreadCandidate[]; recommendation: Recommendation; capabilities: ThreadCapabilities };

export async function planAgent(
  sdk: AgentSdk,
  action: Parameters<typeof recommendThread>[0],
  links: readonly LinkedThread[],
): Promise<Plan> {
  const capabilities = capabilitiesOf(sdk);
  const candidates = await candidatesFor(sdk, links);
  return { candidates, recommendation: recommendThread(action, candidates, capabilities), capabilities };
}

/**
 * Run the agent action where the user chose. A subthread only accepts a
 * parent linked to this row; the client cannot supply an arbitrary thread id.
 */
export async function runAgent(
  sdk: AgentSdk,
  request: {
    unit: { path: string; ticket: string } | undefined;
    mode: ThreadMode;
    threadId: string | null;
    prompt: string;
    linked: readonly string[];
  },
): Promise<StartResult> {
  const { unit, mode, threadId, prompt, linked } = request;
  if (mode === "continue") {
    return { ok: false, error: "Continue in an existing thread cannot track this action reliably. Choose a subthread or new thread." };
  }
  if (mode === "new") return startThread(sdk, unit, prompt);
  if (threadId === null || !linked.includes(threadId)) {
    return { ok: false, error: "That thread is not linked to this row any more. Reopen the dialog." };
  }
  return startThread(sdk, unit, prompt, threadId);
}
