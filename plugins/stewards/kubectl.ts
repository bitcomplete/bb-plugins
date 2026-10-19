// The ops kind's eyes: kubectl, run on the developer's own machine, where it
// reaches the cluster through their kubeconfig (on bc-prod, the Tailscale API
// proxy) as them. Steward threads run there too; the plugin's server does
// not, so it asks the machine to run kubectl (host.ts) and the wake carries
// what came back.
//
// Every kubectl call, the plugin's and the host's, passes kubectlRefusal:
// only get, describe, logs and auth can-i. The developer's own rights are
// broad, so this and the playbook's `may` list are what keep the ops steward
// read-only (DESIGN.md §11, §18). A real wall, such as a read-only identity,
// would slot in behind the same function.
import { deploymentsOf, eventsOf, findingsOf, logTail, otherWarnings, podsOf, type OpsTarget, type RawLook } from "./ops.js";

/** What the ops kind may ask kubectl to do. Nothing else is run. */
export const KUBECTL_VERBS = ["get", "describe", "logs", "auth can-i"] as const;

/**
 * Flags that would point kubectl at other credentials or another identity,
 * or (`--raw`) turn a get into an arbitrary API path, such as a secrets dump.
 */
const REFUSED_FLAGS = /^--(?:kubeconfig|token|server|as|as-group|as-uid|username|password|client-certificate|client-key|insecure-skip-tls-verify|raw)(?:=|$)/u;

/** Why kubectl may not run these arguments, or null when it may. */
export function kubectlRefusal(args: readonly string[]): string | null {
  const verb = args[0] === "auth" ? `auth ${args[1] ?? ""}`.trim() : (args[0] ?? "");
  if (!(KUBECTL_VERBS as readonly string[]).includes(verb)) return `kubectl ${verb || "(nothing)"} is not allowed: the ops kind runs only ${KUBECTL_VERBS.join(", ")}`;
  const flag = args.find((a) => REFUSED_FLAGS.test(a));
  if (flag !== undefined) {
    const name = flag.split("=")[0]!;
    return name === "--raw" ? "kubectl --raw is not allowed: the ops kind reads resources by name, not arbitrary API paths" : `kubectl ${name} is not allowed: the ops kind uses the machine's own kubeconfig as it is`;
  }
  return null;
}

/** One kubectl run. `missing` when there is no kubectl to run. */
export type KubectlResult = { exitCode: number; stdout: string; stderr: string; missing?: boolean };
export type Kubectl = (args: string[]) => Promise<KubectlResult>;

/** What `bb stewards check` reports for one target. */
export type OpsAccess = {
  /** Set when nothing could be asked: no kubectl, no machine, or the cluster unreachable. */
  error: string | null;
  /** Each read a look makes, and whether it works. */
  reads: Array<{ what: string; ok: boolean; detail: string | null }>;
  /** Whether container logs may be read; null when kubectl could not say. */
  logs: boolean | null;
  /** Writes the identity holds there. Expected of a developer: the gate and the playbook, not the cluster, keep the steward from them. */
  writes: string[];
};

export interface OpsReader {
  /** One look at a target. Throws when its pods cannot be listed: then there is nothing to look at. */
  look(target: OpsTarget, at: { now: number; since: number }): Promise<RawLook>;
  access(target: OpsTarget): Promise<OpsAccess>;
}

const REQUEST_TIMEOUT = "--request-timeout=20s";
/** Logs are read for at most this many findings per look. */
const LOGS_PER_LOOK = 5;

/** The first useful line of kubectl's complaint. */
export function kubectlError(r: KubectlResult): string {
  if (r.missing === true) return "kubectl is not installed on this machine, or not on its PATH";
  const line = r.stderr.split(/\r?\n/u).map((l) => l.trim()).find((l) => l !== "") ?? `kubectl exited ${r.exitCode}`;
  return line.replace(/^error:\s*/iu, "").slice(0, 300);
}

