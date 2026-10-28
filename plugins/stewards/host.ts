// The host entry: the part of stewards that runs on the developer's machine,
// where kubectl and its kubeconfig are. It runs only what kubectlRefusal
// allows (get, describe, logs, auth can-i), whatever the server sends, and it
// reads a project checkout's `.bb` from `origin/<default>` for the native
// project source (project-git.ts).
import { execFile } from "node:child_process";
import { experimental_defineHostEntry, experimental_sanitizeInheritedChildProcessEnv } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";
import { kubectlRefusal } from "./kubectl.js";
import { readProjectGit } from "./project-git.js";

/** A namespace's pods as JSON can be large; past this, kubectl's output is cut and fails to parse rather than flooding the call. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function runKubectlHere(args: string[], timeoutMs: number, command = "kubectl"): Promise<{ exitCode: number; stdout: string; stderr: string; missing: boolean }> {
  const refused = kubectlRefusal(args);
  if (refused !== null) return Promise.resolve({ exitCode: 126, stdout: "", stderr: refused, missing: false });
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: { ...experimental_sanitizeInheritedChildProcessEnv({ env: process.env }), NO_COLOR: "1" }, windowsHide: true },
      (error, stdout, stderr) => {
        const e = error as (Omit<NodeJS.ErrnoException, "code"> & { code?: string | number; killed?: boolean }) | null;
        if (e?.code === "ENOENT") return resolve({ exitCode: 127, stdout: "", stderr: `${command}: not found`, missing: true });
        const exitCode = e === null ? 0 : typeof e.code === "number" ? e.code : 1;
        resolve({ exitCode, stdout: String(stdout), stderr: e !== null && e.killed ? `kubectl did not finish in ${timeoutMs / 1000}s` : String(stderr), missing: false });
      },
    );
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    opsKubectl: ({ args, timeoutMs }) => runKubectlHere(args, timeoutMs),
    gitProjectFiles: ({ path, files, fetch }) => readProjectGit({ path, files, fetch }),
  },
});
