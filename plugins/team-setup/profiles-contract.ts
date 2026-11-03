// The data-profiles RPC contract, shared by team-setup's server entry (which
// implements it) and its app entry (which calls it).
//
// The methods are registered only on a server whose entrypoint set
// BB_GATE_PROFILES_DIR and BB_GATE_ACTIVE_PROFILE_FILE. A server that is not
// behind bb-gate, or is on an image older than the profile layout, has no
// such method and the Advanced section renders nothing.
import { z } from "zod";

export const profileRowSchema = z.object({
  name: z.string(),
  booted: z.boolean(),
  bytes: z.number().int().min(0),
});

// Kept a plain object rather than defineRpcContract so the app entry can
// import it as a type without pulling the server SDK into the browser bundle.
export const profilesRpcContract = {
  "profiles.list": {
    input: z.null(),
    output: z.object({ active: z.string(), profiles: z.array(profileRowSchema) }),
  },
  "profiles.create": {
    input: z.object({ name: z.string() }).strict(),
    output: profileRowSchema,
  },
  "profiles.delete": {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  "profiles.activate": {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ booted: z.boolean() }),
  },
} as const;
