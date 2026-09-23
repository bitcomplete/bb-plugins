import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { execInPod } from "./exec.js";
import type { MachineExecutor } from "@get-bb/plugin-sdk";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const IN_CLUSTER_API = "https://kubernetes.default.svc";

export interface KubeCredentials {
  apiUrl: string;
  namespace: string;
  token: string;
  ca: string;
}

// The pod's mounted ServiceAccount. Read lazily so a server started outside
// a cluster loads the plugin and reports "setup required" instead of failing.
export function readInClusterCredentials(
  dir: string = SERVICE_ACCOUNT_DIR,
  apiUrl: string = IN_CLUSTER_API,
): KubeCredentials {
  return {
    apiUrl,
    namespace: readFileSync(join(dir, "namespace"), "utf8").trim(),
    token: readFileSync(join(dir, "token"), "utf8").trim(),
    ca: readFileSync(join(dir, "ca.crt"), "utf8"),
  };
}

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "KubeApiError";
  }
}

export interface PodSummary {
  name: string;
  phase: string;
  ready: boolean;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  deletionTimestamp: string | null;
  containerWaitingReason: string | null;
  // Name of a container that has terminated, if any. Machine pods run with
  // restartPolicy Never, so an exited container never comes back and the pod
  // can never be ready again, even while its phase still reads Running.
  exitedContainer: string | null;
}

export interface PvcSummary {
  name: string;
  phase: string;
  labels: Record<string, string>;
  deletionTimestamp: string | null;
}

export interface KubeClient {
  namespace: string;
  createPod(manifest: unknown, signal: AbortSignal): Promise<PodSummary>;
  getPod(name: string, signal: AbortSignal): Promise<PodSummary | null>;
  listPods(labelSelector: string, signal: AbortSignal): Promise<PodSummary[]>;
  deletePod(name: string, signal: AbortSignal): Promise<void>;
  createPvc(manifest: unknown, signal: AbortSignal): Promise<PvcSummary>;
  getPvc(name: string, signal: AbortSignal): Promise<PvcSummary | null>;
  deletePvc(name: string, signal: AbortSignal): Promise<void>;
  patchPodMetadata(
    name: string,
    patch: { labels?: Record<string, string>; annotations?: Record<string, string> },
    signal: AbortSignal,
  ): Promise<void>;
  executor(podName: string, container: string): MachineExecutor;
  ping(signal: AbortSignal): Promise<void>;
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  contentType?: string;
  signal: AbortSignal;
}

function summarizePod(pod: Record<string, unknown>): PodSummary {
  const metadata = (pod.metadata ?? {}) as Record<string, unknown>;
  const status = (pod.status ?? {}) as Record<string, unknown>;
  const containerStatuses = (status.containerStatuses ?? []) as Array<
    Record<string, unknown>
  >;
  const ready =
    containerStatuses.length > 0 &&
    containerStatuses.every((c) => c.ready === true);
  let waiting: string | null = null;
  let exited: string | null = null;
  for (const c of containerStatuses) {
    const state = (c.state ?? {}) as Record<string, unknown>;
    const w = state.waiting as Record<string, unknown> | undefined;
    if (w && typeof w.reason === "string") waiting = w.reason;
    if (state.terminated !== undefined && exited === null) exited = String(c.name ?? "");
  }
  return {
    name: String(metadata.name ?? ""),
    phase: String(status.phase ?? "Unknown"),
    ready,
    labels: (metadata.labels ?? {}) as Record<string, string>,
    annotations: (metadata.annotations ?? {}) as Record<string, string>,
    deletionTimestamp:
      typeof metadata.deletionTimestamp === "string" ? metadata.deletionTimestamp : null,
    containerWaitingReason: waiting,
    exitedContainer: exited,
  };
}

function summarizePvc(pvc: Record<string, unknown>): PvcSummary {
  const metadata = (pvc.metadata ?? {}) as Record<string, unknown>;
  const status = (pvc.status ?? {}) as Record<string, unknown>;
  return {
    name: String(metadata.name ?? ""),
    phase: String(status.phase ?? "Unknown"),
    labels: (metadata.labels ?? {}) as Record<string, string>,
    deletionTimestamp:
      typeof metadata.deletionTimestamp === "string" ? metadata.deletionTimestamp : null,
  };
}

