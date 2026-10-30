// Connecting this bb server to a developer's Linear account.
//
// Linear runs the OAuth authorization-code flow with PKCE: the developer's
// browser approves at linear.app/oauth/authorize, comes back to this plugin's
// callback with a code, and the plugin exchanges the code and its verifier
// for an access token and a refresh token. With PKCE Linear treats the
// application as a public client, so no client secret is needed on any
// server. Access tokens last a day; refresh keeps the connection alive.
//
// Pure: no storage and no logging. A token appears only in return values,
// never in an error message.
import { createHash, randomBytes } from "node:crypto";

export const LINEAR_URL = "https://linear.app";
export const LINEAR_API_URL = "https://api.linear.app";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REVOKE_PATH = "/oauth/revoke";

// Everything the tools need and nothing more. `write` covers issueUpdate;
// comments and issues have their own create scopes.
export const SCOPES = ["read", "write", "issues:create", "comments:create"] as const;

export interface PendingConnect {
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when Linear gave no expiry. */
  expiresAt: number | null;
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

export function authorizeUrl(linearUrl: string, clientId: string, pending: PendingConnect): string {
  const u = new URL(AUTHORIZE_PATH, linearUrl);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", pending.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(","));
  u.searchParams.set("state", pending.state);
  u.searchParams.set("code_challenge", challengeFor(pending.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  // Changes land as the developer, not as the application.
  u.searchParams.set("actor", "user");
  // Always show the consent screen: a developer with several Linear
  // workspaces picks which one connects.
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

async function tokenRequest(apiUrl: string, form: Record<string, string>, fetchImpl: FetchLike, signal: AbortSignal, now: number): Promise<Tokens> {
  const response = await fetchImpl(new URL(TOKEN_PATH, apiUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const reason =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
    throw new Error(`Linear did not issue a token: ${reason}`);
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("Linear answered without a token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    expiresAt: typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? now + body.expires_in * 1000 : null,
  };
}

export function exchangeCode(
  apiUrl: string,
  clientId: string,
  pending: PendingConnect,
  code: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  now: number,
): Promise<Tokens> {
  return tokenRequest(
    apiUrl,
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    },
    fetchImpl,
    signal,
    now,
  );
}

/**
 * A new access token from the refresh token. Linear may or may not rotate
 * the refresh token; when the answer has none, the old one stays valid.
 */
export async function refreshTokens(
  apiUrl: string,
  clientId: string,
  refreshToken: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  now: number,
): Promise<Tokens> {
  const next = await tokenRequest(apiUrl, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, fetchImpl, signal, now);
  return { ...next, refreshToken: next.refreshToken ?? refreshToken };
}

// Best effort: a token Linear no longer knows is already revoked.
export async function revokeToken(apiUrl: string, accessToken: string, fetchImpl: FetchLike, signal: AbortSignal): Promise<void> {
  const response = await fetchImpl(new URL(REVOKE_PATH, apiUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok && response.status !== 401) {
    throw new Error(`Linear did not revoke the token: HTTP ${response.status}`);
  }
}
