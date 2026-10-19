import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { crashingPod } from "./fixtures.js";
import { runKubectlHere } from "./host.js";
import { createKubectlReader, kubectlError, kubectlRefusal, type KubectlResult } from "./kubectl.js";

const target = { kind: "k8s-namespace", name: "devbox-production" } as const;
const now = Date.parse("2026-10-14T15:00:00Z");

describe("the kubectl gate", () => {
  it("lets through only get, describe, logs and auth can-i", () => {
    for (const ok of [["get", "pods", "-n", "x", "-o", "json"], ["describe", "pod", "p"], ["logs", "p", "-c", "c", "--previous"], ["auth", "can-i", "get", "pods/log", "-n", "x"]]) expect(kubectlRefusal(ok), ok.join(" ")).toBeNull();
    for (const bad of [["delete", "pod", "p"], ["exec", "p", "--", "sh"], ["apply", "-f", "x.yaml"], ["rollout", "restart", "deploy/x"], ["scale", "deploy/x", "--replicas=0"], ["auth", "reconcile"], ["edit", "deploy/x"], [], ["patch", "deploy/x"], ["create", "job", "x"], ["replace", "-f", "x"], ["label", "pod/p", "a=b"], ["annotate", "pod/p", "a=b"], ["cordon", "node"], ["drain", "node"], ["cp", "p:/etc/x", "x"], ["port-forward", "p", "8080"], ["attach", "p"], ["debug", "p"], ["proxy"], ["set", "image", "deploy/x", "a=b"], ["GET", "pods"], ["--namespace=x", "get", "pods"]]) {
      expect(kubectlRefusal(bad), bad.join(" ")).toMatch(/is not allowed: the ops kind runs only get, describe, logs, auth can-i/u);
    }
  });

  it("refuses other credentials or another identity", () => {
    for (const flag of ["--kubeconfig=/tmp/admin", "--token=abc", "--as=system:admin", "--server", "--as-group=system:masters"]) {
      expect(kubectlRefusal(["get", "pods", flag]), flag).toMatch(/is not allowed: the ops kind uses the machine's own kubeconfig/u);
    }
    expect(kubectlRefusal(["get", "pods", "--context=bc-prod", "--request-timeout=20s"])).toBeNull();
  });
});

describe("the kubectl reader", () => {
  const fake = (answer: (args: string[]) => KubectlResult) => {
    const calls: string[][] = [];
    return { calls, run: async (args: string[]) => (calls.push(args), answer(args)) };
  };
  const ok = (stdout: string): KubectlResult => ({ exitCode: 0, stdout, stderr: "" });

  it("reads a crashed run's logs, falling back to the current run when there is no previous one", async () => {
    const k = fake((a) => (a[0] === "get" ? ok(JSON.stringify({ items: a[1] === "pods" ? [crashingPod()] : [] })) : a.includes("--previous") ? { exitCode: 1, stdout: "", stderr: 'previous terminated container "router" in pod "x" not found' } : ok("boom\n")));
    const look = await createKubectlReader(k.run, { context: "bc-prod" }).look(target, { now, since: now - 3_600_000 });
    expect(look).toMatchObject({ pods: 1, healthy: 0, logs: "read", sightings: [{ logs: ["boom"], previous: false }] });
    expect(k.calls[0]).toEqual(["get", "pods", "-n", "devbox-production", "-o", "json", "--request-timeout=20s", "--context=bc-prod"]);
    expect(k.calls.every((a) => kubectlRefusal(a) === null)).toBe(true);
  });

  it("says logs are not granted when kubectl is forbidden them, and fails a look it cannot list pods for", async () => {
    const k = fake((a) => (a[0] === "get" ? ok(JSON.stringify({ items: a[1] === "pods" ? [crashingPod()] : [] })) : { exitCode: 1, stdout: "", stderr: 'Error from server (Forbidden): pods "x" is forbidden' }));
    expect(await createKubectlReader(k.run).look(target, { now, since: 0 })).toMatchObject({ logs: "not granted", sightings: [{ logs: null }] });
    const down = fake(() => ({ exitCode: 1, stdout: "", stderr: "error: Unable to connect to the server: dial tcp: i/o timeout\n" }));
    await expect(createKubectlReader(down.run).look(target, { now, since: 0 })).rejects.toThrow(/^Unable to connect to the server/u);
  });

  it("reports an unreachable target, or one with no kubectl, as an error for check", async () => {
    const missing = fake(() => ({ exitCode: 127, stdout: "", stderr: "kubectl: not found", missing: true }));
    expect(await createKubectlReader(missing.run).access(target)).toMatchObject({ error: "kubectl is not installed on this machine, or not on its PATH" });
    const noContext = fake(() => ({ exitCode: 1, stdout: "", stderr: 'error: context "bc-prod" does not exist' }));
    expect((await createKubectlReader(noContext.run).access(target)).error).toBe('context "bc-prod" does not exist');
    const fine = fake((a) => (a[0] === "auth" ? (a[3] === "pods/log" ? ok("yes\n") : { exitCode: 1, stdout: "no\n", stderr: "" }) : ok("pod/a\n")));
    expect(await createKubectlReader(fine.run).access(target)).toEqual({ error: null, reads: ["pods", "events", "deployments"].map((r) => ({ what: `get ${r}`, ok: true, detail: null })), logs: true, writes: [] });
    expect(kubectlError({ exitCode: 2, stdout: "", stderr: "" })).toBe("kubectl exited 2");
  });
});

describe("the host's kubectl", () => {
  const dir = mkdtempSync(join(tmpdir(), "stewards-kubectl-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "ran");
  const script = join(dir, "kubectl");
  writeFileSync(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nif [ "$1" = "auth" ]; then echo no; exit 1; fi\necho "args: $*"\necho "warn" >&2\n`);
  chmodSync(script, 0o755);

  it("runs allowed arguments and reports the exit code and output", async () => {
    expect(await runKubectlHere(["get", "pods", "-n", "x"], 5000, script)).toEqual({ exitCode: 0, stdout: "args: get pods -n x\n", stderr: "warn\n", missing: false });
    expect(await runKubectlHere(["auth", "can-i", "delete", "pods"], 5000, script)).toMatchObject({ exitCode: 1, stdout: "no\n" });
  });

  it("never starts kubectl for refused arguments, and says when there is no kubectl", async () => {
    rmSync(marker, { force: true });
    expect(await runKubectlHere(["delete", "pod", "p"], 5000, script)).toMatchObject({ exitCode: 126, stderr: expect.stringMatching(/kubectl delete is not allowed/u) });
    expect(existsSync(marker)).toBe(false);
    expect(await runKubectlHere(["get", "pods"], 5000, join(dir, "nope"))).toMatchObject({ exitCode: 127, missing: true });
  });
});
