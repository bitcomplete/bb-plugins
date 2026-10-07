import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeUrl, challengeFor, exchangeCode, newPendingConnect, refreshTokens, revokeToken, SCOPES } from "./oauth.js";

const API = "https://api.linear.example";

describe("authorizeUrl", () => {
  it("asks Linear for a code with PKCE, the scopes, and the user actor", () => {
    const pending = newPendingConnect("https://bb.example/cb", 1000);
    const u = new URL(authorizeUrl("https://linear.example", "client-1", pending));
    expect(u.origin + u.pathname).toBe("https://linear.example/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-1");
    expect(u.searchParams.get("redirect_uri")).toBe("https://bb.example/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe(SCOPES.join(","));
    expect(u.searchParams.get("state")).toBe(pending.state);
    expect(u.searchParams.get("code_challenge")).toBe(challengeFor(pending.verifier));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("actor")).toBe("user");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("mints a fresh state and verifier each time", () => {
    const a = newPendingConnect("https://bb.example/cb", 0);
    const b = newPendingConnect("https://bb.example/cb", 0);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(challengeFor(a.verifier)).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier as a public client and reads the tokens", async () => {
    let form: URLSearchParams | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL, init: RequestInit) => {
      form = init.body as URLSearchParams;
      return Response.json({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 86400 });
    });
    const pending = newPendingConnect("https://bb.example/cb", 0);
    const tokens = await exchangeCode(API, "client-1", pending, "the-code", fetchImpl, new AbortController().signal, 5_000);
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 5_000 + 86400 * 1000 });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${API}/oauth/token`);
    expect(form!.get("grant_type")).toBe("authorization_code");
    expect(form!.get("code")).toBe("the-code");
    expect(form!.get("client_id")).toBe("client-1");
    expect(form!.get("redirect_uri")).toBe("https://bb.example/cb");
    expect(form!.get("code_verifier")).toBe(pending.verifier);
    expect(form!.has("client_secret")).toBe(false);
  });

  it("reports Linear's reason when it refuses, without the code", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "code expired" }, { status: 400 }));
    const pending = newPendingConnect("https://bb.example/cb", 0);
    await expect(exchangeCode(API, "c", pending, "secret-code", fetchImpl, new AbortController().signal, 0)).rejects.toThrow(/code expired/u);
    await expect(exchangeCode(API, "c", pending, "secret-code", fetchImpl, new AbortController().signal, 0)).rejects.not.toThrow(/secret-code/u);
  });

  it("tolerates an answer without expiry or refresh token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "at" }));
    const tokens = await exchangeCode(API, "c", newPendingConnect("x", 0), "code", fetchImpl, new AbortController().signal, 0);
    expect(tokens).toEqual({ accessToken: "at", refreshToken: null, expiresAt: null });
  });
});

describe("refreshTokens", () => {
  it("keeps the old refresh token when Linear does not rotate it", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init: RequestInit) => {
      const form = init.body as URLSearchParams;
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("rt-old");
      expect(form.get("client_id")).toBe("c");
      return Response.json({ access_token: "at-2", expires_in: 60 });
    });
    const tokens = await refreshTokens(API, "c", "rt-old", fetchImpl, new AbortController().signal, 1_000);
    expect(tokens).toEqual({ accessToken: "at-2", refreshToken: "rt-old", expiresAt: 61_000 });
  });

  it("takes a rotated refresh token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: "at-2", refresh_token: "rt-new", expires_in: 60 }));
    const tokens = await refreshTokens(API, "c", "rt-old", fetchImpl, new AbortController().signal, 0);
    expect(tokens.refreshToken).toBe("rt-new");
  });
});

describe("revokeToken", () => {
  it("sends the token as a bearer and accepts an already-revoked answer", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer at");
      return new Response("", { status: 401 });
    });
    await expect(revokeToken(API, "at", fetchImpl, new AbortController().signal)).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${API}/oauth/revoke`);
  });

  it("reports any other failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await expect(revokeToken(API, "at", fetchImpl, new AbortController().signal)).rejects.toThrow(/HTTP 500/u);
  });
});
