"""Derivation rules for the PR board. Run: TZ=UTC python3 -m unittest"""
import unittest
from datetime import datetime, timezone

import build as b

ME = "me"
NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)
REPO = "acme/mono"


def pr(number, head=None, base="main", **kw):
    p = {"repo": REPO, "default_branch": "main", "number": number, "title": f"PR {number}", "url": f"u/{number}",
         "draft": False, "base": base, "head": head or f"b{number}", "head_oid": "H", "mergeable": "MERGEABLE",
         "merge_state": "CLEAN", "labels": [], "requested": [], "reviews": [], "threads": [],
         "committed_at": "2026-11-10T00:00:00Z", "checks": []}
    p.update(kw)
    return p


def thread(*comments, resolved=False):
    return {"resolved": resolved, "outdated": False, "path": "f",
            "comments": [{"author": a, "body": body, "at": "2026-11-01T00:00:00Z", "url": "c"} for a, body in comments]}


def approved(by="rev", oid="H"):
    return {"author": by, "state": "APPROVED", "at": "2026-11-11T00:00:00Z", "oid": oid}


def check(name="t", status="COMPLETED", conclusion="SUCCESS"):
    return {"name": name, "status": status, "conclusion": conclusion, "state": None, "url": None}


def move(p, gates=(), info=None):
    f = b.pr_facts(p, ME, info or {"parent": None, "base_missing": False}, list(gates), NOW)
    return b.next_move(p, f)


class Stacks(unittest.TestCase):
    def test_children_follow_parents_and_siblings_sort_by_number(self):
        # 10 <- 12 <- 13, and 10 <- 11: depth-first, lower-numbered sibling first.
        prs = [pr(13, base="b12"), pr(12, base="b10"), pr(11, base="b10"), pr(10)]
        stacks, info = b.build_stacks(prs)
        self.assertEqual([[(p["number"], d) for p, d in s] for s in stacks], [[(10, 0), (11, 1), (12, 1), (13, 2)]])
        self.assertEqual(info[f"{REPO}#13"]["parent"], 12)

    def test_stacks_do_not_cross_repos(self):
        other = pr(5, base="b10", repo="acme/other")
        _, info = b.build_stacks([pr(10), other])
        self.assertIsNone(info["acme/other#5"]["parent"])

    def test_base_missing_when_base_is_neither_default_nor_an_open_head(self):
        # The parent merged and its branch is gone: the PR needs retargeting.
        _, info = b.build_stacks([pr(20, base="merged-branch"), pr(21)])
        self.assertTrue(info[f"{REPO}#20"]["base_missing"])
        self.assertFalse(info[f"{REPO}#21"]["base_missing"])

    def test_non_root_member_is_gated_on_its_parent(self):
        f = b.pr_facts(pr(12, base="b10"), ME, {"parent": 10, "base_missing": False}, [], NOW)
        self.assertIn("parent #10 not merged", f["gates"])


class Classify(unittest.TestCase):
    def test_labels(self):
        cases = {"**risk: x**": "substantive", "[P1 Should fix] y": "substantive", "Bug: z": "substantive",
                 "**Blocker** a": "substantive", "must fix": "substantive", "nit: a": "minor",
                 "**[P2 Improvement]** b": "minor", "[P3 Nitpick] c": "minor", "Question: why?": "minor",
                 "Suggestion - d": "minor", "**Possible PHI (not a bug).** e": "minor",
                 "Looks wrong to me": "unlabeled", "Bugfix needed": "unlabeled"}
        for body, want in cases.items():
            self.assertEqual(b.classify(body), want, body)


