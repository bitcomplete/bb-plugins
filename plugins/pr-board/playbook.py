#!/usr/bin/env python3
"""Fill a playbook for one PR, after re-checking that its next move is still the one the user picked.

  python3 playbook.py --data data.json --key owner/repo#N --expect fix-feedback|rebase|fix-ci --stop prepare|publish

Prints JSON: {"ok": true, "title", "prompt", "head_oid", "move"} or {"ok": false, "reason"}.
"""
import json
import sys
from pathlib import Path
from string import Template

from simple import action_of, area, playbook_of, real_gates, title

HERE = Path(__file__).resolve().parent
BOOKS = HERE / "playbooks"
LABEL = {"fix-feedback": "Fix feedback", "rebase": "Rebase", "fix-ci": "Fix CI"}
STOPS = ("prepare", "publish")


def bullets(lines):
    return "\n".join(f"- {line}" for line in lines) or "- none recorded"


def facts(pr):
    """Template values for one derived PR (a data.json `prs` entry)."""
    return {
        "repo": pr["repo"], "repo_name": pr["repo"].split("/")[1], "number": pr["number"], "url": pr["url"],
        "short_title": title(pr), "branch": pr["head"], "base": pr["base"], "head_oid": pr["head_oid"],
        "area": area(pr), "gates": "; ".join(real_gates(pr)) or "none.",
        "threads": bullets(f"{t['author']} ({t['label']}): \"{t['text']}\" {t['url']}" for t in pr["unanswered"]),
        "checks": bullets(f"{c['name']}{' ' + c['url'] if c.get('url') else ''}" for c in pr["ci"]["failing"]),
        "conflict": ("its base branch no longer exists; the PR needs a new base." if pr["base_missing"]
                     else f"GitHub reports conflicts with `{pr['base']}`."),
    }


def render(pr, action, stop):
    """The thread prompt: the move's playbook, the stopping point, then the shared rules."""
    if action not in LABEL or stop not in STOPS:
        raise ValueError(f"unknown action {action!r} or stop {stop!r}")
    values = facts(pr)
    parts = [BOOKS / f"{action}.md", BOOKS / f"stop-{stop}.md", BOOKS / "common.md"]
    return "\n".join(Template(p.read_text()).substitute(values) for p in parts)


def thread_title(pr, action):
    return f"{LABEL[action]} PR {pr['number']} {title(pr)}"[:120]


def prepare(data, key, expect, stop):
    """Re-check the PR against fresh data; refuse with a reason when its move changed."""
    pr = data["prs"].get(key)
    if pr is None:
        return {"ok": False, "reason": "it is no longer open"}
    action, sentence = action_of(pr)
    if action is None and playbook_of(pr) == expect:
        return {"ok": False, "reason": "it is blocked by a known gate; nothing started"}
    if action != expect:
        now = LABEL.get(action, "no agent step")
        return {"ok": False, "reason": f"its next move changed to {now} ({sentence}); nothing started"}
    return {"ok": True, "title": thread_title(pr, action), "prompt": render(pr, action, stop),
            "head_oid": pr["head_oid"], "move": pr["move"]}


def main(argv):
    arg = lambda name: argv[argv.index(name) + 1]
    data = json.loads(Path(arg("--data")).read_text())
    print(json.dumps(prepare(data, arg("--key"), arg("--expect"), arg("--stop")), ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
