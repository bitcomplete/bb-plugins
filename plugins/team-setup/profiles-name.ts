// The data-profile name rule, kept free of zod so the app entry can import it
// at runtime without pulling the contract (or zod) into the browser bundle.
export const DEFAULT_PROFILE = "default";
export const PROFILE_NAME_MAX = 32;
// A lowercase DNS label: starts and ends alphanumeric, hyphens inside. The
// name becomes a path segment, so anything else is refused.
export const PROFILE_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function validProfileName(name: string): boolean {
  return name.length >= 1 && name.length <= PROFILE_NAME_MAX && PROFILE_NAME_RE.test(name);
}

export interface ProfileRow {
  name: string;
  // "has a bb.db": the profile has booted at least once.
  booted: boolean;
  bytes: number;
}
