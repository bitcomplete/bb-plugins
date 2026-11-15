"""View-model tests: which section and sub-group each PR lands in, and the sentence it gets.

The bb panel draws this view model verbatim, so these tests pin the board's wording and grouping.
Run: TZ=UTC python3 -m unittest
"""
import unittest

import simple as s

MONO = "parsleyhealth/parsley-monorepo"


def pr(number, move, sub=None, repo=MONO, **facts):
    """A derived PR as build.py writes it to data.json, with neutral facts unless overridden."""
    base = {"number": number, "title": f"EPD-1: feat(x): change {number}", "repo": repo,
            "url": f"https://github.com/{repo}/pull/{number}", "draft": move == "draft", "move": move, "sub": sub,
            "unanswered": [], "answered_open": [], "approvals": {"current": [], "stale": []},
            "changes_requested": [], "changes_outstanding": False, "conflict": False, "base_missing": False,
            "ci": {"failing": [], "pending": []}, "waiting_on": [], "gates": [], "labels": [], "parent": None,
            "head": f"b{number}", "head_oid": "abc123", "base": "main", "additions": 10, "deletions": 2,
            "changed_files": 1}
    base.update(facts)
    base.setdefault("approved_by", base["approvals"]["current"] + base["approvals"]["stale"])
    return base


def thread(author, label):
    return {"author": author, "label": label, "text": "please fix", "url": "https://github.com/c/1"}


def board(*prs, groups=(), busy=()):
    data = {"fetched_at": "2026-11-13T12:00:00+00:00", "prs": {f"{p['repo']}#{p['number']}": p for p in prs},
            "groups": list(groups)}
    return s.view_model(data, busy)


def placed(vm, number):
    """(section id, group title, row) for one PR number."""
    for section in vm["sections"]:
        for group in section["groups"]:
            for row in group["rows"]:
                if row["number"] == number:
                    return section["id"], group["title"], row
    raise AssertionError(f"#{number} not on the board")


