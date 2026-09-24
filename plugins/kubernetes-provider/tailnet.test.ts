import { describe, expect, it, vi } from "vitest";
import { createTailnetMinter, readTailnetCredentials } from "./tailnet.js";

const credentials = {
  clientId: "cid",
  clientSecret: "csecret",
  tagPrefix: "example",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readTailnetCredentials", () => {
  it("reads the sealed tailnet-minter Secret", () => {
    expect(
      readTailnetCredentials({
        TS_OAUTH_CLIENT_ID: "cid",
        TS_OAUTH_CLIENT_SECRET: "csecret",
        TS_TAG_PREFIX: "example",
      }),
    ).toEqual(credentials);
  });

  // An install with no minter Secret is a working configuration rather than
  // a broken one: its pods just do not join the tailnet.
  it("is absent unless all three are present", () => {
    expect(readTailnetCredentials({})).toBeNull();
    expect(
      readTailnetCredentials({ TS_OAUTH_CLIENT_ID: "cid", TS_OAUTH_CLIENT_SECRET: "csecret" }),
    ).toBeNull();
    expect(
      readTailnetCredentials({
        TS_OAUTH_CLIENT_ID: "  ",
        TS_OAUTH_CLIENT_SECRET: "csecret",
        TS_TAG_PREFIX: "example",
      }),
    ).toBeNull();
  });
});

describe("tagFor", () => {
  // The whole of a pod's authority: the cluster binds this group name to an admin
  // Role in each namespace that admitted the machine.
  it("is the install prefix and the machine name", () => {
    const minter = createTailnetMinter(credentials, vi.fn());
    expect(minter.tagFor("acme")).toBe("tag:example-acme");
  });
});

describe("mintAuthKey", () => {
  it("exchanges the client for a token, then asks for one ephemeral key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok" }))
      .mockResolvedValueOnce(jsonResponse({ key: "tskey-auth-xxx" }));
    const minter = createTailnetMinter(credentials, fetchImpl as unknown as typeof fetch);

    const key = await minter.mintAuthKey("acme", new AbortController().signal);

    expect(key).toBe("tskey-auth-xxx");
    const [tokenUrl] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe("https://api.tailscale.com/api/v2/oauth/token");
    const [keysUrl, keysInit] = fetchImpl.mock.calls[1];
    expect(keysUrl).toBe("https://api.tailscale.com/api/v2/tailnet/-/keys");
    expect(keysInit.headers.authorization).toBe("Bearer tok");
    const body = JSON.parse(keysInit.body);
    expect(body.capabilities.devices.create).toMatchObject({
      reusable: false,
      ephemeral: true,
      preauthorized: true,
      tags: ["tag:example-acme"],
    });
  });

  // The machine's own tag and nothing else. The client could apply any tag
  // its minter tag owns, so narrowing happens here rather than in the pod.
  it("never asks for a tag other than the machine's own", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok" }))
      .mockResolvedValueOnce(jsonResponse({ key: "tskey-auth-xxx" }));
    const minter = createTailnetMinter(credentials, fetchImpl as unknown as typeof fetch);

    await minter.mintAuthKey("other", new AbortController().signal);

    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).capabilities.devices.create.tags).toEqual([
      "tag:example-other",
    ]);
  });

  // The ordinary "tag not declared yet" case: the machine's tag has to be a
  // tagOwners entry in the tailnet policy before the minter can apply it.
  it("reports the tag when Tailscale refuses it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok" }))
      .mockResolvedValueOnce(new Response("requested tags are invalid or not permitted", { status: 403 }));
    const minter = createTailnetMinter(credentials, fetchImpl as unknown as typeof fetch);

    await expect(minter.mintAuthKey("acme", new AbortController().signal)).rejects.toThrow(
      /tag:example-acme.*403/su,
    );
  });

  it("reports a rejected client without asking for a key", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const minter = createTailnetMinter(credentials, fetchImpl as unknown as typeof fetch);

    await expect(minter.mintAuthKey("acme", new AbortController().signal)).rejects.toThrow(
      /minter credentials/u,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