class Facts(unittest.TestCase):
    def test_threads_split_by_who_spoke_last(self):
        p = pr(1, threads=[thread(("rev", "nit: a")), thread(("rev", "bug: b"), (ME, "fixed")),
                           thread(("rev", "risk: c"), resolved=True)])
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual([t["label"] for t in f["unanswered"]], ["minor"])
        self.assertEqual(len(f["answered_open"]), 1)

    def test_label_comes_from_the_reviewers_first_comment(self):
        p = pr(1, threads=[thread(("rev", "risk: a"), ("rev", "also this"))])
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(f["unanswered"][0]["label"], "substantive")

    def test_excerpt_is_capped_at_140_characters(self):
        p = pr(1, threads=[thread(("rev", "x" * 300))])
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(len(f["unanswered"][0]["text"]), 141)  # 140 + ellipsis

    def test_approval_on_an_older_commit_is_stale(self):
        p = pr(1, reviews=[approved("a"), approved("b", oid="OLD")])
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(f["approvals"], {"current": ["a"], "stale": ["b"]})

    def test_cancelled_checks_are_ignored(self):
        ci = b.ci_facts([check("scope", conclusion="CANCELLED"), check("a", conclusion="TIMED_OUT"),
                         check("q", status="QUEUED", conclusion=None),
                         {"name": "s", "status": None, "conclusion": None, "state": "ERROR", "url": None}])
        self.assertEqual([c["name"] for c in ci["failing"]], ["a", "s"])
        self.assertEqual(ci["pending"], ["q"])

    def test_waiting_days_fall_back_to_last_commit_marked_approximate(self):
        f = b.pr_facts(pr(1, requested=["rev"]), ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(f["waiting_on"], [{"reviewer": "rev", "days": 3, "approx": True}])

    def test_waiting_days_count_from_the_latest_review_request(self):
        # A push does not reset how long a reviewer has been asked; the request event does.
        p = pr(1, requested=["rev"], requested_at={"rev": "2026-11-06T00:00:00Z"})
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(f["waiting_on"], [{"reviewer": "rev", "days": 7, "approx": False}])

    def test_requested_at_keeps_the_latest_event_per_reviewer(self):
        x = {"timelineItems": {"nodes": [
            {"createdAt": "2026-11-01T00:00:00Z", "requestedReviewer": {"__typename": "User", "login": "a"}},
            {"createdAt": "2026-11-05T00:00:00Z", "requestedReviewer": {"__typename": "User", "login": "a"}},
            {"createdAt": "2026-11-02T00:00:00Z", "requestedReviewer": {"__typename": "Team", "name": "Core"}},
            {"createdAt": "2026-11-03T00:00:00Z", "requestedReviewer": None}]}}
        self.assertEqual(b.requested_at(x), {"a": "2026-11-05T00:00:00Z", "Core": "2026-11-02T00:00:00Z"})


class NextMove(unittest.TestCase):
    """Each rule, plus the precedence that makes the first match win."""

    def test_draft_beats_everything(self):
        self.assertEqual(move(pr(1, draft=True, threads=[thread(("rev", "bug: x"))])), ("draft", None))

    def test_fix_for_substantive_or_unlabeled_threads(self):
        self.assertEqual(move(pr(1, threads=[thread(("rev", "risk: x"))]))[0], "fix")
        self.assertEqual(move(pr(1, threads=[thread(("rev", "hmm"))]))[0], "fix")

    def test_minor_threads_mean_reply_even_with_changes_requested(self):
        p = pr(1, threads=[thread(("rev", "nit: x"))], reviews=[{**approved(), "state": "CHANGES_REQUESTED"}])
        self.assertEqual(move(p)[0], "reply")

    def test_reply_when_only_minor_threads_remain(self):
        p = pr(1, threads=[thread(("rev", "nit: x"))], mergeable="CONFLICTING")
        self.assertEqual(move(p)[0], "reply")  # reply outranks the conflict

    def test_rebase_and_retarget(self):
        self.assertEqual(move(pr(1, merge_state="DIRTY")), ("rebase", None))
        self.assertEqual(move(pr(1), info={"parent": None, "base_missing": True}), ("rebase", "retarget"))

    def test_ci_failing(self):
        self.assertEqual(move(pr(1, checks=[check(conclusion="FAILURE")], reviews=[approved()]))[0], "ci")

    def test_review_only_without_approval_or_with_changes_requested(self):
        self.assertEqual(move(pr(1, requested=["rev"])), ("review", None))
        self.assertEqual(move(pr(1)), ("review", "no reviewer"))
        changes = {**approved(), "state": "CHANGES_REQUESTED"}
        self.assertEqual(move(pr(1, reviews=[approved("a"), changes])), ("review", "changes"))
        self.assertEqual(move(pr(1, review_decision="CHANGES_REQUESTED", reviews=[approved()])), ("review", "changes"))

    def test_an_approval_on_an_earlier_commit_still_counts(self):
        # Follow-up commits of any size do not need re-approval.
        self.assertEqual(move(pr(1, reviews=[approved(oid="OLD")], checks=[check()])), ("ready", None))

    def test_a_pending_second_reviewer_never_blocks_an_approved_pr(self):
        self.assertEqual(move(pr(1, requested=["x"], reviews=[approved()], checks=[check()])), ("ready", None))

    def test_bot_approvals_do_not_count(self):
        bot = {**approved("codex"), "is_bot": True}
        self.assertEqual(move(pr(1, reviews=[bot])), ("review", "no reviewer"))

    def test_gated_by_gate_or_answered_open_thread(self):
        gate = {"id": "g", "label": "wait for X", "repo": REPO, "prs": [1]}
        self.assertEqual(move(pr(1, reviews=[approved()]), gates=[gate])[0], "gated")
        p = pr(1, reviews=[approved()], threads=[thread(("rev", "nit"), (ME, "later"))])
        self.assertEqual(move(p)[0], "gated")
        self.assertEqual(move(pr(1, reviews=[approved()]), info={"parent": 9, "base_missing": False})[0], "gated")

    def test_ready(self):
        self.assertEqual(move(pr(1, reviews=[approved()], checks=[check()])), ("ready", None))

    def test_pending_ci_is_not_ready(self):
        p = pr(1, reviews=[approved()], checks=[check(status="IN_PROGRESS", conclusion=None)])
        self.assertEqual(move(p), ("ci", "pending"))


class Gates(unittest.TestCase):
    GATES = [{"id": "g1", "label": "L1", "repo": REPO, "prs": [1, 2, 99], "group": "Named"},
             {"id": "g2", "label": "L2", "repo": "acme/other", "prs": [1]}]

    def test_gate_applies_only_in_its_repo(self):
        f = b.pr_facts(pr(1), ME, {"parent": None, "base_missing": False}, self.GATES, NOW)
        self.assertEqual(f["gates"], ["L1"])

    def test_gate_naming_closed_pr_is_reported_stale(self):
        raw = {"login": ME, "fetched_at": NOW.isoformat(), "prs": []}
        _, stale = b.derive(raw, {"gates": self.GATES})
        self.assertIn("g1:#99", stale)

    def test_gate_group_pulls_singles_but_not_stack_members(self):
        prs = [pr(1, title="TK-1: a"), pr(2, base="b3"), pr(3), pr(4, title="TK-1: b"), pr(5, title="TK-1: c")]
        stacks, _ = b.build_stacks(prs)
        groups = {g["name"]: g["keys"] for g in b.build_groups(prs, stacks, self.GATES)}
        self.assertEqual(groups["Named"], [f"{REPO}#1"])          # #2 stays in its stack
        self.assertEqual(groups["PR 3"], [f"{REPO}#3", f"{REPO}#2"])  # stack named by root title
        self.assertEqual(groups["TK-1"], [f"{REPO}#4", f"{REPO}#5"])   # remaining ticket siblings


class Groups(unittest.TestCase):
    def test_ticket_from_branch_when_title_has_none(self):
        self.assertEqual(b.ticket_key(pr(1, head="matts/epd-42-thing")), "EPD-42")
        self.assertIsNone(b.ticket_key(pr(1, head="matts/it57-router-budget-20261105")))

    def test_lone_prs_fall_into_per_repo_standalone(self):
        prs = [pr(1), pr(2, title="X-9: only one")]
        stacks, _ = b.build_stacks(prs)
        groups = b.build_groups(prs, stacks, [])
        self.assertEqual([(g["name"], len(g["keys"])) for g in groups], [("Standalone · mono", 2)])

    def test_short_title_strips_group_ticket(self):
        self.assertEqual(b.short_title("EPD-1: feat: x", "EPD-1"), "feat: x")
        self.assertEqual(b.short_title("feat: x (EPD-1)", "EPD-1"), "feat: x")
        self.assertEqual(b.short_title("EPD-1: feat: x", "Some stack"), "EPD-1: feat: x")

    def test_singles_join_the_same_repo_stack_with_their_ticket(self):
        # One group per ticket: EPD-7 singles land after the EPD-7 stack, unindented, not in a second EPD-7 group.
        prs = [pr(10, title="EPD-7: root"), pr(11, base="b10", title="EPD-7: child"),
               pr(20, title="EPD-7: single"), pr(30, title="EPD-7: other repo", repo="acme/other"),
               pr(31, title="EPD-7: other repo too", repo="acme/other")]
        stacks, _ = b.build_stacks(prs)
        groups = b.build_groups(prs, stacks, [])
        self.assertEqual([(g["name"], g["kind"], g["keys"]) for g in groups if g["name"] == "EPD-7"],
                         [("EPD-7", "stack", [f"{REPO}#10", f"{REPO}#11", f"{REPO}#20"]),
                          ("EPD-7", "ticket", ["acme/other#30", "acme/other#31"])])
        stack = groups[0]
        self.assertEqual(stack["order"], [10, 11])
        self.assertNotIn(f"{REPO}#20", stack["depth"])


class ChangesRequested(unittest.TestCase):
    CR = {"author": "flasd", "state": "CHANGES_REQUESTED", "at": "2026-11-11T00:00:00Z", "oid": "OLD"}

    def test_outstanding_changes_request_is_never_ready(self):
        # Another reviewer's current approval does not clear flasd's request (#655 on 2026-11-13).
        p = pr(1, reviews=[approved("cstarner"), self.CR], checks=[check()])
        self.assertEqual(move(p), ("review", "changes"))
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertEqual(f["changes_requested"], ["flasd"])

    def test_review_decision_alone_also_blocks(self):
        self.assertEqual(move(pr(1, reviews=[approved()], review_decision="CHANGES_REQUESTED")), ("review", "changes"))

    def test_changes_request_with_only_minor_threads_is_reply(self):
        # The new rule: fix means substantive or unlabeled threads; minor-only threads are a reply.
        self.assertEqual(move(pr(1, reviews=[self.CR], threads=[thread(("flasd", "nit: x"))]))[0], "reply")


class Bots(unittest.TestCase):
    def test_codex_priority_badge_is_a_label(self):
        badge = "**<sub><sub>![P{0} Badge](https://img.shields.io/badge/P{0}-x)</sub></sub>  Fix it"
        self.assertEqual(b.classify(badge.format(1)), "substantive")
        self.assertEqual(b.classify(badge.format(0)), "substantive")
        self.assertEqual(b.classify(badge.format(2)), "minor")
        self.assertEqual(b.classify(badge.format(3)), "minor")

    def test_bot_detection_by_typename_or_suffix(self):
        self.assertTrue(b.is_bot({"__typename": "Bot", "login": "chatgpt-codex-connector"}))
        self.assertTrue(b.is_bot({"__typename": "User", "login": "renovate[bot]"}))
        self.assertFalse(b.is_bot({"__typename": "User", "login": "flasd"}))

    def test_bot_threads_are_flagged_and_still_count(self):
        t = thread(("codex", "**<sub><sub>![P1 Badge](u)</sub></sub> x"))
        t["comments"][0]["is_bot"] = True
        p = pr(1, threads=[t])
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, [], NOW)
        self.assertTrue(f["unanswered"][0]["is_bot"])
        self.assertEqual(b.next_move(p, f)[0], "fix")


