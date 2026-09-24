import { describe, expect, it } from "vitest";
import { execUrl, exitCodeFromStatus } from "./exec.js";

const credentials = {
  apiUrl: "https://kubernetes.default.svc",
  namespace: "example-production",
  token: "t",
  ca: "",
};

describe("execUrl", () => {
  it("targets the agent container with one command param per argv entry", () => {
    const url = new URL(execUrl(credentials, "bb-thr-1", "agent", ["sh", "-c", "echo hi"], true));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/v1/namespaces/example-production/pods/bb-thr-1/exec");
    expect(url.searchParams.getAll("command")).toEqual(["sh", "-c", "echo hi"]);
    expect(url.searchParams.get("container")).toBe("agent");
    expect(url.searchParams.get("stdin")).toBe("true");
    expect(url.searchParams.get("tty")).toBe("false");
  });
});

describe("exitCodeFromStatus", () => {
  it("maps Success to 0", () => {
    expect(exitCodeFromStatus({ status: "Success" })).toBe(0);
  });
  it("reads the ExitCode cause on failure", () => {
    expect(
      exitCodeFromStatus({
        status: "Failure",
        message: "command terminated with non-zero exit code",
        details: { causes: [{ reason: "ExitCode", message: "7" }] },
      }),
    ).toBe(7);
  });
  it("throws when a failure carries no exit code", () => {
    expect(() => exitCodeFromStatus({ status: "Failure", message: "container not found" })).toThrow(
      "container not found",
    );
  });
});