const forbidden = (r: KubectlResult) => /\bforbidden\b/iu.test(r.stderr);
/** Nothing answered: kubectl is missing, or the cluster is unreachable from this machine. */
const unreachable = (r: KubectlResult) => r.missing === true || /unable to connect|connection refused|no such host|i\/o timeout|deadline exceeded|context deadline|couldn't get current server|no configuration has been provided|current-context is not set|context .* does not exist|tls|x509|unauthorized/iu.test(r.stderr);

/** A reader of one project's targets, through one kubectl that already passed the gate. `context` picks a kubeconfig context. */
export function createKubectlReader(kubectl: Kubectl, opts: { context?: string } = {}): OpsReader {
  const run = (args: string[]) => kubectl([...args, REQUEST_TIMEOUT, ...(opts.context === undefined ? [] : [`--context=${opts.context}`])]);
  const getJson = async (resource: string, ns: string): Promise<unknown> => {
    const r = await run(["get", resource, "-n", ns, "-o", "json"]);
    if (r.exitCode !== 0) throw new Error(kubectlError(r));
    return JSON.parse(r.stdout) as unknown;
  };

  return {
    async look(target, at) {
      const ns = target.name;
      const pods = podsOf(await getJson("pods", ns));
      const notes: string[] = [];
      const optional = async <T>(what: string, read: () => Promise<T>, empty: T): Promise<T> => {
        try {
          return await read();
        } catch (error) {
          notes.push(`${what} could not be read (${error instanceof Error ? error.message : String(error)})`);
          return empty;
        }
      };
      const events = await optional("Events", async () => eventsOf(await getJson("events", ns)), []);
      const deployments = await optional("Deployments", async () => deploymentsOf(await getJson("deployments", ns)), []);
      const sightings = findingsOf(target, pods, events, at);
      let logs: RawLook["logs"] = "unneeded";
      for (const s of sightings.filter((x) => x.container !== null).slice(0, LOGS_PER_LOOK)) {
        const container = s.container!.replace(/^init:/u, "");
        const args = (previous: boolean) => ["logs", s.pods[0]!, "-n", ns, "-c", container, "--tail=60", ...(previous ? ["--previous"] : [])];
        let r = await run(args(s.previous));
        // No previous run to read (never restarted, or replaced): read the current one.
        if (r.exitCode !== 0 && s.previous && !forbidden(r)) {
          s.previous = false;
          r = await run(args(false));
        }
        if (r.exitCode === 0) {
          s.logs = logTail(r.stdout);
          logs = "read";
        } else if (forbidden(r)) {
          logs = "not granted";
          break;
        } else notes.push(`The logs of ${s.pods[0]}/${container} could not be read (${kubectlError(r)})`);
      }
      const healthy = pods.filter((p) => p.phase === "Succeeded" || (p.phase === "Running" && p.ready)).length;
      return { pods: pods.length, healthy, deployments, warnings: otherWarnings(events, sightings, at.since), logs, notes, sightings };
    },

    async access(target) {
      const ns = target.name;
      const reads: OpsAccess["reads"] = [];
      for (const resource of ["pods", "events", "deployments"]) {
        const r = await run(["get", resource, "-n", ns, "-o", "name"]);
        if (r.exitCode !== 0 && unreachable(r)) return { error: kubectlError(r), reads: [], logs: null, writes: [] };
        reads.push({ what: `get ${resource}`, ok: r.exitCode === 0, detail: r.exitCode === 0 ? null : kubectlError(r) });
      }
      // `auth can-i` answers yes (exit 0) or no (exit 1); anything else is kubectl failing to ask.
      const can = async (what: string): Promise<boolean | null> => {
        const r = await run(["auth", "can-i", ...what.split(" "), "-n", ns]);
        const answer = r.stdout.trim().toLowerCase();
        return answer.startsWith("yes") ? true : answer.startsWith("no") ? false : null;
      };
      const logs = await can("get pods/log");
      const writes: string[] = [];
      for (const what of ["delete pods", "create pods/exec", "patch deployments"]) if ((await can(what)) === true) writes.push(what);
      return { error: null, reads, logs, writes };
    },
  };
}
