"""Plain-language view of data.json: what needs you, who you wait on, what can merge.

  python3 simple.py                  write simple.html next to this file
  python3 simple.py --json           print the view model the bb panel renders
  --data PATH                        read data.json from PATH (default: this directory)
"""
import html
import json
import re
import math
import sys
import zlib
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
NAMES = {"flasd": "Marcel", "SirPedr": "Pedro", "shehabPH": "Shehab",
         "adriana-penaranda": "Adriana", "SeanPCarter": "Sean", "jakeorr": "Jake"}
WORK_ORG = "parsleyhealth/"


def name(login):
    return NAMES.get(login, login)


def names(logins):
    return " and ".join(sorted({name(x) for x in logins})) or "a reviewer"


def title(pr):
    t = re.sub(r"^\s*[A-Z][A-Z0-9]+-\d+:\s*", "", pr["title"])
    t = re.sub(r"^\w+(\([^)]*\))?!?:\s*", "", t)
    t = re.sub(r"\s*\([A-Z][A-Z0-9]+-\d+\)\s*$", "", t)
    return t[:1].upper() + t[1:]


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def your_move(pr):
    """Return (bucket, sentence) when the next step is the author's, else None."""
    move = pr["move"]
    todo = pr["unanswered"]
    big = [t for t in todo if t["label"] != "minor"]
    small = [t for t in todo if t["label"] == "minor"]
    who = names(t["author"] for t in todo)
    if move == "fix":
        s = f"{plural(len(big), 'issue')} to fix from {who}"
        if small:
            s += f", plus {plural(len(small), 'small comment')}"
        return "Fix review feedback", s
    if move == "reply":
        return "Fix review feedback", f"{plural(len(small), 'small comment')} to answer from {who}"
    if move == "rebase":
        if pr["base_missing"]:
            return "Rebase", "its base branch is gone; point it at main"
        return "Rebase", "conflicts with main"
    if move == "ci":
        n = len(pr["ci"]["failing"])
        s = f"{plural(n, 'check')} failing" if n else "checks still running"
        return "Fix CI", s
    if not pr["waiting_on"]:  # nobody is asked, so asking is the author's move, gated or not
        if pr["changes_outstanding"] and pr["changes_requested"]:
            return "Ask for a review", f"{name(pr['changes_requested'][0])} asked for changes; ask them to look again"
        if pr["approvals"]["stale"]:
            return "Ask for a review", f"{names(pr['approvals']['stale'])} approved an older version; ask for another look"
        return "Ask for a review", "nobody is asked to review it"
    return None


def waiting(pr):
    """Return (person, sentence) for a PR waiting on a requested reviewer."""
    asked = [w["reviewer"] for w in pr["waiting_on"]]
    days = max(w["days"] or 0 for w in pr["waiting_on"])
    age = f" · {plural(days, 'day')}" if days else ""
    if pr["changes_outstanding"] and pr["changes_requested"]:
        return name(pr["changes_requested"][0]), "asked for changes; needs to look again" + age
    stale = pr["approvals"]["stale"]
    if stale:
        who = next((a for a in asked if a in stale), asked[0])
        return name(who), "approved an older version; needs to look again" + age
    return name(asked[0]), "first review" + age


def place(pr):
    """(bucket, sub-group, sentence): bucket is ready, mine, theirs or drafts."""
    if pr["move"] == "ready":
        return "ready", None, "approved, checks green, no open comments"
    if pr["move"] == "draft":
        return "drafts", None, "draft"
    if (m := your_move(pr)):
        return "mine", m[0], m[1]
    person, sentence = waiting(pr)
    return "theirs", person, sentence


MONOREPO = "parsleyhealth/parsley-monorepo"
TONES = 6  # area colours; the frontend and HTML map 0..TONES-1 onto muted hues


def area(pr):
    """Where a PR lives: the monorepo's service/app label(s), else the repository's short name."""
    if pr["repo"] != MONOREPO:
        return pr["repo"].split("/")[1]
    parts = sorted(l.split(":", 1)[1] for l in pr.get("labels", []) if l.startswith(("service:", "app:")))
    if not parts:
        return "root"
    return parts[0] + (f" +{len(parts) - 1}" if len(parts) > 1 else "")


