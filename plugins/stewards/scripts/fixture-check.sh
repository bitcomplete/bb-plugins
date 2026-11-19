#!/usr/bin/env bash
# The stewards fixture smoke test (BB-364): the onboarding path on a stock bb.
#
# It installs the plugin from this checkout into a bb that has no multi-repo,
# no Linear and no hooks service, points it at the public fixture repository,
# and runs the path the getting-started guide describes: survey, init, check.
# It asserts the facts the fixture exists to guard (BB-359, BB-362, BB-363):
# the survey finds the fixture's CI commands and nothing Kubernetes-shaped,
# init writes a decide list whose paths are all inside the repository, and
# check reports polling mode and no problem lines.
#
# CI starts bb and runs this. Locally, point BB_SERVER_URL at a throwaway bb
# (one with no multi-repo, no Linear and no hooks service) and it uses it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
GUIDE="$PLUGIN_DIR/GETTING-STARTED.md"
FIXTURE_REPO="${BB_FIXTURE_REPO:-bitcomplete/stewards-fixture}"
export BB_SERVER_URL="${BB_SERVER_URL:-http://127.0.0.1:38886}"
WORK="${BB_FIXTURE_WORKDIR:-$(mktemp -d)}"
mkdir -p "$WORK"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

# 1. The plugin installs from this checkout, on a bb with no baked-in copy.
#    A local-path install uses the checkout's node_modules, so install them
#    first; a rerun on the same server skips the install.
say "Install the plugins from this checkout"
for p in stewards github-watcher; do
  if bb plugin list | grep -q "^${p}@"; then
    echo "already installed: $p"
    continue
  fi
  (cd "$REPO_ROOT/plugins/$p" && npm install --include=dev --legacy-peer-deps --no-audit --no-fund >/dev/null)
  bb plugin install "$REPO_ROOT/plugins/$p" --yes
done
bb plugin list | grep -q '^stewards@' || fail "stewards did not install"
bb plugin list | grep -q '^github-watcher@' || fail "github-watcher did not install"

# 2. The fixture repository, plus a local bare origin. check reads `.bb` from
#    the committed tip of origin's default branch, and the public fixture
#    repository must not receive a push, so the job pushes to its own origin.
say "Clone the fixture repository"
git clone --quiet "https://github.com/$FIXTURE_REPO.git" "$WORK/fixture"
git clone --quiet --mirror "https://github.com/$FIXTURE_REPO.git" "$WORK/origin.git"

# 3. A project for it on this server.
say "Create the project"
for _ in $(seq 1 30); do
  MACHINE="$(bb machine list --json | jq -r '.[0].id // empty')"
  [ -n "$MACHINE" ] && break
  sleep 1
done
[ -n "${MACHINE:-}" ] || fail "no connected machine"
PROJECT="$(bb project create --name stewards-fixture --root "$WORK/fixture" --machine "$MACHINE" --json | jq -r '.id // empty')"
[ -n "$PROJECT" ] || fail "could not create the project"

# 4. survey --json: the fixture's CI commands are found, nothing
#    Kubernetes-shaped is emitted, and Linear is unavailable on a stock bb.
say "survey"
bb stewards survey --json --project "$PROJECT" > "$WORK/survey.json"
jq -e '[.repos[].testCommands[]] | index("go test ./...")' "$WORK/survey.json" >/dev/null || fail "survey did not find the fixture's test command"
jq -e '[.repos[].typecheckCommands[]] | index("go vet ./...")' "$WORK/survey.json" >/dev/null || fail "survey did not find the fixture's typecheck command"
jq -e 'tostring | test("kustomization|kubernetes|deployManifests"; "i") | not' "$WORK/survey.json" >/dev/null || fail "survey emitted something Kubernetes-shaped"
jq -e '.linear.available == false' "$WORK/survey.json" >/dev/null || fail "Linear should be unavailable on a stock bb"

# 5. init writes a decide list whose paths are all inside the repository.
say "init"
bb stewards init --dir "$WORK/fixture/.bb" --prefix LOCAL --timezone America/New_York
PROJECT_FILE="$WORK/fixture/.bb/stewards/project.json"
[ -f "$PROJECT_FILE" ] || fail "init wrote no project.json"
jq -e '.bigDecisions | length > 0' "$PROJECT_FILE" >/dev/null || fail "init wrote an empty decide list"
# Every path is a bare name at the repo root, an anywhere-glob (`**/…`), or
# rooted at a real top-level entry. A repo-dir-prefixed path such as
# `bb-gate/kploy/**` (the pre-BB-359 shape) fails, which is the regression
# this guards. The loop reads from a process substitution, so `fail` exits
# the script rather than a pipe subshell.
while IFS= read -r path; do
  if [[ "$path" != */* ]]; then continue; fi
  if [[ "$path" == "**/"* ]]; then continue; fi
  first="${path%%/*}"
  [ -e "$WORK/fixture/$first" ] || fail "the decide list names a path outside the repository: $path"
done < <(jq -r '.bigDecisions[].paths[]?' "$PROJECT_FILE")

# 6. check reads the committed `.bb`: polling mode, the fixture repository is
#    resolved, and no problem lines. Fetch and push go to the local mirror
#    while `remote.origin.url` stays the GitHub URL (project-git.ts reads the
#    raw config), so the public repository never receives a push and `check`
#    still validates the GitHub side the guide describes.
say "check"
cd "$WORK/fixture"
git add -A
git -c user.email=ci@example.com -c user.name=ci commit --quiet -m "Add the .bb skeleton"
git config url."$WORK/origin.git".insteadOf "https://github.com/$FIXTURE_REPO.git"
git push --quiet origin main
git fetch --quiet origin
set +e
CHECK="$(bb stewards check --project "$PROJECT" 2>&1)"
STATUS=$?
set -e
printf '%s\n' "$CHECK"
[ "$STATUS" -eq 0 ] || fail "check exited $STATUS"
printf '%s\n' "$CHECK" | grep -q "repos: $FIXTURE_REPO" || fail "check did not resolve the fixture repository"
printf '%s\n' "$CHECK" | grep -q 'doorbells: polling every' || fail "check did not report polling mode"
if printf '%s\n' "$CHECK" | grep -q 'problem:'; then
  fail "check reported a problem"
fi

# 7. The guide names no company-specific host.
say "guide"
if grep -Eqi 'bb-gate|bc-prod|kploy|boreray-eel\.ts\.net' "$GUIDE"; then
  fail "the guide names a company-specific host"
fi

say "fixture smoke passed"
