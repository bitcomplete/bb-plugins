// The contract between team-setup's server entry and its host entry for the
// Figma step. The host entry runs on the developer's machine, where Claude
// Code and its MCP config live; the server only asks it what to show and
// relays what the developer pastes. Nothing here carries a token.
import { z } from "zod";

export const FIGMA_SERVER_NAME = "figma";
export const FIGMA_SERVER_URL = "https://mcp.figma.com/mcp";
// Claude Code's MCP OAuth callback is always http://localhost:<port>/callback,
// and the only knob it exposes is `oauth.callbackPort`. Pinning one port lets
// the step validate the URL the browser lands on and replay it against the
// loopback listener Claude Code opened. The same port is safe on every machine:
// the listener is loopback-only.
export const FIGMA_CALLBACK_PORT = 53280;

export const figmaHostContract = {
  // What the step needs to draw itself: whether `claude` is here, whether the
  // figma server is configured at user scope, whether it is signed in, and
  // whether a sign-in is waiting for its callback.
  state: {
    input: z.null(),
    output: z.object({
      claude: z.boolean(),
      configured: z.boolean(),
      authenticated: z.boolean(),
      pending: z.boolean(),
      // The authorization URL while a sign-in waits, so a reloaded page can show it again.
      url: z.string().nullable(),
      message: z.string().nullable(),
    }),
  },
  // Add the server at user scope and start `claude mcp login`, returning the
  // authorization URL and the callback port Claude chose. Idempotent: a second
  // call while one is pending returns the same URL.
  start: {
    input: z.null(),
    output: z.object({ url: z.string(), port: z.number().int().positive() }),
  },
  // Validate the callback URL the developer pasted and replay it against the
  // loopback listener. Returns the login process's own error when it fails.
  complete: {
    input: z.object({ url: z.string().trim().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },
  cancel: { input: z.null(), output: z.object({ ok: z.boolean() }) },
} as const;

export type FigmaHostState = z.infer<(typeof figmaHostContract)["state"]["output"]>;
