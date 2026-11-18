import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { PrivacyPolicy } from "./adapters/privacy.js";

/** Rotate native conversation identities when effective privacy rules change, including after reload. */
export function syncWorkerPrivacy(store: Store, policy: PrivacyPolicy): string {
  const values = [...new Set([...(policy.clientNames ?? []), ...(policy.secrets ?? [])].filter(Boolean).map(value => value.toLowerCase()))].sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, values, maxCharacters: policy.maxCharacters ?? 8000 })).digest("hex");
  return store.transaction(() => {
    const previous = store.get<{ fingerprint: string; generation: string }>("worker-privacy", "current");
    if (previous?.fingerprint === fingerprint) return previous.generation;
    const generation = randomUUID();
    for (const { key, value: record } of store.entries<{ active: boolean }>("workers")) {
      if (record.active) store.put("workers", key, { ...record, active: false });
    }
    store.put("worker-privacy", "current", { fingerprint, generation });
    return generation;
  });
}