class Buckets(unittest.TestCase):
    def test_ready_pr_names_its_approvers_even_when_they_approved_an_earlier_commit(self):
        p = pr(1, "ready", approvals={"current": ["jakeorr"], "stale": ["flasd"]})
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"]),
                         ("ready", None, "approved by Jake and Marcel, checks green, no open comments"))

    def test_draft_goes_to_drafts_collapsed(self):
        vm = board(pr(1, "draft"))
        self.assertEqual(placed(vm, 1)[:2], ("drafts", None))
        self.assertFalse(vm["sections"][0]["open"])

    def test_fix_counts_issues_and_small_comments_by_reviewer(self):
        p = pr(1, "fix", unanswered=[thread("flasd", "substantive"), thread("flasd", "unlabeled"),
                                     thread("jakeorr", "minor")])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp), ("mine", "Fix review feedback"))
        self.assertEqual(row["sentence"], "2 issues to fix from Jake and Marcel, plus 1 small comment")

    def test_fix_without_small_comments_has_no_plus_clause(self):
        p = pr(1, "fix", unanswered=[thread("flasd", "substantive")])
        self.assertEqual(placed(board(p), 1)[2]["sentence"], "1 issue to fix from Marcel")

    def test_reply_is_review_feedback_with_small_comments(self):
        p = pr(1, "reply", unanswered=[thread("someone", "minor"), thread("someone", "minor")])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"]), ("mine", "Fix review feedback", "2 small comments to answer from someone"))

    def test_rebase_conflict_and_missing_base_say_different_things(self):
        vm = board(pr(1, "rebase"), pr(2, "rebase", "retarget", base_missing=True))
        self.assertEqual(placed(vm, 1)[:2], ("mine", "Rebase"))
        self.assertEqual(placed(vm, 1)[2]["sentence"], "conflicts with main")
        self.assertEqual(placed(vm, 2)[2]["sentence"], "its base branch is gone; point it at main")

    def test_ci_failing_needs_you_and_pending_on_an_approved_pr_is_held(self):
        vm = board(pr(1, "ci", ci={"failing": [{"name": "a"}, {"name": "b"}], "pending": []}),
                   pr(2, "ci", "pending", ci={"failing": [], "pending": ["a"]}, approved_by=["flasd"]))
        self.assertEqual(placed(vm, 1)[:2], ("mine", "Fix CI"))
        self.assertEqual(placed(vm, 1)[2]["sentence"], "2 checks failing")
        self.assertEqual(placed(vm, 2)[:2], ("held", "Checks running"))
        self.assertEqual(placed(vm, 2)[2]["sentence"], "approved; checks still running")

    def test_no_reviewer_asks_you_to_request_one(self):
        sec, grp, row = placed(board(pr(1, "review", "no reviewer")), 1)
        self.assertEqual((sec, grp, row["sentence"]), ("mine", "Ask for a review", "nobody is asked to review it"))

    def test_first_review_waits_on_the_requested_reviewer_with_age(self):
        p = pr(1, "review", waiting_on=[{"reviewer": "flasd", "days": 3}])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"]), ("theirs", "Marcel", "first review · 3 days"))

    def test_changes_requested_waits_on_that_reviewer_to_look_again(self):
        p = pr(1, "review", "re-review", changes_outstanding=True, changes_requested=["SirPedr"],
               waiting_on=[{"reviewer": "SirPedr", "days": 1}])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"]),
                         ("theirs", "Pedro", "Pedro asked for changes; needs to look again · 1 day"))

    def test_changes_requested_by_someone_not_asked_again_means_you_re_request_them(self):
        p = pr(1, "review", "changes", changes_outstanding=True, changes_requested=["SirPedr"])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"]), ("mine", "Ask for a review", "re-request Pedro, who asked for changes"))

    def test_no_approval_and_nobody_asked_is_yours_even_with_a_gate(self):
        p = pr(1, "review", "no reviewer", gates=["Sage migration order"])
        sec, grp, row = placed(board(p), 1)
        self.assertEqual((sec, grp, row["sentence"], row["blocked"]),
                         ("mine", "Ask for a review", "nobody is asked to review it", "Sage migration order"))

    def test_approved_but_held_says_what_holds_it(self):
        # An approval on any commit is enough; a second pending request never makes it "waiting".
        approved = {"approved_by": ["flasd"], "waiting_on": [{"reviewer": "jakeorr", "days": 2}]}
        vm = board(pr(1, "gated", gates=["Sage migration order"], **approved),
                   pr(2, "gated", answered_open=[{}, {}], **approved),
                   pr(3, "gated", parent=9, gates=["parent #9 not merged"], **approved),
                   pr(4, "gated", answered_open=[{}], **approved))
        held = next(x for x in vm["sections"] if x["id"] == "held")
        self.assertEqual((held["title"], [g["title"] for g in held["groups"]]),
                         ("Approved, not ready yet", ["Blocked by a gate", "Waits for its parent", "Open threads you answered"]))
        self.assertEqual(placed(vm, 1)[2]["sentence"], "approved; blocked by a gate")
        self.assertEqual(placed(vm, 2)[2]["sentence"], "approved; 2 open threads you answered still owe something")
        self.assertEqual(placed(vm, 4)[2]["sentence"], "approved; 1 open thread you answered still owes something")
        self.assertEqual(placed(vm, 3)[2]["sentence"], "approved; merges after #9")
        self.assertNotIn("theirs", [x["id"] for x in vm["sections"]])
        self.assertEqual(vm["summary"]["held"], 4)

    def test_other_orgs_get_the_same_sentences_subgrouped_inside_one_collapsed_section(self):
        vm = board(pr(1, "review", repo="me/side", waiting_on=[{"reviewer": "flasd", "days": 2}]),
                   pr(2, "rebase", repo="me/side"), pr(3, "ready", repo="me/side"), pr(4, "draft", repo="me/side"))
        self.assertEqual([s["id"] for s in vm["sections"]], ["other"])
        self.assertFalse(vm["sections"][0]["open"])
        self.assertEqual([g["title"] for g in vm["sections"][0]["groups"]],
                         ["Ready to merge", "Needs you: Rebase", "Waiting on Marcel", "Drafts"])
        self.assertEqual(placed(vm, 1)[2]["sentence"], "first review · 2 days")
        self.assertEqual(placed(vm, 2)[2]["sentence"], "conflicts with main")
        self.assertEqual(vm["summary"]["work"], 0)


