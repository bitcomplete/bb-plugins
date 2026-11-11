/**
 * THROWAWAY: a minimal caller for the generic realtime surface.
 *
 * This is the smallest thing that opens a session the way another plugin
 * would — it asks for instructions and a tool, mints the ephemeral secret,
 * makes one tool call and closes — so the surface can be proven end to end
 * without a browser or a second plugin. The huddle (a later slice) is the
 * real caller; once it exists, delete this file and `caller.test.ts`.
 *
 * The transport is whatever drives the plugin: the test wires it to the
 * plugin's own routes, and a human could wire it to a running server.
 */
import type { MintedRealtimeSession, RealtimeTool } from "../realtime-shared.js";

export type ThrowawayCallerTransport = {
  open: (config: {
    instructions: string;
    tools: RealtimeTool[];
    toolHandler: { method: string } | null;
  }) => Promise<{ sessionId: string }>;
  mint: (sessionId: string) => Promise<MintedRealtimeSession>;
  toolCall: (call: {
    sessionId: string;
    callId: string;
    name: string;
    arguments: string;
  }) => Promise<{ output: string }>;
  close: (sessionId: string) => Promise<void>;
};

export const THROWAWAY_INSTRUCTIONS =
  "You are the voice-transcription plugin's throwaway caller. Call the echo tool once with the word ping, then say done.";

export const THROWAWAY_TOOLS: RealtimeTool[] = [
  {
    name: "echo",
    description: "Echo the given text back.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

export async function runThrowawayCaller(
  transport: ThrowawayCallerTransport,
): Promise<{ sessionId: string; minted: MintedRealtimeSession; toolOutput: string }> {
  const opened = await transport.open({
    instructions: THROWAWAY_INSTRUCTIONS,
    tools: THROWAWAY_TOOLS,
    toolHandler: { method: "echo" },
  });
  const minted = await transport.mint(opened.sessionId);
  const tool = await transport.toolCall({
    sessionId: opened.sessionId,
    callId: "throwaway-call-1",
    name: "echo",
    arguments: JSON.stringify({ text: "ping" }),
  });
  await transport.close(opened.sessionId);
  return { sessionId: opened.sessionId, minted, toolOutput: tool.output };
}
