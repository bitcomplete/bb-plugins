// What stewards' server asks of its host entry (host.ts), on the developer's
// machine. One method: run kubectl, for the ops kind, with arguments that
// pass kubectlRefusal on both sides.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  opsKubectl: {
    input: z.object({ args: z.array(z.string().min(1).max(300)).min(1).max(30), timeoutMs: z.number().int().min(1000).max(120_000) }).strict(),
    output: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), missing: z.boolean() }).strict(),
  },
});
