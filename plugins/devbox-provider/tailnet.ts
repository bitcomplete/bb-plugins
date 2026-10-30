// Putting a new devbox on the tailnet.
//
// A devbox must join as its developer's own node, not a tagged one: bb-gate
// routes a daemon to its owner's server by the tailnet identity it dials
// from, and tsjwt refuses tagged callers. So there is no auth key to mint;
// the developer signs in, once per machine, at the URL tailscaled prints.
// This module starts that login and reads tailscaled's state; the provider
// surfaces the URL and waits.

export interface TailscaleStatus {
  backendState: string; // "NeedsLogin", "Starting", "Running", ...
  authUrl: string;
  dnsName: string;
  tags: string[];
}

export function parseTailscaleStatus(json: string): TailscaleStatus {
  const raw = JSON.parse(json) as {
    BackendState?: unknown;
    AuthURL?: unknown;
    Self?: { DNSName?: unknown; Tags?: unknown } | null;
  };
  const tags = Array.isArray(raw.Self?.Tags) ? raw.Self.Tags.filter((t): t is string => typeof t === "string") : [];
  return {
    backendState: typeof raw.BackendState === "string" ? raw.BackendState : "",
    authUrl: typeof raw.AuthURL === "string" ? raw.AuthURL : "",
    dnsName: typeof raw.Self?.DNSName === "string" ? raw.Self.DNSName.replace(/\.$/u, "") : "",
    tags,
  };
}

// Run as root. `tailscale up` blocks until the login completes, so it runs
// detached with every descriptor redirected, or the exec would not end.
// --ssh matches the devbox README, so `ssh dev@<machine>` works as it does
// for machines made by hand.
export const START_LOGIN_SCRIPT = `
set -eu
setsid tailscale up --ssh </dev/null >/var/log/bb-tailscale-up.log 2>&1 &
`;

export const STATUS_COMMAND = ["tailscale", "status", "--json"];

// Run as root. Waits for cloud-init (exit 2 is "done, with recoverable
// errors", which a working image can report), then lets the dev user's
// systemd instance outlive any login session, which bb's installer needs for
// its user service, and waits for that instance's bus.
export const PREPARE_SCRIPT = `
set -u
cloud-init status --wait >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
  echo "cloud-init failed (exit $rc); see /var/log/cloud-init-output.log" >&2
  exit "$rc"
fi
id dev >/dev/null 2>&1 || { echo "the image has no dev user" >&2; exit 1; }
loginctl enable-linger dev
i=0
while [ ! -S /run/user/1000/bus ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo "dev's user session bus did not appear" >&2; exit 1; fi
  sleep 1
done
`;

// Run as root before removal. Logging out takes the node off the tailnet
// rather than leaving it to expire; failure is not worth stopping for.
export const LOGOUT_COMMAND = ["sh", "-c", "tailscale logout >/dev/null 2>&1 || true"];

// Run as root with the server's address. A node that has just signed in can
// take a moment before it reaches its peers, and bb's installer gives up on
// the first connection timeout, so wait until the server answers at all
// (any HTTP status will do) before bootstrapping.
export const REACH_SERVER_SCRIPT = `
set -u
i=0
until curl -sS -o /dev/null --max-time 10 "$1"; do
  i=$((i + 1))
  if [ "$i" -ge 18 ]; then
    echo "this machine cannot reach $1 over the tailnet" >&2
    exit 1
  fi
  sleep 5
done
`;