class Shape(unittest.TestCase):
    def test_rows_carry_cleaned_title_url_area_and_real_gates_only(self):
        p = pr(7, "ready", labels=["service:sage"], parent=6, gates=["Sage migration order", "parent #6 not merged"])
        row = placed(board(p), 7)[2]  # parent #6 is not open here, so no `after` either
        self.assertEqual(row, {"number": 7, "url": f"https://github.com/{MONO}/pull/7", "area": "sage",
                               "tone": s.tone("sage"), "title": "Change 7", "gate_blocked": False,
                               "sentence": "approved by a reviewer, checks green, no open comments",
                               "blocked": "Sage migration order", "depth": 0, "after": None,
                               "key": f"{MONO}#7", "reviewers": [], "stack": None, "action": None,
                               "size": {"lines": 12, "files": 1, "bar": 1.0, "label": "12 lines · 1 file"}})

    def test_stack_parent_gate_alone_leaves_no_blocked_line(self):
        vm = board(pr(6, "ready"), pr(7, "ready", parent=6, gates=["parent #6 not merged"]))
        self.assertIsNone(placed(vm, 7)[2]["blocked"])

    def test_needs_you_groups_follow_fixed_order_and_empty_sections_drop(self):
        vm = board(pr(1, "review", "no reviewer"), pr(2, "rebase"), pr(3, "ci", ci={"failing": [{}], "pending": []}),
                   pr(4, "fix", unanswered=[thread("a", "substantive")]))
        self.assertEqual([s["id"] for s in vm["sections"]], ["mine"])
        self.assertEqual([g["title"] for g in vm["sections"][0]["groups"]],
                         ["Fix review feedback", "Fix CI", "Rebase", "Ask for a review"])

    def test_reviewer_groups_sort_by_size_and_summary_counts_match(self):
        vm = board(pr(1, "review", waiting_on=[{"reviewer": "jakeorr", "days": 0}]),
                   pr(2, "review", waiting_on=[{"reviewer": "flasd", "days": 0}]),
                   pr(3, "review", waiting_on=[{"reviewer": "flasd", "days": 0}]),
                   pr(4, "ready"), pr(5, "draft"), pr(6, "ready", repo="me/x"))
        theirs = next(s for s in vm["sections"] if s["id"] == "theirs")
        self.assertEqual([(g["title"], len(g["rows"])) for g in theirs["groups"]], [("Marcel", 2), ("Jake", 1)])
        self.assertEqual(vm["summary"], {"work": 5, "ready": 1, "held": 0, "mine": 0, "theirs": 3, "drafts": 1, "other": 1})
        self.assertEqual([(s["id"], s["count"], s["open"]) for s in vm["sections"]],
                         [("ready", 1, True), ("theirs", 3, True), ("drafts", 1, False), ("other", 1, False)])


