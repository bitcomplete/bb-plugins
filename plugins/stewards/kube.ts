// The ops kind's eyes: read-only calls to the Kubernetes API from the
// bb-server pod, with the ServiceAccount bb-gate mounts into the backend of
// the developer who runs the project's ops steward. Steward threads run on a
// machine with no cluster access, so the plugin looks and the wake carries
// what it saw.
//
// Only GETs, plus SelfSubjectAccessReviews for `bb stewards check`, which
// ask the API server what the account may do and change nothing. RBAC is
// the wall (DESIGN.md §11); this file never builds a write.
import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { deploymentsOf, eventsOf, findingsOf, logTail, otherWarnings, podsOf, type OpsTarget, type RawLook } from "./ops.js";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const IN_CLUSTER_API = "https://kubernetes.default.svc";
const TIMEOUT_MS = 15_000;
/** Logs are read for at most this many findings per look. */
const LOGS_PER_LOOK = 5;

/** What `bb stewards check` reports for one target. */
export type OpsAccess = {
  /** Set when nothing could be asked: no credentials, or the API server unreachable. */
  error: string | null;
  /** Each read a look makes, and whether it works. */
  reads: Array<{ what: string; ok: boolean; detail: string | null }>;
  /** Whether container logs may be read; null when the server could not say. */
  logs: boolean | null;
  /** Writes the account holds there, which it should not. */
  mutating: string[];
};

export interface OpsReader {
  /** One look at a target. Throws when its pods cannot be listed: then there is nothing to look at. */
  look(target: OpsTarget, at: { now: number; since: number }): Promise<RawLook>;
  access(target: OpsTarget): Promise<OpsAccess>;
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KubeError";
  }
}

/** The pod's mounted ServiceAccount, read on every call: projected tokens rotate. */
function credentials(dir: string): { token: string; ca: string } {
  try {
    return { token: readFileSync(join(dir, "token"), "utf8").trim(), ca: readFileSync(join(dir, "ca.crt"), "utf8") };
  } catch {
    throw new KubeError(0, `this server has no cluster access: no ServiceAccount token at ${dir} (bb-gate mounts one only into the backend of the developer who runs the project's ops steward)`);
  }
}

export function createKubeReader(opts: { dir?: string; apiUrl?: string } = {}): OpsReader {
  const dir = opts.dir ?? SERVICE_ACCOUNT_DIR;
  const api = new URL(opts.apiUrl ?? IN_CLUSTER_API);

  function call(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
    const { token, ca } = credentials(dir);
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          protocol: api.protocol,
          hostname: api.hostname,
          port: api.port === "" ? 443 : Number(api.port),
          path,
          method,
          ca,
          timeout: TIMEOUT_MS,
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(text);
            let message = text.slice(0, 300);
            try {
              message = String((JSON.parse(text) as { message?: unknown }).message ?? message);
            } catch {
              // not JSON: keep the text
            }
            reject(new KubeError(status, `${status}: ${message}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new KubeError(0, `the API server did not answer in ${TIMEOUT_MS / 1000}s`)));
      req.on("error", (error) => reject(error instanceof KubeError ? error : new KubeError(0, error.message)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const get = async (path: string): Promise<unknown> => JSON.parse(await call("GET", path)) as unknown;
  const ns = (t: OpsTarget) => encodeURIComponent(t.name);
  const forbidden = (e: unknown) => e instanceof KubeError && (e.status === 401 || e.status === 403);

  async function can(namespace: string, verb: string, resource: string, extra: { group?: string; subresource?: string } = {}): Promise<boolean> {
    const out = JSON.parse(
      await call("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", {
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: { resourceAttributes: { namespace, verb, resource, ...extra } },
      }),
    ) as { status?: { allowed?: boolean } };
    return out.status?.allowed === true;
  }

  return {
    async look(target, at) {
      const base = `/api/v1/namespaces/${ns(target)}`;
      const pods = podsOf(await get(`${base}/pods`));
      const notes: string[] = [];
      const optional = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
        try {
          return await read();
        } catch (error) {
          notes.push(`${what} could not be read (${error instanceof Error ? error.message : String(error)})`);
          return empty;
        }
      };
      const events = await optional("Events", async () => eventsOf(await get(`${base}/events?limit=500`)), []);
      const deployments = await optional("Deployments", async () => deploymentsOf(await get(`/apis/apps/v1/namespaces/${ns(target)}/deployments`)), []);
      const sightings = findingsOf(target, pods, events, at);
      let logs: RawLook["logs"] = "unneeded";
      for (const s of sightings.filter((x) => x.container !== null).slice(0, LOGS_PER_LOOK)) {
        const container = s.container!.replace(/^init:/u, "");
        const path = (previous: boolean) => `${base}/pods/${encodeURIComponent(s.pods[0]!)}/log?container=${encodeURIComponent(container)}&tailLines=60${previous ? "&previous=true" : ""}`;
        try {
          let text: string;
          try {
            text = await call("GET", path(s.previous));
          } catch (error) {
            // No previous run to read (it was never restarted, or was replaced): read the current one.
            if (!s.previous || forbidden(error)) throw error;
            s.previous = false;
            text = await call("GET", path(false));
          }
          s.logs = logTail(text);
          logs = "read";
        } catch (error) {
          if (forbidden(error)) {
            logs = "not granted";
            break;
          }
          notes.push(`The logs of ${s.pods[0]}/${container} could not be read (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const healthy = pods.filter((p) => p.phase === "Succeeded" || (p.phase === "Running" && p.ready)).length;
      return { pods: pods.length, healthy, deployments, warnings: otherWarnings(events, sightings, at.since), logs, notes, sightings };
    },

    async access(target) {
      const reads: OpsAccess["reads"] = [];
      const base = `/api/v1/namespaces/${ns(target)}`;
      for (const [what, path] of [
        ["list pods", `${base}/pods?limit=1`],
        ["list events", `${base}/events?limit=1`],
        ["list deployments", `/apis/apps/v1/namespaces/${ns(target)}/deployments?limit=1`],
      ] as const) {
        try {
          await call("GET", path);
          reads.push({ what, ok: true, detail: null });
        } catch (error) {
          if (error instanceof KubeError && error.status === 0) return { error: error.message, reads: [], logs: null, mutating: [] };
          reads.push({ what, ok: false, detail: error instanceof Error ? error.message : String(error) });
        }
      }
      let logs: boolean | null = null;
      const mutating: string[] = [];
      try {
        logs = await can(target.name, "get", "pods", { subresource: "log" });
        const writes = [
          ["delete", "pods", ""],
          ["create", "pods", ""],
          ["patch", "deployments", "apps"],
          ["update", "deployments", "apps"],
          ["delete", "deployments", "apps"],
        ] as const;
        for (const [verb, resource, group] of writes) {
          if (await can(target.name, verb, resource, group === "" ? {} : { group })) mutating.push(`${verb} ${resource}`);
        }
      } catch {
        // The server would not answer access reviews; the reads above still say what works.
      }
      return { error: null, reads, logs, mutating };
    },
  };
}
