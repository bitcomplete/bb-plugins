import WebSocket from "ws";
import type { KubeCredentials } from "./client.js";

// Kubernetes `pods/exec` speaks a WebSocket subprotocol where every binary
// frame starts with a channel byte: 0 stdin, 1 stdout, 2 stderr, 3 error
// status. v5 adds a close channel (255) that lets the client half-close
// stdin, which the bb bootstrap needs because it feeds the enrollment bundle
// over stdin and waits for EOF. v5 needs Kubernetes 1.30 or newer; on v4 we
// still run the command but cannot signal EOF, so bootstrap will hang until
// its timeout. The negotiated protocol is reported to the caller's log.
const PROTOCOLS = ["v5.channel.k8s.io", "v4.channel.k8s.io"];
const CHANNEL_STDIN = 0;
const CHANNEL_STDOUT = 1;
const CHANNEL_STDERR = 2;
const CHANNEL_ERROR = 3;
const CHANNEL_CLOSE = 255;

export interface ExecRequest {
  credentials: KubeCredentials;
  podName: string;
  container: string;
  command: string[];
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput: (chunk: string) => void;
}

interface ExecStatus {
  status?: string;
  message?: string;
  details?: { causes?: Array<{ reason?: string; message?: string }> };
}

export function exitCodeFromStatus(status: ExecStatus): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  const parsed = cause?.message === undefined ? NaN : Number(cause.message);
  if (Number.isInteger(parsed)) return parsed;
  // A failure with no exit code is a transport or container problem.
  throw new Error(status.message ?? "exec failed without an exit code");
}

export function execUrl(
  credentials: KubeCredentials,
  podName: string,
  container: string,
  command: string[],
  stdin: boolean,
): string {
  const url = new URL(credentials.apiUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/api/v1/namespaces/${encodeURIComponent(credentials.namespace)}/pods/${encodeURIComponent(podName)}/exec`;
  const params = url.searchParams;
  params.set("container", container);
  params.set("stdin", stdin ? "true" : "false");
  params.set("stdout", "true");
  params.set("stderr", "true");
  params.set("tty", "false");
  for (const arg of command) params.append("command", arg);
  return url.toString();
}

export function execInPod(request: ExecRequest): Promise<{ exitCode: number }> {
  request.signal.throwIfAborted();
  const wantStdin = request.stdin.length > 0;
  const url = execUrl(
    request.credentials,
    request.podName,
    request.container,
    request.command,
    wantStdin,
  );
  return new Promise<{ exitCode: number }>((resolve, reject) => {
    const socket = new WebSocket(url, PROTOCOLS, {
      ca: request.credentials.ca,
      headers: { authorization: `Bearer ${request.credentials.token}` },
      perMessageDeflate: false,
    });
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    let settled = false;
    let status: ExecStatus | null = null;
    let errorText = "";

    const finish = (outcome: { exitCode: number } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      if (outcome instanceof Error) {
        // Core redacts transport failures to "Machine bootstrap command
        // failed"; put the real reason in the machine log first.
        request.onOutput(`[kubernetes-provider] exec failed: ${outcome.message}\n`);
        reject(outcome);
      } else resolve(outcome);
    };
    const onAbort = () => finish(request.signal.reason instanceof Error ? request.signal.reason : new Error("exec aborted"));
    const timer = setTimeout(
      () => finish(new Error(`exec timed out after ${request.timeoutMs} ms`)),
      request.timeoutMs,
    );
    request.signal.addEventListener("abort", onAbort, { once: true });

    socket.on("open", () => {
      if (!wantStdin) return;
      const data = Buffer.from(request.stdin, "utf8");
      socket.send(Buffer.concat([Buffer.from([CHANNEL_STDIN]), data]), { binary: true });
      if (socket.protocol === "v5.channel.k8s.io") {
        socket.send(Buffer.from([CHANNEL_CLOSE, CHANNEL_STDIN]), { binary: true });
      } else {
        request.onOutput(
          "[kubernetes-provider] exec negotiated v4.channel.k8s.io: stdin cannot be closed (needs Kubernetes >= 1.30)\n",
        );
      }
    });
    socket.on("message", (raw, isBinary) => {
      const frame = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw as ArrayBuffer);
      if (frame.length === 0) return;
      const channel = frame[0];
      const payload = frame.subarray(1);
      if (channel === CHANNEL_STDOUT) {
        const text = stdoutDecoder.decode(payload, { stream: true });
        if (text.length > 0) request.onOutput(text);
      } else if (channel === CHANNEL_STDERR) {
        const text = stderrDecoder.decode(payload, { stream: true });
        if (text.length > 0) request.onOutput(text);
      } else if (channel === CHANNEL_ERROR) {
        errorText += payload.toString("utf8");
        try {
          status = JSON.parse(errorText) as ExecStatus;
        } catch {
          // Partial JSON; wait for more.
        }
      }
      void isBinary;
    });
    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", (code, reasonBuffer) => {
      const tail = stdoutDecoder.decode() + stderrDecoder.decode();
      if (tail.length > 0) request.onOutput(tail);
      if (status !== null) {
        try {
          finish({ exitCode: exitCodeFromStatus(status) });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const reason = reasonBuffer.toString("utf8");
      finish(
        new Error(
          `exec connection closed without a status (code ${code}${reason ? `: ${reason}` : ""})`,
        ),
      );
    });
  });
}