class Area(unittest.TestCase):
    def area(self, labels, repo=MONO):
        return s.area(pr(1, "ready", repo=repo, labels=labels))

    def test_one_service_or_app_label_names_the_area(self):
        self.assertEqual(self.area(["Needs Review", "root", "service:sage"]), "sage")
        self.assertEqual(self.area(["app:marketing-www"]), "marketing-www")

    def test_several_take_the_first_alphabetically_plus_a_count(self):
        self.assertEqual(self.area(["app:my-parsley", "cross-cutting", "service:peppermint", "root"]), "my-parsley +1")
        self.assertEqual(self.area(["app:dr-parsley", "app:marketing-www", "app:my-parsley"]), "dr-parsley +2")

    def test_root_only_or_no_area_label_is_root(self):
        self.assertEqual(self.area(["Needs Review", "root"]), "root")
        self.assertEqual(self.area([]), "root")
        self.assertEqual(self.area(["ci", "infra"]), "root")

    def test_other_repositories_use_their_short_name_and_ignore_labels(self):
        self.assertEqual(self.area(["service:sage"], repo="parsleyhealth/claims-service"), "claims-service")

    def test_tone_is_stable_bounded_and_follows_the_first_name(self):
        self.assertEqual(s.tone("sage"), s.tone("sage"))
        self.assertEqual(s.tone("sage +2"), s.tone("sage"))
        self.assertTrue(all(0 <= s.tone(a) < s.TONES for a in ["sage", "root", "my-parsley", "claims-service"]))
        self.assertGreater(len({s.tone(a) for a in ["sage", "root", "my-parsley", "dr-parsley", "product-api"]}), 1)


def rows_of(vm, section_id, group_title):
    section = next(x for x in vm["sections"] if x["id"] == section_id)
    return next(g["rows"] for g in section["groups"] if g["title"] == group_title)


class Nesting(unittest.TestCase):
    def failing(self, n, parent=None):
        return pr(n, "ci", parent=parent, ci={"failing": [{"name": "x"}], "pending": []})

    def test_stack_members_stay_together_parent_first_with_depth_and_standalones_after(self):
        vm = board(self.failing(3), self.failing(10), self.failing(12, parent=10), self.failing(11, parent=10),
                   self.failing(13, parent=12), self.failing(1))
        rows = rows_of(vm, "mine", "Fix CI")
        self.assertEqual([(r["number"], r["depth"]) for r in rows], [(10, 0), (11, 1), (12, 1), (13, 2), (1, 0), (3, 0)])
        self.assertTrue(all(r["after"] is None for r in rows))

    def test_parent_in_another_section_stays_put_and_child_points_after_it(self):
        parent = pr(550, "review", waiting_on=[{"reviewer": "flasd", "days": 0}])
        child = self.failing(551, parent=550)
        vm = board(parent, child)
        self.assertEqual(placed(vm, 551)[:2], ("mine", "Fix CI"))
        self.assertEqual(placed(vm, 551)[2]["after"], {"number": 550, "url": parent["url"]})
        self.assertEqual(placed(vm, 551)[2]["depth"], 0)
        self.assertIsNone(placed(vm, 550)[2]["after"])  # a parent whose child is elsewhere gets nothing

    def test_mid_stack_pr_nests_its_children_and_points_after_its_own_parent(self):
        vm = board(pr(1, "review", waiting_on=[{"reviewer": "flasd", "days": 0}]),
                   self.failing(2, parent=1), self.failing(3, parent=2))
        rows = rows_of(vm, "mine", "Fix CI")
        self.assertEqual([(r["number"], r["depth"], r["after"] and r["after"]["number"]) for r in rows],
                         [(2, 0, 1), (3, 1, None)])


def failing(n, **kw):
    return pr(n, "ci", ci={"failing": [{"name": "unit", "url": None}], "pending": []}, **kw)


def fix(n, **kw):
    return pr(n, "fix", **{"unanswered": [thread("flasd", "substantive")], **kw})


