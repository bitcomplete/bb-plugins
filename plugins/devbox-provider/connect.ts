// Connecting this bb server to a developer's devbox project.
//
// devbox-gate runs the OAuth authorization-code flow with PKCE: the
// developer's browser approves at devbox's /connect/authorize, comes back to
// this plugin's callback with a code, and the plugin exchanges the code and
// its verifier for a bearer token on devbox-gate's in-cluster API listener.
// The callback URI must be registered with devbox-gate exactly; see the
// devbox repo's docs/connect.md.
import { createHash, randomBytes } from "node:crypto";

export interface PendingConnect {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface Connection {
  token: string;
  project: string;
}

// How long an approval page may be left open before its state is forgotten.
export const PENDING_TTL_MS = 15 * 60 * 1000;

const base64url = (b: Buffer) => b.toString("base64url");

export function newPendingConnect(redirectUri: string, now: number): PendingConnect {
  return {
    state: base64url(randomBytes(32)),
    verifier: base64url(randomBytes(48)), // 64 characters
    redirectUri,
    createdAt: now,
  };
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function authorizeUrl(devboxUrl: string, clientId: string, pending: PendingConnect): string {
  const u = new URL("/connect/authorize", devboxUrl);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", pending.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", pending.state);
  u.searchParams.set("code_challenge", challengeFor(pending.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeCode(
  apiUrl: string,
  clientId: string,
  pending: PendingConnect,
  code: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Connection> {
  const response = await fetchImpl(new URL("/connect/token", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof body.error_description === "string" ? body.error_description : `HTTP ${response.status}`;
    throw new Error(`devbox did not issue a token: ${reason}`);
  }
  if (typeof body.access_token !== "string" || typeof body.project !== "string") {
    throw new Error("devbox answered without a token");
  }
  return { token: body.access_token, project: body.project };
}

// Best effort: a token devbox no longer knows is already revoked.
export async function revokeToken(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchImpl(new URL("/connect/revoke", apiUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok && response.status !== 401) {
    throw new Error(`devbox did not revoke the token: HTTP ${response.status}`);
  }
}