export function createKubeClient(credentials: KubeCredentials): KubeClient {
  const base = new URL(credentials.apiUrl);
  const agent = new https.Agent({ ca: credentials.ca, keepAlive: true });
  const nsPath = `/api/v1/namespaces/${encodeURIComponent(credentials.namespace)}`;
  const podsPath = `${nsPath}/pods`;
  const pvcsPath = `${nsPath}/persistentvolumeclaims`;

  function request<T>(options: RequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      options.signal.throwIfAborted();
      const payload = options.body === undefined ? null : JSON.stringify(options.body);
      const req = https.request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port,
          path: options.path,
          method: options.method,
          agent,
          signal: options.signal,
          headers: {
            authorization: `Bearer ${credentials.token}`,
            accept: "application/json",
            ...(payload === null
              ? {}
              : {
                  "content-type": options.contentType ?? "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            let parsed: unknown = null;
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = null;
              }
            }
            if (status >= 200 && status < 300) {
              resolve(parsed as T);
              return;
            }
            const body = (parsed ?? {}) as Record<string, unknown>;
            reject(
              new KubeApiError(
                status,
                typeof body.reason === "string" ? body.reason : "Unknown",
                typeof body.message === "string"
                  ? body.message
                  : `Kubernetes API ${options.method} ${options.path} failed with ${status}`,
              ),
            );
          });
        },
      );
      req.on("error", reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  return {
    namespace: credentials.namespace,
    async createPod(manifest, signal) {
      const pod = await request<Record<string, unknown>>({
        method: "POST",
        path: podsPath,
        body: manifest,
        signal,
      });
      return summarizePod(pod);
    },
    async getPod(name, signal) {
      try {
        const pod = await request<Record<string, unknown>>({
          method: "GET",
          path: `${podsPath}/${encodeURIComponent(name)}`,
          signal,
        });
        return summarizePod(pod);
      } catch (error) {
        if (error instanceof KubeApiError && error.status === 404) return null;
        throw error;
      }
    },
    async listPods(labelSelector, signal) {
      const list = await request<{ items?: Array<Record<string, unknown>> }>({
        method: "GET",
        path: `${podsPath}?labelSelector=${encodeURIComponent(labelSelector)}`,
        signal,
      });
      return (list.items ?? []).map(summarizePod);
    },
    async deletePod(name, signal) {
      try {
        await request({
          method: "DELETE",
          path: `${podsPath}/${encodeURIComponent(name)}`,
          body: { propagationPolicy: "Background" },
          signal,
        });
      } catch (error) {
        if (error instanceof KubeApiError && error.status === 404) return;
        throw error;
      }
    },
    async createPvc(manifest, signal) {
      const pvc = await request<Record<string, unknown>>({
        method: "POST",
        path: pvcsPath,
        body: manifest,
        signal,
      });
      return summarizePvc(pvc);
    },
    async getPvc(name, signal) {
      try {
        const pvc = await request<Record<string, unknown>>({
          method: "GET",
          path: `${pvcsPath}/${encodeURIComponent(name)}`,
          signal,
        });
        return summarizePvc(pvc);
      } catch (error) {
        if (error instanceof KubeApiError && error.status === 404) return null;
        throw error;
      }
    },
    async deletePvc(name, signal) {
      try {
        await request({
          method: "DELETE",
          path: `${pvcsPath}/${encodeURIComponent(name)}`,
          signal,
        });
      } catch (error) {
        if (error instanceof KubeApiError && error.status === 404) return;
        throw error;
      }
    },
    async patchPodMetadata(name, patch, signal) {
      await request({
        method: "PATCH",
        path: `${podsPath}/${encodeURIComponent(name)}`,
        body: { metadata: patch },
        contentType: "application/merge-patch+json",
        signal,
      });
    },
    executor(podName, container) {
      return {
        exec: (req) =>
          execInPod({
            credentials,
            podName,
            container,
            ...req,
          }),
      };
    },
    async ping(signal) {
      await request({ method: "GET", path: `${podsPath}?limit=1`, signal });
    },
  };
}