def tone(area_name):
    """Stable colour slot for an area, keyed on its first name so "sage +1" matches "sage"."""
    return zlib.crc32(area_name.split(" +")[0].encode()) % TONES


def key(pr):
    return f"{pr['repo']}#{pr['number']}"


def parent_key(pr):
    return f"{pr['repo']}#{pr['parent']}" if pr.get("parent") else None


def nest(items, ctx):
    """Order one sub-group's (pr, sentence) items: stacks parent-first with depth, then standalone PRs by number.

    A PR whose open parent sits in another group stays here and points at it with `after`."""
    here = {key(p) for p, _ in items}
    children = defaultdict(list)
    roots = []
    for p, sentence in items:
        if parent_key(p) in here:
            children[parent_key(p)].append((p, sentence))
        else:
            roots.append((p, sentence))
    roots.sort(key=lambda it: (not children[key(it[0])], it[0]["number"]))
    rows = []

    def walk(item, depth):
        p, sentence = item
        parent = ctx["by_key"].get(parent_key(p))
        after = {"number": parent["number"], "url": parent["url"]} if parent and depth == 0 else None
        rows.append(vm_row(p, sentence, ctx, depth, after))
        for child in sorted(children[key(p)], key=lambda it: it[0]["number"]):
            walk(child, depth + 1)

    for item in roots:
        walk(item, 0)
    return rows


def real_gates(pr):
    """Gates from gates.json; the stack-parent gate is left out because nesting and `after` already say it."""
    stack_gate = f"parent #{pr.get('parent')} not merged"
    return [g for g in pr["gates"] if g != stack_gate]


REVIEW_RANK = {"approved": 0, "changes": 1, "approved_old": 2, "requested": 3}


def reviewers(pr):
    """Everyone asked or who has reviewed, by first name, with their strongest state on this PR."""
    states = {}

    def put(login, state):
        if login not in states or REVIEW_RANK[state] < REVIEW_RANK[states[login]]:
            states[login] = state

    for w in pr["waiting_on"]:
        put(w["reviewer"], "requested")
    for login in pr["approvals"]["current"]:
        put(login, "approved")
    for login in pr["approvals"]["stale"]:
        put(login, "approved_old")
    for login in pr["changes_requested"]:
        put(login, "changes")
    return [{"name": name(login), "state": st} for login, st in sorted(states.items(), key=lambda kv: name(kv[0]))]


def lines_of(pr):
    return pr.get("additions", 0) + pr.get("deletions", 0)


def short_count(n):
    return str(n) if n < 1000 else f"{n / 1000:.1f}".rstrip("0").rstrip(".") + "k"


def size(pr, max_lines):
    """Lines changed and files, with a log-scaled bar (0..1) against the board's largest PR."""
    lines, files = lines_of(pr), pr.get("changed_files", 0)
    bar = math.log10(lines + 1) / math.log10(max_lines + 1) if max_lines else 0
    return {"lines": lines, "files": files, "bar": round(bar, 3),
            "label": f"{short_count(lines)} {'line' if lines == 1 else 'lines'} · {plural(files, 'file')}"}


ACTIONS = {"Fix review feedback": "fix-feedback", "Rebase": "rebase", "Fix CI": "fix-ci"}


def action_of(pr):
    """(action, sentence): the agent playbook that fits this PR's move, or (None, sentence)."""
    bucket, group, sentence = place(pr)
    action = ACTIONS.get(group) if bucket == "mine" and pr["repo"].startswith(WORK_ORG) else None
    if action == "fix-ci" and not pr["ci"]["failing"]:
        action = None  # checks still running: nothing to fix yet
    return action, sentence


def vm_row(pr, sentence, ctx, depth=0, after=None):
    a = area(pr)
    return {"key": key(pr), "number": pr["number"], "url": pr["url"], "area": a, "tone": tone(a),
            "title": title(pr), "sentence": sentence, "blocked": "; ".join(real_gates(pr)) or None,
            "depth": depth, "after": after, "reviewers": reviewers(pr), "size": size(pr, ctx["max_lines"]),
            "stack": ctx["stack_of"].get(key(pr)), "action": action_of(pr)[0]}


MINE_ORDER = ["Fix review feedback", "Fix CI", "Rebase", "Ask for a review"]