class RowFacts(unittest.TestCase):
    def test_reviewers_show_each_person_once_with_their_strongest_state(self):
        p = pr(1, "review", waiting_on=[{"reviewer": "flasd", "days": 1}, {"reviewer": "jakeorr", "days": 1}],
               approvals={"current": ["shehabPH"], "stale": ["flasd"]}, changes_requested=["SirPedr"])
        self.assertEqual(placed(board(p), 1)[2]["reviewers"], [
            {"name": "Jake", "state": "requested", "earlier": False},
            {"name": "Marcel", "state": "approved", "earlier": True},  # an earlier-commit approval still counts
            {"name": "Pedro", "state": "changes", "earlier": False},
            {"name": "Shehab", "state": "approved", "earlier": False}])

    def test_size_label_and_log_bar_against_the_largest_pr(self):
        vm = board(pr(1, "ready", additions=1150, deletions=50, changed_files=14), pr(2, "ready", additions=9, deletions=0))
        big, small = placed(vm, 1)[2]["size"], placed(vm, 2)[2]["size"]
        self.assertEqual(big, {"lines": 1200, "files": 14, "bar": 1.0, "label": "1.2k lines · 14 files"})
        self.assertEqual(small["label"], "9 lines · 1 file")
        self.assertAlmostEqual(small["bar"], 0.325, places=3)  # log scale: 9 lines is a third, not 1%

    def test_actions_only_for_agent_moves_in_parsley_repos(self):
        vm = board(fix(1), pr(2, "rebase"), failing(3), pr(4, "ci", "pending", ci={"failing": [], "pending": ["x"]}),
                   pr(5, "review", "no reviewer"), failing(6, repo="me/side"))
        self.assertEqual([placed(vm, n)[2]["action"] for n in range(1, 7)],
                         ["fix-feedback", "rebase", "fix-ci", None, None, None])

    def test_a_gated_pr_gets_no_agent_and_says_so(self):
        # The gate, not the code, may be what fails CI; the board offers no Start for it.
        row = placed(board(failing(557, gates=["Sage migration order"])), 557)[2]
        self.assertEqual((row["action"], row["gate_blocked"]), (None, True))
        self.assertFalse(placed(board(failing(598)), 598)[2]["gate_blocked"])


class Trains(unittest.TestCase):
    def test_a_stack_becomes_a_lettered_train_in_merge_order_and_rows_know_their_train(self):
        stack = {"kind": "stack", "repo": MONO, "name": "EPD-9", "order": [10, 11, 12]}
        vm = board(pr(10, "review", waiting_on=[{"reviewer": "flasd", "days": 0}]), failing(11, parent=10),
                   pr(12, "draft", parent=11), pr(13, "ready"), groups=[stack])
        (train,) = vm["trains"]
        self.assertEqual(train["name"], "EPD-9 · Change 10")
        self.assertEqual([(t["number"], t["letter"]) for t in train["prs"]], [(10, "W"), (11, "C"), (12, "D")])
        self.assertEqual(placed(vm, 11)[2]["stack"], train["id"])
        self.assertIsNone(placed(vm, 13)[2]["stack"])

    def test_single_survivor_and_other_org_stacks_are_not_trains(self):
        vm = board(pr(10, "ready"), pr(1, "ready", repo="me/x"), pr(2, "ready", repo="me/x", parent=1),
                   groups=[{"kind": "stack", "repo": MONO, "name": "A", "order": [10, 99]},
                           {"kind": "stack", "repo": "me/x", "name": "B", "order": [1, 2]}])
        self.assertEqual(vm["trains"], [])


