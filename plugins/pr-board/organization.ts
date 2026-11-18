import { useSyncExternalStore } from "react";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { z } from "zod";

const organizationSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}$/i)
  .transform((owner) => owner.toLowerCase())
  .nullable();

function createOrganizationStore(key: string) {
  const read = () => {
    try {
      return organizationSchema.parse(
        JSON.parse(localStorage.getItem(key) ?? "null"),
      );
    } catch {
      return null;
    }
  };
  let organization = read();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== key && event.key !== null) return;
    organization = read();
    notify();
  };
  return {
    getSnapshot: () => organization,
    setOrganization: (next: string | null) => {
      organization = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      notify();
    },
    subscribe: (listener: () => void) => {
      if (listeners.size === 0) {
        organization = read();
        window.addEventListener("storage", onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0)
          window.removeEventListener("storage", onStorage);
      };
    },
  };
}

const stores = new Map<string, ReturnType<typeof createOrganizationStore>>();

export function useOrganization() {
  const key = `${experimental_usePluginId()}:calm-organization`;
  let store = stores.get(key);
  if (!store) {
    store = createOrganizationStore(key);
    stores.set(key, store);
  }
  return {
    organization: useSyncExternalStore(store.subscribe, store.getSnapshot),
    setOrganization: store.setOrganization,
  };
}