def buckets(prs):
    """{bucket: {sub-group: [(pr, sentence)]}} in board order."""
    out = {b: defaultdict(list) for b in ("ready", "mine", "theirs", "drafts")}
    for pr in prs:
        b, g, sentence = place(pr)
        out[b][g].append((pr, sentence))
    out["mine"] = {k: out["mine"][k] for k in MINE_ORDER if out["mine"][k]}
    out["theirs"] = dict(sorted(out["theirs"].items(), key=lambda kv: -len(kv[1])))
    return out


def view_model(data, busy=()):
    """The board as plain data: every bucket, sentence, nesting and suggestion is decided here.

    `busy` holds the keys of PRs an agent thread is already working on; suggestions skip them."""
    prs = sorted(data["prs"].values(), key=lambda p: (p["repo"], p["number"]))
    work = [p for p in prs if p["repo"].startswith(WORK_ORG)]
    other = [p for p in prs if not p["repo"].startswith(WORK_ORG)]
    trains = build_trains(data, work)
    ctx = {"by_key": {key(p): p for p in prs}, "max_lines": max((lines_of(p) for p in prs), default=0),
           "stack_of": {k["key"]: t["id"] for t in trains for k in t["prs"]}}

    def groups(subgroups, label=lambda g: g):
        return [{"title": label(g), "rows": nest(items, ctx)} for g, items in subgroups.items()]

    def section(id_, heading, gs, open_=True):
        return {"id": id_, "title": heading, "count": sum(len(g["rows"]) for g in gs), "open": open_, "groups": gs}

    w, o = buckets(work), buckets(other)
    other_groups = (groups(o["ready"], lambda _: "Ready to merge")
                    + groups(o["mine"], lambda g: f"Needs you: {g}")
                    + groups(o["theirs"], lambda g: f"Waiting on {g}")
                    + groups(o["drafts"], lambda _: "Drafts"))
    sections = [
        section("ready", "Ready to merge", groups(w["ready"])),
        section("mine", "Needs you", groups(w["mine"])),
        section("theirs", "Waiting on a reviewer", groups(w["theirs"])),
        section("drafts", "Drafts", groups(w["drafts"]), open_=False),
        section("other", "Other repositories", other_groups, open_=False),
    ]
    sections = [s for s in sections if s["count"]]
    count = {s["id"]: s["count"] for s in sections}
    return {"fetched_at": data["fetched_at"],
            "summary": {"work": len(work), "ready": count.get("ready", 0), "mine": count.get("mine", 0),
                        "theirs": count.get("theirs", 0), "drafts": count.get("drafts", 0),
                        "other": count.get("other", 0)},
            "suggestions": suggestions(w, set(busy)), "trains": trains, "sections": sections,
            "reviewer_load": reviewer_load(w)}


# ---------------------------------------------------------------- trains, suggestions, reviewer load

LETTERS = {"ready": ("✓", "ready"), "drafts": ("D", "draft"), "theirs": ("W", "waiting on reviewer"),
           "Fix review feedback": ("F", "fix feedback"), "Fix CI": ("C", "fix CI"), "Rebase": ("R", "rebase"),
           "Ask for a review": ("A", "ask for review")}
LEGEND = [{"letter": l, "label": t} for l, t in
          [LETTERS[k] for k in ["Fix review feedback", "Fix CI", "Rebase", "Ask for a review", "theirs", "ready", "drafts"]]]


def letter(pr):
    bucket, group, _ = place(pr)
    return LETTERS[group if bucket == "mine" else bucket]


def build_trains(data, work):
    """One train per Parsley stack of 2+ open PRs, in merge order (parent first)."""
    by_key = {key(p): p for p in work}
    trains = []
    for g in data.get("groups", []):
        if g["kind"] != "stack" or not g["repo"].startswith(WORK_ORG):
            continue
        members = [by_key[f"{g['repo']}#{n}"] for n in g["order"] if f"{g['repo']}#{n}" in by_key]
        if len(members) < 2:
            continue
        root = title(members[0])
        name_ = f"{g['name']} · {root}" if re.fullmatch(r"[A-Z][A-Z0-9]+-\d+", g["name"]) else root
        trains.append({"id": f"{g['repo']}#{members[0]['number']}", "name": name_, "prs": [
            {"key": key(p), "number": p["number"], "url": p["url"], "letter": letter(p)[0], "state": letter(p)[1],
             "title": title(p), "sentence": place(p)[2]} for p in members]})
    return trains


