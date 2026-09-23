// Minting the tailnet credential a machine pod joins with.
//
// The pod's tailnet identity is what the cluster authorizes: machine <name>
// joins as tag:<prefix>-<name>, and whatever in the cluster admits that tag
// (a RoleBinding for the matching Kubernetes group, when the API server sits
// behind the tailnet's Kubernetes operator) grants it access.
//
// Minting happens here, in the server, rather than in the pod. The OAuth
// client can apply any tag the minter tag owns — every machine here — so a pod
// holding the client could rejoin as one of its siblings and inherit whatever
// that machine was admitted to. Pods only ever receive a key already narrowed
// to their own tag, ephemeral and single-use.

const TAILSCALE_API = "https://api.tailscale.com/api/v2";

// Long enough to cover an image pull and a slow schedule, short enough that a
// leaked key is worthless by the time anyone finds it. The node it creates is
// ephemeral, so it disappears with the pod regardless.
const KEY_LIFETIME_SECONDS = 900;

export interface TailnetCredentials {
  clientId: string;
  clientSecret: string;
  tagPrefix: string;
}

export interface TailnetMinter {
  // tag:<prefix>-<machine>, the whole of this pod's authority.
  tagFor(machineName: string): string;
  mintAuthKey(machineName: string, signal: AbortSignal): Promise<string>;
}

// Read from TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET / TS_TAG_PREFIX in the server's
// environment, typically wired from a Secret. Absent is a normal state rather
// than a misconfiguration: an install with no minter simply does not put its
// pods on the tailnet.
export function readTailnetCredentials(
  env: NodeJS.ProcessEnv = process.env,
): TailnetCredentials | null {
  const clientId = env.TS_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.TS_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const tagPrefix = env.TS_TAG_PREFIX?.trim() ?? "";
  if (clientId.length === 0 || clientSecret.length === 0 || tagPrefix.length === 0) return null;
  return { clientId, clientSecret, tagPrefix };
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = body.trim().slice(0, 500);
  return detail.length > 0 ? `${response.status} ${detail}` : `${response.status}`;
}

export function createTailnetMinter(
  credentials: TailnetCredentials,
  fetchImpl: typeof fetch = fetch,
): TailnetMinter {
  function tagFor(machineName: string): string {
    return `tag:${credentials.tagPrefix}-${machineName}`;
  }

  async function accessToken(signal: AbortSignal): Promise<string> {
    const response = await fetchImpl(`${TAILSCALE_API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "client_credentials",
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Tailscale rejected the minter credentials: ${await readError(response)}`);
    }
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new Error("Tailscale returned no access token for the minter credentials.");
    }
    return body.access_token;
  }

  return {
    tagFor,
    async mintAuthKey(machineName, signal) {
      const tag = tagFor(machineName);
      const token = await accessToken(signal);
      // `-` is the tailnet the credential belongs to.
      const response = await fetchImpl(`${TAILSCALE_API}/tailnet/-/keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          description: `bb machine ${machineName}`,
          expirySeconds: KEY_LIFETIME_SECONDS,
          capabilities: {
            devices: {
              create: {
                reusable: false,
                // The node goes away with the pod, so a suspended or deleted
                // machine leaves nothing behind in the tailnet.
                ephemeral: true,
                preauthorized: true,
                tags: [tag],
              },
            },
          },
        }),
        signal,
      });
      if (!response.ok) {
        // 403 here is the ordinary "not admitted anywhere yet" case: the tag
        // does not exist until the tailnet policy names it, and an undefined
        // tag cannot be applied.
        throw new Error(`Tailscale refused an auth key for ${tag}: ${await readError(response)}`);
      }
      const body = (await response.json()) as { key?: unknown };
      if (typeof body.key !== "string" || body.key.length === 0) {
        throw new Error(`Tailscale returned no key for ${tag}.`);
      }
      return body.key;
    },
  };
}
