#!/usr/bin/env python3
"""PR board: fetch my open PRs, derive stacks/groups/next moves, write data.json + board.html.

  python3 build.py            fetch from GitHub (gh api graphql), then build
  python3 build.py --offline  rebuild from the saved raw.json
  --out DIR                   write raw.json, data.json and board.html to DIR (default: this directory)
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEARCH = "is:pr is:open author:@me archived:false"
PAGE_SIZES = [25, 12, 6, 3, 1]
RETRYABLE = ("timeout", "timed out", "node limit", "max_node_limit", "something went wrong", "502", "504")

QUERY = """
query($q: String!, $n: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $n, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url isDraft baseRefName headRefName headRefOid
      mergeable mergeStateStatus reviewDecision updatedAt createdAt additions deletions changedFiles
      repository { nameWithOwner defaultBranchRef { name } }
      labels(first: 20) { nodes { name } }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } } }
      timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 30) { nodes { ... on ReviewRequestedEvent {
        createdAt requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } } } } }
      latestOpinionatedReviews(first: 20) { nodes { author { __typename login } state submittedAt commit { oid } } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { isResolved isOutdated path
          comments(first: 50) { pageInfo { hasNextPage } nodes { author { __typename login } body createdAt url } } }
      }
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state
        contexts(first: 100) { ...ctx } } } } }
    } }
  }
}"""

CONTEXTS = """
fragment ctx on StatusCheckRollupContextConnection {
  pageInfo { hasNextPage endCursor }
  nodes { __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl } }
}"""

MORE_CONTEXTS = """
query($o: String!, $r: String!, $n: Int!, $after: String) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) { commits(last: 1) { nodes { commit {
    statusCheckRollup { contexts(first: 100, after: $after) { ...ctx } } } } } } }
}""" + CONTEXTS
QUERY += CONTEXTS


def die(msg):
    sys.exit(f"build.py: {msg}")


# ---------------------------------------------------------------- fetch

def gh(*args):
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True)
    except FileNotFoundError:
        die("gh is not installed or not on PATH")
    return p.returncode, p.stdout, p.stderr


def fetch_page(after, n):
    args = ["api", "graphql", "-f", f"query={QUERY}", "-f", f"q={SEARCH}", "-F", f"n={n}"]
    if after:
        args += ["-f", f"after={after}"]
    code, out, err = gh(*args)
    try:
        body = json.loads(out)
    except ValueError:
        body = {}
    errors = body.get("errors") or ([] if code == 0 else [{"message": (err or out).strip()}])
    return body.get("data"), errors


def fetch_more_contexts(x, where):
    """Page through a PR's remaining check contexts in place (busy monorepo PRs exceed 100)."""
    c = (x["commits"]["nodes"] or [{}])[0].get("commit") or {}
    ctx = (c.get("statusCheckRollup") or {}).get("contexts")
    owner, name = x["repository"]["nameWithOwner"].split("/")
    while ctx and ctx["pageInfo"]["hasNextPage"]:
        code, out, err = gh("api", "graphql", "-f", f"query={MORE_CONTEXTS}", "-f", f"o={owner}", "-f", f"r={name}",
                            "-F", f"n={x['number']}", "-f", f"after={ctx['pageInfo']['endCursor']}")
        body = json.loads(out) if out.strip().startswith("{") else {}
        if code or body.get("errors"):
            die(f"{where}: fetching more check contexts failed: {body.get('errors') or err.strip()}")
        page = body["data"]["repository"]["pullRequest"]["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]
        ctx["nodes"] += page["nodes"]
        ctx["pageInfo"] = page["pageInfo"]


def fetch():
    code, login, err = gh("api", "user", "-q", ".login")
    if code:
        die(f"gh api user failed: {err.strip()}")
    nodes, after, more = [], None, True
    while more:
        for n in PAGE_SIZES:
            data, errors = fetch_page(after, n)
            if not errors:
                break
            text = json.dumps(errors).lower()
            if not any(t in text for t in RETRYABLE):
                die(f"GraphQL error: {json.dumps(errors)}")
            print(f"  page of {n} failed ({errors[0].get('message', '')[:80]}); retrying smaller", file=sys.stderr)
        else:
            die(f"GraphQL error at smallest page size: {json.dumps(errors)}")
        search = data["search"]
        nodes += [x for x in search["nodes"] if x]
        after, more = search["pageInfo"]["endCursor"], search["pageInfo"]["hasNextPage"]
    for x in nodes:
        where = f"{x['repository']['nameWithOwner']}#{x['number']}"
        if x["reviewThreads"]["pageInfo"]["hasNextPage"]:
            die(f"{where} has more than 100 review threads; not all were fetched")
        if any(t["comments"]["pageInfo"]["hasNextPage"] for t in x["reviewThreads"]["nodes"]):
            die(f"{where} has a review thread with more than 50 comments; its last comment is unknown")
        fetch_more_contexts(x, where)
    return {"login": login.strip(), "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "prs": nodes}


# ---------------------------------------------------------------- derive (pure)

TICKET = re.compile(r"[A-Z][A-Z0-9]+-\d+")
BRANCH_TICKET = re.compile(r"(?:^|/)([a-z][a-z0-9]+-\d+)", re.I)
SUBSTANTIVE = {"risk", "bug", "p0", "p1", "blocker", "must"}
MINOR = {"nit", "p2", "p3", "improvement", "suggestion", "question"}
LABEL = re.compile(r"([a-z][a-z0-9]*)\b")
BADGE = re.compile(r"(?:<sub>\s*)*!\[(p[0-3]) badge\]")  # Codex: **<sub><sub>![P1 Badge](…)</sub></sub>
MOVES = ["fix", "ready", "reply", "rebase", "ci", "review", "gated", "draft"]  # group urgency order


def normalize(x):
    """Flatten a raw GraphQL PullRequest node into the shape the derive functions use."""
    commit = ((x["commits"]["nodes"] or [{}])[0].get("commit")) or {}
    rollup = commit.get("statusCheckRollup") or {}
    checks = []
    for c in (rollup.get("contexts") or {}).get("nodes", []):
        if c["__typename"] == "CheckRun":
            checks.append({"name": c["name"], "status": c["status"], "conclusion": c["conclusion"],
                           "state": None, "url": c["detailsUrl"]})
        else:
            checks.append({"name": c["context"], "status": None, "conclusion": None,
                           "state": c["state"], "url": c["targetUrl"]})
    login = login_of
    return {
        "repo": x["repository"]["nameWithOwner"],
        "default_branch": (x["repository"]["defaultBranchRef"] or {}).get("name"),
        "number": x["number"], "title": x["title"], "url": x["url"], "draft": x["isDraft"],
        "base": x["baseRefName"], "head": x["headRefName"], "head_oid": x["headRefOid"],
        "mergeable": x["mergeable"], "merge_state": x["mergeStateStatus"], "review_decision": x["reviewDecision"],
        "updated_at": x["updatedAt"], "created_at": x["createdAt"],
        "labels": [l["name"] for l in x["labels"]["nodes"]],
        "requested": [r["requestedReviewer"].get("login") or r["requestedReviewer"].get("name")
                      for r in x["reviewRequests"]["nodes"] if r["requestedReviewer"]],
        "reviews": [{"author": login(r["author"]), "state": r["state"], "at": r["submittedAt"],
                     "oid": (r["commit"] or {}).get("oid"), "is_bot": is_bot(r["author"])}
                    for r in x["latestOpinionatedReviews"]["nodes"]],
        "threads": [{"resolved": t["isResolved"], "outdated": t["isOutdated"], "path": t["path"],
                     "comments": [{"author": login(c["author"]), "body": c["body"], "at": c["createdAt"],
                                   "url": c["url"], "is_bot": is_bot(c["author"])} for c in t["comments"]["nodes"]]}
                    for t in x["reviewThreads"]["nodes"]],
        "committed_at": commit.get("committedDate"),
        "additions": x.get("additions", 0), "deletions": x.get("deletions", 0),
        "changed_files": x.get("changedFiles", 0),
        "requested_at": requested_at(x),
        "checks": checks,
    }


def requested_at(x):
    """Latest review-request time per requested reviewer (login or team name)."""
    out = {}
    for e in (x.get("timelineItems") or {}).get("nodes", []):
        who = (e.get("requestedReviewer") or {})
        who = who.get("login") or who.get("name")
        if who and e.get("createdAt"):
            out[who] = max(out.get(who, ""), e["createdAt"])
    return out


def is_bot(author):
    """Bot authors: GraphQL __typename Bot (chatgpt-codex-connector has no [bot] suffix) or a [bot] login."""
    return (author or {}).get("__typename") == "Bot" or login_of(author).endswith("[bot]")


def login_of(author):
    return (author or {}).get("login") or "ghost"


def key(pr):
    return f"{pr['repo']}#{pr['number']}"


def ticket_key(pr):
    m = TICKET.search(pr["title"])
    if m:
        return m.group(0)
    m = BRANCH_TICKET.search(pr["head"])
    return m.group(1).upper() if m else None


def build_stacks(prs):
    """Return (stacks, info). stacks: lists of (pr, depth), parent-first. info[key]: parent number, base_missing."""
    by_head = {}
    for p in sorted(prs, key=lambda p: p["number"]):
        by_head.setdefault((p["repo"], p["head"]), p)
    parent, children, info = {}, {}, {}
    for p in prs:
        par = by_head.get((p["repo"], p["base"])) if p["base"] != p["default_branch"] else None
        if par is p:
            par = None
        parent[key(p)] = par
        info[key(p)] = {"parent": par["number"] if par else None,
                        "base_missing": par is None and p["base"] != p["default_branch"]}
        if par:
            children.setdefault(key(par), []).append(p)
    stacks = []
    for root in sorted((p for p in prs if parent[key(p)] is None), key=lambda p: (p["repo"], p["number"])):
        members, todo = [], [(root, 0)]
        while todo:
            p, d = todo.pop()
            members.append((p, d))
            todo += [(c, d + 1) for c in sorted(children.get(key(p), []), key=lambda c: -c["number"])]
        stacks.append(members)
    return stacks, info


def classify(body):
    s = body.lstrip("*[ \t\r\n").lower()
    if "(not a bug)" in s.split("\n", 1)[0]:  # e.g. "**Possible PHI (not a bug).**"
        return "minor"
    m = BADGE.match(s) or LABEL.match(s)
    word = m.group(1) if m else ""
    return "substantive" if word in SUBSTANTIVE else "minor" if word in MINOR else "unlabeled"


def excerpt(comment, label=None):
    body = " ".join(comment["body"].split())
    return {"author": comment["author"], "at": comment["at"], "url": comment["url"], "label": label,
            "is_bot": comment.get("is_bot", False),
            "text": body[:140] + ("…" if len(body) > 140 else "")}


def ci_facts(checks):
    failing, pending = [], []
    for c in checks:
        if c["conclusion"] == "CANCELLED":
            continue
        if c["conclusion"] in ("FAILURE", "TIMED_OUT", "ACTION_REQUIRED") or c["state"] in ("FAILURE", "ERROR"):
            failing.append({"name": c["name"], "url": c["url"]})
        elif c["status"] in ("QUEUED", "IN_PROGRESS") or c["state"] == "PENDING":
            pending.append(c["name"])
    return {"failing": failing, "pending": pending}


def days_between(earlier, now):
    if not earlier:
        return None
    t = datetime.fromisoformat(earlier.replace("Z", "+00:00"))
    return int((now - t).total_seconds() // 86400)


def pr_facts(pr, user, stack_info, gates, now):
    unanswered, answered_open = [], []
    for t in pr["threads"]:
        if t["resolved"] or not t["comments"]:
            continue
        if t["comments"][-1]["author"] == user:
            answered_open.append(excerpt(t["comments"][-1]))
        else:
            first = next((c for c in t["comments"] if c["author"] != user), t["comments"][0])
            unanswered.append(excerpt(first, classify(first["body"])))
    human = [r for r in pr["reviews"] if not r.get("is_bot")]
    approved = [r for r in human if r["state"] == "APPROVED"]
    days = days_between(pr["committed_at"], now)
    gate_labels = [g["label"] for g in gates if g["repo"] == pr["repo"] and pr["number"] in g["prs"]]
    if stack_info["parent"]:
        gate_labels.append(f"parent #{stack_info['parent']} not merged")
    return {
        "unanswered": unanswered, "answered_open": answered_open,
        # One human approval is enough to merge, on any commit. `approvals` keeps which commit it was on
        # for display only; decisions read `approved_by`.
        "approved_by": [r["author"] for r in approved],
        "approvals": {"current": [r["author"] for r in approved if r["oid"] == pr["head_oid"]],
                      "stale": [r["author"] for r in approved if r["oid"] != pr["head_oid"]]},
        "changes_requested": [r["author"] for r in human if r["state"] == "CHANGES_REQUESTED"],
        "changes_outstanding": pr.get("review_decision") == "CHANGES_REQUESTED"
                               or any(r["state"] == "CHANGES_REQUESTED" for r in human),
        "conflict": pr["mergeable"] == "CONFLICTING" or pr["merge_state"] == "DIRTY",
        "base_missing": stack_info["base_missing"],
        "ci": ci_facts(pr["checks"]),
        "waiting_on": [waiting_entry(r, pr, days, now) for r in pr["requested"]],
        "gates": gate_labels,
    }


def waiting_entry(reviewer, pr, push_days, now):
    """Days since this reviewer was asked; without a request event, days since the last push, marked approx."""
    at = pr.get("requested_at", {}).get(reviewer)
    if at:
        return {"reviewer": reviewer, "days": days_between(at, now), "approx": False}
    return {"reviewer": reviewer, "days": push_days, "approx": True}


def next_move(pr, f):
    """Return (move, sub_label). First matching rule wins.

    One human approval on any commit is enough to merge; a pending request to a second reviewer never
    blocks. What blocks: unanswered feedback, an outstanding changes request, conflicts, CI, and gates."""
    labels = [t["label"] for t in f["unanswered"]]
    if pr["draft"]:
        return "draft", None
    if any(l != "minor" for l in labels):
        return "fix", None
    if labels:
        return "reply", None
    if f["conflict"] or f["base_missing"]:
        return "rebase", "retarget" if f["base_missing"] else None
    if f["ci"]["failing"]:
        return "ci", None
    if f["changes_outstanding"]:
        return "review", "changes"
    if not f["approved_by"]:
        return "review", None if f["waiting_on"] else "no reviewer"
    if f["gates"] or f["answered_open"]:
        return "gated", None
    if f["ci"]["pending"]:
        return "ci", "pending"  # approved and otherwise ready: only the running checks stand between
    return "ready", None


FILTERS = {  # filter id -> membership test on a derived PR; the board's buttons use these ids
    "fix": lambda p: p["move"] in ("fix", "reply"),
    "afb": lambda p: bool(p["approved_by"])
                     and bool(p["unanswered"] or p["answered_open"]),
    "gated": lambda p: bool(p["gates"] or p["answered_open"]),
    "review": lambda p: p["move"] == "review",
    "ready": lambda p: p["move"] == "ready",
    "draft": lambda p: p["move"] == "draft",
}


def pr_filters(p):
    return [fid for fid, test in FILTERS.items() if test(p)]


def build_groups(prs, stacks, gates):
    """Return a list of groups: {name, kind, repo, keys (ordered), depth {key: d}, order (stack merge order)}."""
    groups, placed = [], set()
    for members in stacks:
        if len(members) < 2:
            continue
        tickets = {ticket_key(p) for p, _ in members}
        root = members[0][0]
        name = tickets.pop() if len(tickets) == 1 and None not in tickets else root["title"]
        groups.append({"name": name, "kind": "stack", "repo": root["repo"],
                       "keys": [key(p) for p, _ in members], "depth": {key(p): d for p, d in members},
                       "order": [p["number"] for p, _ in members]})
        placed |= {key(p) for p, _ in members}
    by_key = {key(p): p for p in prs}
    for g in gates:
        if "group" not in g:
            continue
        ks = [f"{g['repo']}#{n}" for n in g["prs"] if f"{g['repo']}#{n}" in by_key and f"{g['repo']}#{n}" not in placed]
        if ks:
            groups.append({"name": g["group"], "kind": "gate", "repo": g["repo"], "keys": ks, "depth": {}})
            placed |= set(ks)
    by_ticket = {}
    for p in sorted(prs, key=lambda p: (p["repo"], p["number"])):
        if key(p) not in placed and ticket_key(p):
            by_ticket.setdefault(ticket_key(p), []).append(p)
    stack_by_ticket = {(g["repo"], g["name"]): g for g in groups if g["kind"] == "stack" and TICKET.fullmatch(g["name"])}
    for t, ps in by_ticket.items():
        for p in [p for p in ps if (p["repo"], t) in stack_by_ticket]:
            stack_by_ticket[(p["repo"], t)]["keys"].append(key(p))  # after the stack, unindented
            placed.add(key(p))
        ps = [p for p in ps if key(p) not in placed]
        if len(ps) >= 2:
            groups.append({"name": t, "kind": "ticket", "repo": ps[0]["repo"], "keys": [key(p) for p in ps], "depth": {}})
            placed |= {key(p) for p in ps}
    standalone = {}
    for p in sorted(prs, key=lambda p: (p["repo"], p["number"])):
        if key(p) not in placed:
            standalone.setdefault(p["repo"], []).append(key(p))
    for repo, ks in standalone.items():
        groups.append({"name": f"Standalone · {repo.split('/')[-1]}", "kind": "standalone", "repo": repo,
                       "keys": ks, "depth": {}})
    return groups


def short_title(title, group_name):
    if not TICKET.fullmatch(group_name or ""):
        return title
    t = re.sub(rf"^\s*\[?{re.escape(group_name)}\]?\s*[:\-–—|]?\s*", "", title)
    return re.sub(rf"\s*\({re.escape(group_name)}\)\s*$", "", t)


def derive(raw, gates_doc):
    user, now = raw["login"], datetime.fromisoformat(raw["fetched_at"])
    prs = [normalize(x) for x in raw["prs"]]
    gates = gates_doc["gates"]
    open_keys = {key(p) for p in prs}
    stale = [f"{g['id']}:#{n}" for g in gates for n in g["prs"] if f"{g['repo']}#{n}" not in open_keys]
    stacks, info = build_stacks(prs)
    out = {}
    for p in prs:
        f = pr_facts(p, user, info[key(p)], gates, now)
        move, sub = next_move(p, f)
        out[key(p)] = {"key": key(p), "number": p["number"], "title": p["title"], "url": p["url"],
                       "repo": p["repo"], "draft": p["draft"], "move": move, "sub": sub,
                       "labels": p["labels"], "parent": info[key(p)]["parent"],
                       "head": p["head"], "head_oid": p["head_oid"], "base": p["base"],
                       "additions": p.get("additions", 0), "deletions": p.get("deletions", 0),
                       "changed_files": p.get("changed_files", 0), **f}
        out[key(p)]["filters"] = pr_filters(out[key(p)])
    groups = build_groups(prs, stacks, gates)
    rank = {m: i for i, m in enumerate(MOVES)}
    for g in groups:
        for k in g["keys"]:
            out[k]["short"] = short_title(out[k]["title"], g["name"])
        g["rank"] = min(rank[out[k]["move"]] for k in g["keys"])
    groups.sort(key=lambda g: (g["rank"], -len(g["keys"]), g["name"]))
    return {"login": user, "fetched_at": raw["fetched_at"], "prs": out, "groups": groups}, stale


# ---------------------------------------------------------------- render

TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>PR board</title>
<style>
:root{--_fg:#1f2328;--_mu:#656d76;--_bd:#d8dee4;--_card:#f6f8fa;--_ac:#0969da;--_red:#cf222e;--_amb:#9a6700;--_grn:#1a7f37;--_att:#8250df}
@media (prefers-color-scheme:dark){:root{--_fg:#e6edf3;--_mu:#8d96a0;--_bd:#30363d;--_card:#161b22;--_ac:#4493f8;--_red:#f85149;--_amb:#d29922;--_grn:#3fb950;--_att:#a371f7}}
.board{color:var(--foreground,var(--_fg));font:13px/1.45 var(--font-sans,system-ui,-apple-system,sans-serif);min-width:0}
.board *{box-sizing:border-box}
.board a{color:var(--accent,var(--_ac));text-decoration:none}.board a:hover{text-decoration:underline}
.mu{color:var(--muted-foreground,var(--_mu))}
.sum{margin:0 0 8px}
.bar{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;margin-bottom:6px}
.bar button{font:inherit;font-size:12px;color:inherit;background:none;border:1px solid var(--border,var(--_bd));border-radius:var(--radius,6px);padding:2px 8px;cursor:pointer}
.bar button[aria-pressed=true]{background:var(--surface-raised,var(--_card));border-color:var(--foreground,var(--_fg));font-weight:600}
.bar button .n{color:var(--muted-foreground,var(--_mu))}
.bar label{font-size:12px;display:flex;gap:4px;align-items:center}
.bar input[type=search]{font:inherit;font-size:12px;color:inherit;background:none;border:1px solid var(--border,var(--_bd));border-radius:var(--radius,6px);padding:2px 6px;flex:1 1 140px;min-width:0;max-width:240px}
details.grp{border-top:1px solid var(--border,var(--_bd));padding:4px 0}
details.grp>summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;padding:2px 0}
.gname{font-weight:600;overflow-wrap:anywhere}
.order{font:11px var(--font-mono,ui-monospace,monospace);flex-basis:100%}
.tally{font-size:12px}
ul.rows{list-style:none;margin:2px 0 4px;padding:0}
.stack ul.rows:not(.extra){border-left:1px solid var(--border,var(--_bd));margin-left:5px}
li.row{padding-left:calc(var(--d,0)*16px + 4px)}
li.row.ctx{opacity:.45}
details.pr>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;gap:2px 6px;align-items:baseline;padding:3px 4px;border-radius:var(--radius,6px)}
details.pr>summary::-webkit-details-marker{display:none}
details.pr>summary:hover,details.pr[open]>summary{background:var(--surface-raised,var(--_card))}
.conn{font-family:var(--font-mono,ui-monospace,monospace)}
.num{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px}
.ttl{flex:1 1 14em;min-width:0;overflow-wrap:anywhere}
.chip{font-size:11px;font-weight:600;border:1px solid currentColor;border-radius:999px;padding:0 7px;white-space:nowrap}
.m-fix,.m-ci{color:var(--destructive-text,var(--_red))}.m-reply,.m-rebase{color:var(--warning-text,var(--_amb))}
.m-ready{color:var(--success,var(--_grn))}.m-review{color:var(--attention,var(--_att))}.m-gated{color:var(--brand,var(--_ac))}
.m-draft{color:var(--muted-foreground,var(--_mu))}
.bdg.gt{color:var(--brand,var(--_ac));border-style:dashed}
ul.rows.extra:empty{display:none}
.bdg{font-size:11px;color:var(--muted-foreground,var(--_mu));border:1px solid var(--border,var(--_bd));border-radius:var(--radius,6px);padding:0 5px;overflow-wrap:anywhere}
.more{padding:4px 8px 8px 24px;font-size:12px;background:var(--card,transparent)}
.more h4{font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px;color:var(--muted-foreground,var(--_mu))}
.more ul{margin:0;padding-left:16px}.more li{margin:2px 0;overflow-wrap:anywhere}
.empty{padding:8px 0}
</style></head><body>
<div class="board" id="board">
<p class="sum"><span id="count"></span> open PRs · as of __LOCAL__ <span class="mu">(<span id="iso"></span>)</span></p>
<div class="bar" id="filters" role="group" aria-label="Filter by next move"></div>
<div class="bar"><label><input type="checkbox" id="hideStd"> Hide standalone groups</label>
<input type="search" id="q" placeholder="Filter by #, title, repo" aria-label="Filter by PR number, title, or repo"></div>
<div id="groups"></div><p class="empty mu" id="none" hidden>No PRs match.</p>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
(()=>{
const D=JSON.parse(document.getElementById('data').textContent), P=D.prs;
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MOVES=['fix','ready','reply','rebase','ci','review','gated','draft'];
const NAME={fix:'fix',ready:'ready',reply:'reply',rebase:'rebase',ci:'CI',review:'review',gated:'gated',draft:'draft'};
const FILTERS=[['all','All'],['fix','Needs fix'],['afb','Approved with open feedback'],['gated','Gated'],
 ['review','Waiting on review'],['ready','Ready to merge'],['draft','Drafts']].map(([id,l])=>[id,l,p=>id==='all'||p.filters.includes(id)]);
const st={f:'all',hide:false,q:''};
const MONO='parsleyhealth/parsley-monorepo';
const chip=p=>`<span class="chip m-${p.move}">${NAME[p.move]}${p.sub?' · '+esc(p.sub):''}</span>`;
function badges(p){
  const b=[];
  p.approvals.current.forEach(a=>b.push('✓ '+a));
  p.approvals.stale.forEach(a=>b.push(`✓ ${a} (stale)`));
  p.changes_requested.forEach(a=>b.push(`changes requested: ${a}`));
  const c={};p.unanswered.forEach(t=>c[t.label]=(c[t.label]||0)+1);
  const u=['substantive','unlabeled','minor'].filter(l=>c[l]).map(l=>`${c[l]} ${l}`);
  if(u.length)b.push(u.join(' · '));
  if(p.answered_open.length)b.push(`${p.answered_open.length} answered, open`);
  if(p.conflict)b.push('conflict');
  if(p.base_missing)b.push('base missing');
  if(p.ci.failing.length)b.push(`${p.ci.failing.length} failing check${p.ci.failing.length>1?'s':''}`);
  p.waiting_on.forEach(w=>b.push(`waiting ${w.reviewer}${w.days!=null?' · '+w.days+'d':''}`));
  p.gates.forEach(g=>b.push(g));
  const gated=p.gates.length&&p.move!=='gated'?'<span class="bdg gt">gated</span>':'';
  return gated+b.map(x=>`<span class="bdg">${esc(x)}</span>`).join('');
}
const thr=t=>`<li><a href="${esc(t.url)}">${esc(t.text)}</a> <span class="mu">— ${esc(t.author)}${t.is_bot?' <span class="bdg">bot</span>':''}${t.label?' · '+t.label:''} · ${esc(t.at.slice(0,10))}</span></li>`;
function more(p){
  let h='';
  if(p.unanswered.length)h+=`<h4>Unanswered threads</h4><ul>${p.unanswered.map(thr).join('')}</ul>`;
  if(p.answered_open.length)h+=`<h4>Answered, still open</h4><ul>${p.answered_open.map(thr).join('')}</ul>`;
  if(p.ci.failing.length)h+=`<h4>Failing checks</h4><ul>${p.ci.failing.map(c=>`<li>${c.url?`<a href="${esc(c.url)}">${esc(c.name)}</a>`:esc(c.name)}</li>`).join('')}</ul>`;
  if(p.ci.pending.length)h+=`<h4>Pending checks</h4><ul>${p.ci.pending.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`;
  if(p.gates.length)h+=`<h4>Gates</h4><ul>${p.gates.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>`;
  return h||'<p class="mu">No open threads, failing checks, or gates.</p>';
}
function row(k,g){
  const p=P[k],d=g.depth[k]||0,repo=p.repo===MONO?'':`<span class="mu">${esc(p.repo.split('/')[1])}</span>`;
  return `<li class="row" data-k="${esc(k)}" style="--d:${d}"><details class="pr"><summary>`+
   (d?'<span class="conn mu" aria-hidden="true">└</span>':'')+
   `<a class="num" href="${esc(p.url)}">#${p.number}</a><span class="ttl">${esc(p.short||p.title)}</span>${repo}${chip(p)}${badges(p)}`+
   `</summary><div class="more">${more(p)}</div></details></li>`;
}
function tally(g){const c={};g.keys.forEach(k=>c[P[k].move]=(c[P[k].move]||0)+1);
  return MOVES.filter(m=>c[m]).map(m=>`${c[m]} ${NAME[m]}`).join(' · ');}
$('groups').innerHTML=D.groups.map((g,i)=>`<details class="grp ${g.kind}" open data-g="${i}"><summary>`+
  `<span class="gname">${esc(g.name)}</span><span class="mu">${g.keys.length} PR${g.keys.length>1?'s':''}</span>`+
  `<span class="tally mu">${tally(g)}</span>`+
  (g.kind==='stack'?`<span class="order mu">${g.order.map(n=>'#'+n).join(' → ')}</span>`:'')+
  `</summary><ul class="rows">${g.keys.filter(k=>k in g.depth).map(k=>row(k,g)).join('')}</ul>`+
  `<ul class="rows extra">${g.keys.filter(k=>!(k in g.depth)).map(k=>row(k,g)).join('')}</ul></details>`).join('');
$('filters').innerHTML=FILTERS.map(([id,label])=>`<button type="button" data-f="${id}" aria-pressed="false">${label} <span class="n"></span></button>`).join('');
$('count').textContent=Object.keys(P).length;$('iso').textContent=D.fetched_at;
const searchOk=p=>{const q=st.q.trim().toLowerCase().replace(/^#/,'');
  return !q||String(p.number).startsWith(q)||p.title.toLowerCase().includes(q)||p.repo.toLowerCase().includes(q);};
const visibleGroups=()=>D.groups.filter(g=>!(st.hide&&g.kind==='standalone'));
function update(){
  const pool=visibleGroups().flatMap(g=>g.keys).map(k=>P[k]).filter(searchOk);
  FILTERS.forEach(([id,,f])=>{const b=$('filters').querySelector(`[data-f="${id}"]`);
    b.setAttribute('aria-pressed',st.f===id);b.lastChild.textContent=pool.filter(f).length;});
  const fn=FILTERS.find(f=>f[0]===st.f)[2], match=p=>fn(p)&&searchOk(p);
  let any=false;
  D.groups.forEach((g,i)=>{
    const el=document.querySelector(`[data-g="${i}"]`), hits=g.keys.filter(k=>match(P[k]));
    const show=hits.length>0&&!(st.hide&&g.kind==='standalone');
    el.hidden=!show; any=any||show;
    el.querySelectorAll('li.row').forEach(li=>{const m=hits.includes(li.dataset.k);
      li.hidden=!m&&!(li.dataset.k in g.depth); li.classList.toggle('ctx',!m);});
  });
  $('none').hidden=any;
}
$('filters').addEventListener('click',e=>{const b=e.target.closest('button');if(b){st.f=b.dataset.f;update();}});
$('hideStd').addEventListener('change',e=>{st.hide=e.target.checked;update();});
$('q').addEventListener('input',e=>{st.q=e.target.value;update();});
update();
})();
</script></body></html>
"""


def render(data):
    local = datetime.fromisoformat(data["fetched_at"]).astimezone().strftime("%a %b %-d, %-I:%M %p %Z")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    return TEMPLATE.replace("__LOCAL__", local).replace("__DATA__", payload)


def main(argv):
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else HERE
    raw_path = out / "raw.json"
    if "--offline" in argv:
        if not raw_path.exists():
            die("raw.json not found; run without --offline first")
        raw = json.loads(raw_path.read_text())
    else:
        raw = fetch()
        raw_path.write_text(json.dumps(raw, indent=1))
    data, stale = derive(raw, json.loads((HERE / "gates.json").read_text()))
    if stale:
        print(f"note: gates.json names PRs that are not open (ignored): {', '.join(stale)}")
    (out / "data.json").write_text(json.dumps(data, indent=1, ensure_ascii=False))
    (out / "board.html").write_text(render(data))
    counts = {}
    for p in data["prs"].values():
        counts[p["move"]] = counts.get(p["move"], 0) + 1
    print(f"{len(data['prs'])} open PRs in {len(data['groups'])} groups; next moves: "
          + ", ".join(f"{m} {counts[m]}" for m in MOVES if m in counts))


if __name__ == "__main__":
    main(sys.argv[1:])
