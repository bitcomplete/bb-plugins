"""Playbook rendering and the re-check before a thread starts. Run: TZ=UTC python3 -m unittest"""
import unittest

import playbook as pb
from test_simple import MONO, failing, fix, pr, thread

NO_MERGE = "Do NOT merge this PR or any other PR."
NO_RELEASE = "Do not trigger a release or deploy"
NO_PUSH = "Do NOT push."
DECISIONS = "## Decisions for Matt"


def data(*prs):
    return {"prs": {f"{p['repo']}#{p['number']}": p for p in prs}}


class Render(unittest.TestCase):
    def test_every_move_and_stop_forbids_merge_release_and_requires_decisions_with_final_question_protocol(self):
        cases = {"fix-feedback": fix(581), "rebase": pr(150, "rebase"), "fix-ci": failing(598)}
        for action, p in cases.items():
            for stop in pb.STOPS:
                with self.subTest(action=action, stop=stop):
                    text = pb.render(p, action, stop)
                    self.assertIn(NO_MERGE, text)
                    self.assertIn(NO_RELEASE, text)
                    self.assertIn("Write `None.` when there are none.", text)
                    self.assertIn("```pr-board-question", text)
                    self.assertIn("Emit `question: null` when you finish without a blocking question", text)
                    self.assertIn("Do not reuse a question ID after the user answers it", text)
                    self.assertIn(DECISIONS, text)
                    self.assertNotIn("${", text)  # every placeholder filled

    def test_prepare_forbids_pushing_and_posting_and_publish_pushes(self):
        prepare, publish = pb.render(fix(1), "fix-feedback", "prepare"), pb.render(fix(1), "fix-feedback", "publish")
        self.assertIn(NO_PUSH, prepare)
        self.assertIn("Do not post, reply, resolve, approve or comment anything on GitHub", prepare)
        self.assertNotIn("Stopping point: Publish", prepare)
        self.assertNotIn(NO_PUSH, publish)
        self.assertIn("Push the branch (no force-push)", publish)
        self.assertIn("do NOT merge, even when everything is green", publish)

    def test_facts_reach_the_prompt(self):
        p = fix(581, gates=["Sage migration order", "parent #580 not merged"], parent=580,
                unanswered=[{"author": "SirPedr", "label": "substantive", "text": "Handle null", "url": "https://c/1"}])
        text = pb.render(p, "fix-feedback", "publish")
        for fact in [f"https://github.com/{MONO}/pull/581", "branch `b581`", "head `abc123`",
                     'SirPedr (substantive): "Handle null" https://c/1', "Gates: Sage migration order",
                     "worktree add <thread-storage>/pr581 b581"]:
            self.assertIn(fact, text)
        self.assertNotIn("parent #580", text)

    def test_ci_and_rebase_carry_their_own_facts(self):
        self.assertIn("- unit", pb.render(failing(598), "fix-ci", "publish"))
        self.assertIn("base branch no longer exists", pb.render(pr(1, "rebase", base_missing=True), "rebase", "publish"))

    def test_unknown_stop_is_refused(self):
        with self.assertRaises(ValueError):
            pb.render(fix(1), "fix-feedback", "merge")


class Recheck(unittest.TestCase):
    def test_unchanged_move_returns_title_prompt_and_head(self):
        out = pb.prepare(data(fix(581)), f"{MONO}#581", "fix-feedback", "publish")
        self.assertEqual((out["ok"], out["title"], out["head_oid"], out["move"]),
                         (True, "Fix feedback PR 581 Change 581", "abc123", "fix"))

    def test_changed_move_refuses_with_the_reason(self):
        # Feedback was answered elsewhere since the user clicked: CI is the next move now.
        out = pb.prepare(data(failing(581)), f"{MONO}#581", "fix-feedback", "publish")
        self.assertEqual(out, {"ok": False, "reason": "its next move changed to Fix CI (1 check failing); nothing started"})

    def test_gated_pr_refuses_because_the_gate_may_be_the_cause(self):
        out = pb.prepare(data(failing(557, gates=["Sage migration order"])), f"{MONO}#557", "fix-ci", "publish")
        self.assertEqual(out, {"ok": False, "reason": "it is blocked by a known gate; nothing started"})

    def test_closed_pr_refuses(self):
        self.assertEqual(pb.prepare(data(), f"{MONO}#581", "rebase", "publish"),
                         {"ok": False, "reason": "it is no longer open"})


if __name__ == "__main__":
    unittest.main()
