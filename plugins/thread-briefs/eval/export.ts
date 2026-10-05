/**
 * Freeze real threads from a running bb server into eval fixtures.
 *
 *   npx vite-node eval/export.ts -- <out-dir> [threadId ...]
 *
 * With no thread ids, exports every thread that has a stored brief. Each
 * fixture is what `summarizeThread` would hand `renderTranscript` if the thread
 * were re-summarized now: the conversation outline, the agent's last message,
 * and the stored brief as the previous brief. The outline is rebuilt from the
 * event log rather than read from `threads.conversationOutline`, which only the
 * plugin can call; `renderTranscript` clamps each preview to 400 characters, so
 * the two differ only in which events bb counts as a message.
 *
 * Fixtures are real transcripts. Write them somewhere outside this repository:
 * bb-plugins is public.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalFixture } from "./fixture.js";

function bb(args: string[]): string {
  return execFileSync("bb", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function rpc(method: string, input: unknown): unknown {
  const dir = mkdtempSync(join(tmpdir(), "tb-eval-"));
  const file = join(dir, "input.json");
  writeFileSync(file, JSON.stringify(input));
  return JSON.parse(
    bb(["plugin", "rpc", "call", "thread-briefs", method, "--input-file", file, "--json"]),
  );
}

interface LogEvent {
  type: string;
  data: Record<string, unknown>;
}

function outlineFromLog(events: LogEvent[]): EvalFixture["outline"] {
  const outline: EvalFixture["outline"] = [];
  for (const event of events) {
    if (
      event.type === "client/turn/requested" &&
      event.data.initiator === "user"
    ) {
      const input = (event.data.input ?? []) as { type: string; text?: string }[];
      const text = input
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text !== "") outline.push({ role: "user", preview: text });
    }
    if (event.type === "item/completed") {
      const item = event.data.item as { type?: string; text?: unknown } | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim() !== "") {
        outline.push({ role: "assistant", preview: item.text });
      }
    }
  }
  return outline;
}

const [outDir, ...requested] = process.argv.slice(2).filter((arg) => arg !== "--");
if (outDir === undefined) {
  console.error("usage: vite-node eval/export.ts -- <out-dir> [threadId ...]");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const threadIds =
  requested.length > 0
    ? requested
    : (rpc("listBriefCards", null) as { cards: { threadId: string }[] }).cards.map(
        (card) => card.threadId,
      );

for (const threadId of threadIds) {
  const state = rpc("getBrief", { threadId }) as {
    state: string;
    brief?: Record<string, unknown>;
  };
  const brief = state.state === "ready" ? state.brief : undefined;
  const { thread } = JSON.parse(bb(["thread", "show", threadId, "--json"])) as {
    thread: { title: string | null; titleFallback: string | null };
  };
  const events = JSON.parse(bb(["thread", "log", threadId, "--json", "--all"])) as LogEvent[];
  const output = bb(["thread", "output", threadId]).trim();

  const fixture: EvalFixture = {
    threadId,
    title: thread.title ?? thread.titleFallback ?? null,
    outline: outlineFromLog(events),
    lastAssistantText: output === "" || output === "(no output)" ? null : output,
    previousBrief:
      brief === undefined
        ? null
        : {
            ...(typeof brief.title === "string" ? { title: brief.title } : {}),
            goal: String(brief.goal ?? ""),
            currentState: String(brief.currentState ?? ""),
            nextStep: String(brief.nextStep ?? ""),
            ...(typeof brief.nextStepActor === "string"
              ? { nextStepActor: brief.nextStepActor as "me" | "agent" | "other" }
              : {}),
            blockedOn: String(brief.blockedOn ?? ""),
            constraints: String(brief.constraints ?? ""),
          },
    stored:
      brief === undefined
        ? null
        : {
            status: String(brief.status),
            statusOverride: (brief.statusOverride as string | null) ?? null,
          },
  };
  writeFileSync(join(outDir, `${threadId}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${threadId}  ${fixture.outline.length} messages  ${fixture.title ?? ""}`);
}
