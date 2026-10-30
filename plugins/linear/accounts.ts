// Several Linear workspaces on one bb server: what each connection holds,
// and which one a call goes to.
//
// A developer may belong to more than one Linear workspace (their own
// company's and a client's, say). Each Connect Linear approves one of them,
// and each becomes an account here, named by the workspace's URL key
// (`acme` in linear.app/acme). Tokens for all of them live in one secret
// setting as JSON, so they stay in the 0600 secrets file like the single
// token did.
//
// Routing: a team key belongs to exactly one workspace almost always, and an
// issue key starts with its team's key, so ENG-123 goes to the workspace that
// has team ENG. An explicit account wins; a call that names no team (free-text
// search, a raw query) goes to the default account. Several workspaces with
// the same team key are an error that asks for the account rather than a
// guess.
//
// Pure: no storage, no network.
import { z } from "zod";

export const accountSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  /** Epoch ms; null when Linear gave no expiry. */
  expiresAt: z.number().nullable(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string().nullable() }),
  organization: z.object({ name: z.string(), urlKey: z.string() }),
  /** Epoch ms; orders the accounts, and the oldest is the default unless one is chosen. */
  connectedAt: z.number(),
});
export type Account = z.infer<typeof accountSchema> & { key: string };

const storedSchema = z.record(z.string(), accountSchema);
export type StoredAccounts = z.infer<typeof storedSchema>;

/** An account's key: its workspace's URL key, lower-cased. */
export const accountKey = (urlKey: string) => urlKey.trim().toLowerCase();

/** The secret setting's JSON as accounts, oldest first. Anything unreadable is no accounts. */
export function parseAccounts(raw: string | undefined): Account[] {
  if (raw === undefined || raw.trim() === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = storedSchema.safeParse(json);
  if (!parsed.success) return [];
  return Object.entries(parsed.data)
    .map(([key, a]) => ({ ...a, key }))
    .sort((a, b) => a.connectedAt - b.connectedAt || a.key.localeCompare(b.key));
}

export function serializeAccounts(accounts: Account[]): string {
  return JSON.stringify(Object.fromEntries(accounts.map(({ key, ...a }) => [key, a])));
}

/** The default account: the chosen one while it is connected, else the oldest. */
export function defaultAccount(accounts: Account[], chosen: string | undefined): Account | null {
  return accounts.find((a) => a.key === chosen) ?? accounts[0] ?? null;
}

/** How an account is named to a person and an agent: `acme (Acme Inc)`. */
export const describeAccount = (a: Account) => (a.organization.name.toLowerCase() === a.key ? a.key : `${a.key} (${a.organization.name})`);

/** The account an `account` argument names: by URL key or workspace name, ignoring case. */
export function findAccount(accounts: Account[], name: string): Account | null {
  const n = name.trim().toLowerCase();
  return accounts.find((a) => a.key === n) ?? accounts.find((a) => a.organization.name.toLowerCase() === n) ?? null;
}

/** The team key an issue key starts with: ENG for ENG-123. */
export function teamOfIssueKey(key: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-\d+$/u.exec(key.trim());
  return m === null ? null : m[1]!.toUpperCase();
}

/**
 * Which accounts have this team, given each account's team map (team key to
 * UUID). An account whose map is not known yet has no teams.
 */
export function accountsWithTeam(accounts: Account[], teams: (account: string) => Record<string, string> | undefined, team: string): Account[] {
  const key = team.trim().toUpperCase();
  return accounts.filter((a) => teams(a.key)?.[key] !== undefined);
}

export class AccountChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountChoiceError";
  }
}

export const listAccounts = (accounts: Account[]) => accounts.map(describeAccount).join(", ");
