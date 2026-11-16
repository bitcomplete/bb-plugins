## Your review inbox in PR Board

Review Watch owns a durable GitHub review queue. Install PR Board alongside it
to see **PRs → To review**, with initial requests, follow-ups, active reviewer
threads, and completed drafts. The thread header keeps separate initial-review
and follow-up counts and links to that inbox. The `bb review-watch` command
works without PR Board.

Choose **Start** for one review or **Review selected** for an aggregate reviewer
thread. Both actions let you choose a BB project and use its default checkout
on its registered machine. Organization mappings can preselect the project.
Canceling starts nothing.

## Evidence that you can inspect

Opening a follow-up shows the files that changed from your last reviewed commit,
your prior verdict, and the resolution of review threads in which you
participated. Missing baselines and incomplete comparisons show an unknown
delta. A completed agent draft requires a validated final result; an idle thread
alone does not prove completion.

Dismissal survives polling. A submitted review, a new head, or a closed pull
request archives the previous work item. The unified inbox places work back
with authors only when GitHub supplies the review evidence.

Review Watch reads GitHub and never writes to it. It never starts a thread
automatically. Reviewer threads draft findings for you to post and must not
approve, comment, resolve threads, or push code.

## What you need

Use a GitHub personal access token in `githubToken`, or leave it empty to reuse
an authenticated `gh` CLI on the BB server host. Configure review projects with
`bb plugin config review-watch`. Reviewer threads use `gh` to inspect pull
requests, so keep `gh` authenticated on the machine that runs their checkout.
