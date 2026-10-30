// What stewards' server asks of its host entry (host.ts), on the developer's
// machine. Two methods: run kubectl for the ops kind, with arguments that
// pass kubectlRefusal on both sides, and read `.bb` from a project checkout's
// `origin/<default>` for the native project source (project-git.ts).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A project-relative `.bb` file path: letters, digits, dot, dash, underscore, slash; no traversal. */
const projectFilePath = z.string().min(1).max(300).regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, "a project file path");

export const hostContract = defineRpcContract({
  opsKubectl: {
    input: z.object({ args: z.array(z.string().min(1).max(300)).min(1).max(30), timeoutMs: z.number().int().min(1000).max(120_000) }).strict(),
    output: z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), missing: z.boolean() }).strict(),
  },
  gitProjectFiles: {
    input: z.object({ path: z.string().min(1).max(2000), files: z.array(projectFilePath).max(64), fetch: z.boolean().default(true) }).strict(),
    output: z
      .object({
        head: z.string().max(64).nullable(),
        files: z.array(z.object({ path: z.string().max(300), content: z.string().nullable() })).max(64),
        remote: z.string().max(2000).nullable(),
        defaultBranch: z.string().max(300).nullable(),
        layout: z.enum(["primary", "standalone"]),
        error: z.string().max(2000).nullable(),
      })
      .strict(),
  },
});