class Suggestions(unittest.TestCase):
    def texts(self, vm):
        return [x["text"] for x in vm["suggestions"]]

    def test_batches_by_move_with_counts_and_numbers_most_valuable_first(self):
        vm = board(pr(1, "ready"), fix(581), fix(639), pr(150, "rebase"), pr(545, "rebase"), failing(598),
                   pr(40, "review", "no reviewer"))
        self.assertEqual(self.texts(vm), [
            "1 PR is ready to merge (#1)",
            "Fix review feedback on 2 PRs (#581, #639)",
            "Rebase 2 PRs that conflict with main (#150, #545)",
            "Fix CI on 1 PR (#598)",
            "Pick reviewers for 1 PR with nobody asked (#40)"])
        fixes = vm["suggestions"][1]
        self.assertEqual((fixes["action"], fixes["keys"]), ("fix-feedback", [f"{MONO}#581", f"{MONO}#639"]))
        self.assertIsNone(vm["suggestions"][0]["action"])  # merging is text only

    def test_gate_blocked_prs_are_not_counted_as_actionable(self):
        vm = board(failing(557, gates=["Sage migration order"]), failing(598), failing(600))
        (ci,) = vm["suggestions"]
        self.assertEqual(ci["text"], "Fix CI on 3 PRs; 1 is blocked by a known gate, so 2 are actionable (#598, #600)")
        self.assertEqual(ci["keys"], [f"{MONO}#598", f"{MONO}#600"])

    def test_only_gated_prs_leave_no_button(self):
        (ci,) = board(failing(557, gates=["Sage migration order"]))["suggestions"]
        self.assertIsNone(ci["action"])

    def test_prs_being_worked_on_are_skipped(self):
        vm = board(fix(581), fix(639), busy=[f"{MONO}#581"])
        self.assertEqual(self.texts(vm), ["Fix review feedback on 1 PR (#639)"])
        self.assertEqual(board(fix(581), busy=[f"{MONO}#581"])["suggestions"], [])

    def test_re_request_whoever_asked_for_changes_text_only_and_never_for_earlier_approvals(self):
        changes = {"changes_outstanding": True}
        vm = board(pr(1, "review", "changes", changes_requested=["flasd"], **changes),
                   pr(2, "review", "changes", changes_requested=["flasd"], **changes),
                   pr(3, "review", "changes", changes_requested=["SirPedr"], **changes),
                   pr(4, "ready", approvals={"current": [], "stale": ["flasd"]}))
        self.assertEqual(self.texts(vm), [
            "1 PR is ready to merge (#4)",
            "Re-request Marcel on 2 PRs where they asked for changes and you have answered (#1, #2)",
            "Re-request Pedro on 1 PR where they asked for changes and you have answered (#3)"])
        self.assertTrue(all(x["action"] is None for x in vm["suggestions"]))

    def test_at_most_five_and_long_lists_are_shortened(self):
        many = [pr(n, "review", "no reviewer") for n in range(1, 9)]
        vm = board(pr(100, "ready"), fix(101), pr(102, "rebase"), failing(103),
                   pr(104, "review", "changes", changes_outstanding=True, changes_requested=["flasd"]), *many)
        self.assertEqual(len(vm["suggestions"]), 5)
        self.assertNotIn("pick-reviewers", [x["id"] for x in vm["suggestions"]])
        self.assertEqual(s.numbers([{"number": n} for n in range(1, 9)]), "#1, #2, #3, #4, #5, #6 and 2 more")


class ReviewerLoad(unittest.TestCase):
    def test_splits_first_and_re_reviews_and_keeps_the_oldest_wait(self):
        vm = board(pr(1, "review", waiting_on=[{"reviewer": "flasd", "days": 2, "approx": False}]),
                   pr(2, "review", "changes", changes_outstanding=True, changes_requested=["flasd"],
                      waiting_on=[{"reviewer": "flasd", "days": 9, "approx": True}]),
                   pr(3, "review", waiting_on=[{"reviewer": "jakeorr", "days": 1, "approx": False}]),
                   pr(4, "review", "no reviewer"),
                   # Approved PRs never count toward anyone's load, even with a second request pending.
                   pr(5, "ready", approved_by=["shehabPH"], waiting_on=[{"reviewer": "flasd", "days": 30}]))
        load = vm["reviewer_load"]
        self.assertEqual(load["reviewers"][0], {"name": "Marcel", "count": 2, "first": 1, "re": 1, "oldest_days": 9,
                                                "approx": True, "keys": [f"{MONO}#1", f"{MONO}#2"]})
        self.assertEqual(load["reviewers"][1]["name"], "Jake")
        self.assertEqual(load["none"], {"count": 1, "keys": [f"{MONO}#4"]})


if __name__ == "__main__":
    unittest.main()