class Filters(unittest.TestCase):
    def derived(self, p, gates=()):
        f = b.pr_facts(p, ME, {"parent": None, "base_missing": False}, list(gates), NOW)
        move, sub = b.next_move(p, f)
        return b.pr_filters({**f, "move": move})

    def test_gated_filter_follows_facts_not_the_winning_move(self):
        # A gated PR with a conflict wins "rebase" but must still appear under "Gated".
        gate = {"id": "g", "label": "L", "repo": REPO, "prs": [1]}
        fl = self.derived(pr(1, mergeable="CONFLICTING"), [gate])
        self.assertIn("gated", fl)
        self.assertIn("gated", self.derived(pr(1, threads=[thread(("rev", "nit"), (ME, "later"))])))
        self.assertNotIn("gated", self.derived(pr(1)))

    def test_needs_fix_includes_reply(self):
        self.assertIn("fix", self.derived(pr(1, threads=[thread(("rev", "nit: x"))])))
        self.assertIn("fix", self.derived(pr(1, threads=[thread(("rev", "bug: x"))])))

    def test_review_ready_draft_follow_the_move(self):
        self.assertEqual(self.derived(pr(1, requested=["x"])), ["review"])
        self.assertEqual(self.derived(pr(1, reviews=[approved()])), ["ready"])
        self.assertEqual(self.derived(pr(1, draft=True)), ["draft"])


if __name__ == "__main__":
    unittest.main()
