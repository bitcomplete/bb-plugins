import { createHash } from "node:crypto";
import type { Actor, Store } from "./store.js";
import { stableId, stableJson } from "./domain/shared.js";
import { createRevalidationWorkloadSchema, reviseRevalidationWorkloadSchema, revalidationWorkloadDefinitionSchema,
  revalidationWorkloadRefSchema, revalidationIdSchema, revalidationCountSchema,
  type RevalidationWorkload, type RevalidationWorkloadDefinition, type RevalidationWorkloadRef, type RevalidationWorkloadSnapshot } from "./revalidation-contract.js";
import type { z } from "zod";

export const revalidationWorkloadDigest = (definition: RevalidationWorkloadDefinition): string => createHash("sha256").update(stableJson(revalidationWorkloadDefinitionSchema.parse(definition))).digest("hex");
export function validateWorkloadSnapshot(snapshot: RevalidationWorkloadSnapshot): RevalidationWorkloadSnapshot {
  revalidationWorkloadRefSchema.parse({ id: snapshot.id, version: snapshot.version, description: snapshot.definition.description, manifestDigest: snapshot.manifestDigest });
  if (revalidationWorkloadDigest(snapshot.definition) !== snapshot.manifestDigest) throw new Error("revalidation-workload-changed");
  return snapshot;
}
const key = (id: string, version: number) => `${id}:${version}`;
/** Owner/chat define expected test answers, never observed outputs or verdicts. */
export function createRevalidationWorkloads(store: Store, options: { redact: (text: string) => string; now?: () => number }) {
  const now = () => revalidationCountSchema.parse((options.now ?? Date.now)());
  function editor(actor: Actor) {
    if (!["owner", "chat"].includes(actor.kind)) throw new Error("revalidation-workload-editor-required");
    revalidationIdSchema.parse(actor.id);
  }
  function privateText(value: unknown): void {
    if (typeof value === "string" && options.redact(value) !== value) throw new Error("revalidation-workload-private-input");
    if (Array.isArray(value)) value.forEach(privateText);
    else if (value && typeof value === "object") Object.values(value).forEach(privateText);
  }
  function definition(input: RevalidationWorkloadDefinition): RevalidationWorkloadDefinition {
    const value = revalidationWorkloadDefinitionSchema.parse(input); privateText(value); return value;
  }
  function head(id: string): number {
    revalidationIdSchema.parse(id); const value = store.get<{version:number}>("revalidation-workload-heads", id);
    if (!value) throw new Error("revalidation-workload-missing"); return revalidationCountSchema.positive().parse(value.version);
  }
  function get(id: string, version = head(id)): RevalidationWorkload {
    revalidationIdSchema.parse(id); revalidationCountSchema.positive().parse(version);
    const value = store.get<RevalidationWorkload>("revalidation-workloads", key(id, version));
    if (!value || value.id !== id || value.version !== version) throw new Error("revalidation-workload-version-missing");
    validateWorkloadSnapshot(value); return value;
  }
  return {
    create(raw: z.infer<typeof createRevalidationWorkloadSchema>, actor: Actor): RevalidationWorkload {
      editor(actor); const input = createRevalidationWorkloadSchema.parse(raw), def = definition(input.definition), digest = revalidationWorkloadDigest(def);
      return store.transaction(() => {
        const id = stableId("revalidation-workload", input.requestId), prior = store.get<{id:string;digest:string}>("revalidation-workload-requests", input.requestId);
        if (prior) { if (prior.id !== id || prior.digest !== digest) throw new Error("revalidation-workload-request-conflict"); return get(id, 1); }
        const value: RevalidationWorkload = { id, version: 1, previousVersion: null, definition: def, manifestDigest: digest, createdAtMs: now(), actor: {...actor} };
        store.createAudited("revalidation-workloads", key(id, 1), value, actor, "Create immutable test workload version");
        store.createAudited("revalidation-workload-heads", id, {version:1}, actor, "Select initial workload version");
        store.put("revalidation-workload-requests", input.requestId, {id,digest}); return value;
      });
    },
    revise(raw: z.infer<typeof reviseRevalidationWorkloadSchema>, actor: Actor): RevalidationWorkload {
      editor(actor); const input = reviseRevalidationWorkloadSchema.parse(raw), def = definition(input.definition);
      return store.transaction(() => {
        if (head(input.id) !== input.expectedVersion) throw new Error("revalidation-workload-version-conflict");
        const old = get(input.id), value: RevalidationWorkload = {...old,version:old.version+1,previousVersion:old.version,definition:def,manifestDigest:revalidationWorkloadDigest(def),createdAtMs:now(),actor:{...actor}};
        store.createAudited("revalidation-workloads", key(value.id,value.version), value, actor, "Revise tests in a new immutable workload version");
        store.edit("revalidation-workload-heads", value.id, store.version("revalidation-workload-heads",value.id), {version:value.version}, actor, "Select revised workload; prior tests remain available"); return value;
      });
    },
    get,
    list(): RevalidationWorkload[] { return store.entries<{version:number}>("revalidation-workload-heads").map(e=>get(e.key,e.value.version)); },
    history(id: string): RevalidationWorkload[] { const version=head(id); return Array.from({length:version},(_,i)=>get(id,i+1)); },
    resolve(raw: RevalidationWorkloadRef): RevalidationWorkloadSnapshot {
      const ref=revalidationWorkloadRefSchema.parse(raw), value=get(ref.id,ref.version);
      if (value.manifestDigest!==ref.manifestDigest || value.definition.description!==ref.description) throw new Error("revalidation-workload-reference-changed");
      privateText(value.definition);
      return {id:value.id,version:value.version,manifestDigest:value.manifestDigest,definition:value.definition};
    },
  };
}