def numbers(prs, limit=6):
    shown = ", ".join(f"#{p['number']}" for p in prs[:limit])
    return shown + (f" and {len(prs) - limit} more" if len(prs) > limit else "")


def suggestions(w, busy, limit=5):
    """Up to `limit` batched next steps, most valuable first. Agent-actionable ones carry `action` and `keys`.

    Skips PRs an agent is already on; leaves gate-blocked PRs out of actionable counts and says so."""
    out = []

    def free(items):
        return [p for p, _ in items if key(p) not in busy]

    ready = free(w["ready"][None]) if None in w["ready"] else []
    if ready:
        out.append({"id": "ready", "text": f"{plural(len(ready), 'PR')} {'is' if len(ready) == 1 else 'are'} "
                                           f"ready to merge ({numbers(ready)})", "action": None, "keys": []})
    verbs = {"fix-feedback": ("Fix review feedback on", "Fix review feedback"),
             "rebase": ("Rebase", "Rebase"), "fix-ci": ("Fix CI on", "Fix CI")}
    for action, (verb, group) in verbs.items():
        prs = [p for p in free(w["mine"].get(group, [])) if action_of(p)[0] == action]
        if not prs:
            continue
        gated = [p for p in prs if real_gates(p)]
        ok = [p for p in prs if not real_gates(p)]
        noun = plural(len(prs), "PR") + (" that conflict with main" if action == "rebase" else "")
        text = f"{verb} {noun}"
        if gated:
            text += (f"; {len(gated)} {'is' if len(gated) == 1 else 'are'} blocked by a known gate, so "
                     f"{len(ok)} {'is' if len(ok) == 1 else 'are'} actionable")
        text += f" ({numbers(ok)})" if ok else ""
        out.append({"id": action, "text": text, "action": action if ok else None, "keys": [key(p) for p in ok]})
    asks = free(w["mine"].get("Ask for a review", []))
    again = defaultdict(list)
    for p in asks:
        who = (pr_changes := p["changes_requested"]) and p["changes_outstanding"] and pr_changes
        for login in (who or p["approvals"]["stale"]):
            again[name(login)].append(p)
    if again:
        people = sorted(again.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        n = len({key(p) for ps in again.values() for p in ps})
        out.append({"id": "re-request", "action": None, "keys": [],
                    "text": f"Ask for another look at {plural(n, 'PR')} reviewed before your changes: "
                            + ", ".join(f"{who} ({numbers(ps, 4)})" for who, ps in people)})
    nobody = [p for p in asks if not p["changes_requested"] and not p["approvals"]["stale"]]
    if nobody:
        out.append({"id": "pick-reviewers", "action": None, "keys": [],
                    "text": f"Pick reviewers for {plural(len(nobody), 'PR')} with nobody asked ({numbers(nobody)})"})
    return out[:limit]


def reviewer_load(w):
    """Per requested reviewer on PRs waiting on review: first vs re-review, count, oldest wait in days."""
    load = defaultdict(lambda: {"first": 0, "re": 0, "oldest_days": 0, "approx": False, "keys": []})
    for items in w["theirs"].values():
        for p, _ in items:
            again = set(p["approvals"]["stale"]) | set(p["changes_requested"])
            for wt in p["waiting_on"]:
                r = load[name(wt["reviewer"])]
                r["re" if wt["reviewer"] in again else "first"] += 1
                r["keys"].append(key(p))
                days = wt["days"] or 0
                if len(r["keys"]) == 1 or days > r["oldest_days"]:
                    r["oldest_days"], r["approx"] = days, wt.get("approx", False)
    rows = [{"name": n, "count": v["first"] + v["re"], **v} for n, v in load.items()]
    rows.sort(key=lambda r: (-r["count"], r["name"]))
    nobody = [p for p, _ in w["mine"].get("Ask for a review", []) if not p["waiting_on"]]
    return {"reviewers": rows, "none": {"count": len(nobody), "keys": [key(p) for p in nobody]}}


# ---------------------------------------------------------------- HTML (draws the view model)

def html_row(r):
    blocked = f'<div class="blocked">Blocked by: {html.escape(r["blocked"])}</div>' if r["blocked"] else ""
    conn = '<span class="conn">└</span>' if r["depth"] else ""
    after = (f'<span class="after">after <a href="{html.escape(r["after"]["url"])}" target="_blank">'
             f'#{r["after"]["number"]}</a></span>') if r["after"] else ""
    return (f'<li style="--d:{r["depth"]}"><div class="line">{conn}'
            f'<a class="num" href="{html.escape(r["url"])}" target="_blank">#{r["number"]}</a>'
            f'<span class="body"><span class="t">{html.escape(r["title"])}</span>'
            f'<span class="s"> — {html.escape(r["sentence"])}</span></span>{after}'
            f'<span class="area tone{r["tone"]}" title="{html.escape(r["area"])}">{html.escape(r["area"])}</span></div>'
            f'{blocked}</li>')


def html_group(g):
    rows = f'<ul>{"".join(html_row(r) for r in g["rows"])}</ul>'
    if g["title"] is None:
        return rows
    return f'<h3>{html.escape(g["title"])} <span class="n">{len(g["rows"])}</span></h3>{rows}'


def html_section(s):
    return (f'<details{" open" if s["open"] else ""}><summary><h2>{html.escape(s["title"])}</h2>'
            f'<span class="n">{s["count"]}</span></summary>{"".join(html_group(g) for g in s["groups"])}</details>')


def render_html(vm):
    n = vm["summary"]
    return TEMPLATE.replace("{{BODY}}", (
        f'<p class="lead"><b>{n["work"]}</b> open Parsley PRs: <b>{n["ready"]}</b> can merge, '
        f'<b>{n["mine"]}</b> need you, <b>{n["theirs"]}</b> wait on a reviewer, <b>{n["drafts"]}</b> are drafts.</p>'
        + "".join(html_section(s) for s in vm["sections"])
        + f'<p class="foot">As of {html.escape(vm["fetched_at"])}</p>'))


def main(argv):
    data_path = Path(argv[argv.index("--data") + 1]) if "--data" in argv else HERE / "data.json"
    busy = json.loads(argv[argv.index("--busy") + 1]) if "--busy" in argv else []
    vm = view_model(json.loads(data_path.read_text()), busy)
    if "--json" in argv:
        print(json.dumps(vm, ensure_ascii=False))
        return
    (HERE / "simple.html").write_text(render_html(vm))
    print(" ".join(f"{k}={v}" for k, v in vm["summary"].items()))


TEMPLATE = """<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>
body{font:14px/1.5 var(--font-sans,system-ui,sans-serif);color:var(--foreground,CanvasText);margin:0}
.lead{font-size:15px;margin:0 0 14px}
details{border-top:1px solid var(--border,#8884);padding:10px 0}
summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:8px}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted-foreground,#888);font-size:11px}
details[open]>summary::before{content:"▾"}
h2{font-size:16px;margin:0;display:inline}
h3{font-size:13px;margin:14px 0 4px;color:var(--muted-foreground,#888);font-weight:600}
.n{color:var(--muted-foreground,#888);font-weight:400}
ul{list-style:none;margin:0;padding:0}
li{padding:5px 0 5px calc(var(--d,0)*16px)}
.line{display:flex;align-items:baseline;gap:4px}
.conn{color:var(--muted-foreground,#888);width:14px;margin-left:-16px;text-align:right;flex:none}
a.num{flex:none;width:40px;color:var(--brand,LinkText);text-decoration:none;font-family:var(--font-mono,monospace);font-size:12.5px}
a:hover{text-decoration:underline}
.body{flex:1;min-width:0;overflow-wrap:anywhere}
.s,.foot,.after,.after a{color:var(--muted-foreground,#888)}
.after{flex:none;font-size:12px}
.area{flex:none;width:84px;text-align:right;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tone0{color:#6a9fd8}.tone1{color:#a98bd6}.tone2{color:#5fae8a}.tone3{color:#c8a24a}.tone4{color:#d08a5c}.tone5{color:#5aaab5}
.blocked{margin-left:44px;font-size:12.5px;color:var(--warning-text,#b7791f)}
.foot{font-size:12px;margin:10px 0 0}
</style>
{{BODY}}
"""

if __name__ == "__main__":
    main(sys.argv[1:])
