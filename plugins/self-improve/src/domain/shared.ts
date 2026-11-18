import { createHash } from "node:crypto";

export const DAY_MS = 86_400_000;
export const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const unique = (values: string[]): string[] => [...new Set(values)].sort(compareIds);
export function text(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) throw new Error(`${name} must be nonempty bounded text`);
}
export function finite(value: number, name: string, minimum = 0): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and at least ${minimum}`);
}
export function integer(value: number, name: string, minimum = 0): void {
  finite(value, name, minimum);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}
export function day(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error("invalid calendar day");
}
export function stableJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareIds(a, b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return JSON.stringify(canonical(value));
}
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32)}`;
}
