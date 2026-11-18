package hooks

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// GitHubAPI is where entities are fetched to admit a watch.
const GitHubAPI = "https://api.github.com"

// GitHub is the adapter for GitHub's webhooks and REST API.
//
// Entities are named the way a person writes them: an issue or pull request
// is "owner/repo#123" (the two share one number space, and GitHub's issues
// endpoint answers for both), a Dependabot alert is "owner/repo#4" in the
// repository's alert numbering, and a deployment is "owner/repo#7" in the
// repository's deployment numbering. The unit is the repository,
// "owner/repo". A doorbell carries the repository's name as GitHub delivers
// it; Verify binds a lease to the name the API reports, so a subscriber that
// wrote the owner in another case still rings.
type GitHub struct {
	// Secret signs deliveries: the webhook's secret. Empty disables the
	// adapter, unless SecretFile is set.
	Secret []byte
	// SecretFile, when set, is read on every use instead of Secret; see
	// Linear.SecretFile.
	SecretFile string
	// API is the REST root; GitHubAPI when empty.
	API string
	// HTTP makes the verification fetches; http.DefaultClient when nil.
	HTTP *http.Client
	Now  func() time.Time
}

// Source implements Adapter.
func (*GitHub) Source() string { return "github" }

func (g *GitHub) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// Enabled implements Adapter.
func (g *GitHub) Enabled() bool { return len(g.secret()) > 0 }

func (g *GitHub) secret() []byte {
	if g.SecretFile == "" {
		return g.Secret
	}
	b, err := os.ReadFile(g.SecretFile)
	if err != nil {
		return nil
	}
	return []byte(strings.TrimSpace(string(b)))
}

// UnitKind implements Adapter: a repo lease receives every doorbell for an
// issue or pull request in that repository, a dependabot_repo lease every
// doorbell for a Dependabot alert in it, and a deployment_repo lease every
// deployment or workflow_run doorbell in it. They are separate because
// reading a repository does not entitle a token to its alerts or to its
// deployments, and a failing workflow run is reported to the same subscribers
// a deployment is: only a repo a playbook names as a deployment target.
func (*GitHub) UnitKind(kind string) string {
	switch kind {
	case "issue":
		return "repo"
	case "dependabot_alert":
		return "dependabot_repo"
	case "deployment", "workflow_run":
		return "deployment_repo"
	}
	return ""
}

// dependabotActions are the dependabot_alert actions that ring: every one
// that creates an alert or changes its state, including withdrawn, when
// GitHub withdraws the advisory behind it. Anything else
// (assignees_changed, ...) is acknowledged and dropped.
var dependabotActions = map[string]bool{
	"created":        true,
	"fixed":          true,
	"dismissed":      true,
	"reopened":       true,
	"reintroduced":   true,
	"auto_dismissed": true,
	"auto_reopened":  true,
	"withdrawn":      true,
}

// Sign computes the X-Hub-Signature-256 value for a body: "sha256=" and
// the hex HMAC-SHA256 with the webhook secret. Exported for tests and
// tooling.
func (g *GitHub) Sign(body []byte) string {
	m := hmac.New(sha256.New, g.secret())
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// IssueRef formats the entity id of issue or pull request number in repo,
// of Dependabot alert number in repo, and of deployment id in repo, which
// are all spelled the same way.
func IssueRef(repo string, number int) string { return repo + "#" + strconv.Itoa(number) }

// githubDeployment is the `deployment` object GitHub sends on the
// `deployment` and `deployment_status` events, trimmed to what a doorbell
// carries. A deployment has no state of its own; its statuses do.
type githubDeployment struct {
	ID          int64  `json:"id"`
	Ref         string `json:"ref"`
	SHA         string `json:"sha"`
	Environment string `json:"environment"`
	URL         string `json:"url"`
}

// githubWorkflowRun is the `workflow_run` object GitHub sends on the
// `workflow_run` event, trimmed to what a doorbell carries plus the pull
// requests the existing issue doorbell is built from.
type githubWorkflowRun struct {
	ID           int64                  `json:"id"`
	Name         string                 `json:"name"`
	Path         string                 `json:"path"`
	Conclusion   string                 `json:"conclusion"`
	HTMLURL      string                 `json:"html_url"`
	HeadSHA      string                 `json:"head_sha"`
	RunAttempt   int                    `json:"run_attempt"`
	PullRequests []struct{ Number int } `json:"pull_requests"`
}

// githubDeploymentStatus is the `deployment_status` object, trimmed.
type githubDeploymentStatus struct {
	State          string `json:"state"`
	URL            string `json:"url"`
	LogURL         string `json:"log_url"`
	EnvironmentURL string `json:"environment_url"`
	TargetURL      string `json:"target_url"`
}

// workflowRunConclusions are the conclusions of a completed workflow run that
// ring a workflow_run doorbell: the run did not succeed. A success is dropped,
// and the deployment doorbell covers recovery, so a re-run that succeeds needs
// no wake of its own.
var workflowRunConclusions = map[string]bool{
	"failure":   true,
	"cancelled": true,
	"timed_out": true,
}

// workflowRunBell builds the one workflow_run doorbell for a delivery. The
// entity id is "owner/repo#<run id>"; the run's path and name, conclusion,
// URL, head commit and attempt travel with it, and nothing else. action is the
// event's own (workflow_run.completed), for logs like every other doorbell's.
func (g *GitHub) workflowRunBell(repo string, r *githubWorkflowRun, action string) Doorbell {
	return Doorbell{
		Source: "github", Kind: "workflow_run",
		ID: IssueRef(repo, int(r.ID)), Unit: repo,
		Action: action, At: g.now(),
		WorkflowRun: &WorkflowRun{
			Workflow: r.Path, Name: r.Name, Conclusion: r.Conclusion,
			URL: r.HTMLURL, SHA: r.HeadSHA, RunAttempt: r.RunAttempt,
		},
	}
}

// deploymentBell builds the one deployment doorbell for a delivery. The
// entity id is "owner/repo#<deployment id>"; state and url come from the
// status and are empty on a bare `deployment` event, where the deployment's
// own API URL is the best link GitHub gave.
func (g *GitHub) deploymentBell(repo string, d *githubDeployment, action, state, url string) Doorbell {
	if url == "" {
		url = d.URL
	}
	return Doorbell{
		Source: "github", Kind: "deployment",
		ID: IssueRef(repo, int(d.ID)), Unit: repo,
		Action: action, At: g.now(),
		Deployment: &Deployment{
			ID: d.ID, Environment: d.Environment, Ref: d.Ref, SHA: d.SHA,
			State: state, URL: url,
		},
	}
}

// deploymentStatusURL picks the link a person can open from a deployment
// status: GitHub's log_url (the run, when the creator set one), then
// environment_url, then target_url; when it set none, the status's own API
// URL. The deployment's API URL is the fallback when even that is empty.
func deploymentStatusURL(s *githubDeploymentStatus) string {
	for _, u := range []string{s.LogURL, s.EnvironmentURL, s.TargetURL, s.URL} {
		if u != "" {
			return u
		}
	}
	return ""
}

// ParseIssueRef splits "owner/repo#123". The repository is whatever came
// before the '#'; the API decides whether it exists.
func ParseIssueRef(id string) (repo string, number int, ok bool) {
	i := strings.LastIndexByte(id, '#')
	if i <= 0 {
		return "", 0, false
	}
	n, err := strconv.Atoi(id[i+1:])
	if err != nil || n <= 0 || !validRepo(id[:i]) {
		return "", 0, false
	}
	return id[:i], n, true
}

func validRepo(repo string) bool {
	owner, name, ok := strings.Cut(repo, "/")
	return ok && owner != "" && name != "" && !strings.ContainsAny(repo, " \t\n?#") && !strings.Contains(name, "/")
}

// Webhook implements Adapter. Signature first, then the payload. GitHub's
// deliveries carry no timestamp, so there is no freshness window; a replay
// is a doorbell for an entity the subscriber re-checks anyway. Events about
// issues, pull requests, their comments and reviews, and check runs and
// suites that name pull requests become issue doorbells; a completed
// workflow_run that failed, was cancelled or timed out becomes a
// workflow_run doorbell as well as the issue doorbells for any pull requests
// it names; Dependabot alerts that are created or change state become
// dependabot_alert doorbells; a deployment and every deployment status become
// deployment doorbells; everything else (ping, push, status, ...) is
// acknowledged and dropped.
func (g *GitHub) Webhook(r *http.Request, body []byte) ([]Doorbell, error) {
	if !g.Enabled() {
		return nil, ErrDisabled
	}
	header := strings.TrimSpace(r.Header.Get("X-Hub-Signature-256"))
	got, err := hex.DecodeString(strings.TrimPrefix(header, "sha256="))
	if err != nil || len(got) == 0 || !strings.HasPrefix(header, "sha256=") {
		return nil, ErrUnauthorized
	}
	want, _ := hex.DecodeString(strings.TrimPrefix(g.Sign(body), "sha256="))
	if !hmac.Equal(got, want) {
		return nil, ErrUnauthorized
	}
	event := r.Header.Get("X-GitHub-Event")
	var p struct {
		Action     string `json:"action"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
		Issue       *struct{ Number int } `json:"issue"`
		PullRequest *struct{ Number int } `json:"pull_request"`
		CheckRun    *struct {
			PullRequests []struct{ Number int } `json:"pull_requests"`
		} `json:"check_run"`
		CheckSuite *struct {
			PullRequests []struct{ Number int } `json:"pull_requests"`
		} `json:"check_suite"`
		WorkflowRun *githubWorkflowRun    `json:"workflow_run"`
		Alert       *struct{ Number int } `json:"alert"`
		// Deployment is on both the `deployment` and `deployment_status`
		// events; DeploymentStatus only on the latter.
		Deployment       *githubDeployment       `json:"deployment"`
		DeploymentStatus *githubDeploymentStatus `json:"deployment_status"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrBadRequest
	}
	action := event
	if p.Action != "" {
		action = event + "." + p.Action
	}
	var numbers []int
	var extra []Doorbell
	kind := "issue"
	switch event {
	case "issues", "issue_comment":
		if p.Issue == nil || p.Issue.Number == 0 {
			return nil, ErrBadRequest
		}
		numbers = []int{p.Issue.Number}
	case "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread":
		if p.PullRequest == nil || p.PullRequest.Number == 0 {
			return nil, ErrBadRequest
		}
		numbers = []int{p.PullRequest.Number}
	case "check_run":
		if p.CheckRun == nil {
			return nil, ErrBadRequest
		}
		for _, pr := range p.CheckRun.PullRequests {
			numbers = append(numbers, pr.Number)
		}
	case "check_suite":
		if p.CheckSuite == nil {
			return nil, ErrBadRequest
		}
		for _, pr := range p.CheckSuite.PullRequests {
			numbers = append(numbers, pr.Number)
		}
	case "workflow_run":
		if p.WorkflowRun == nil {
			return nil, ErrBadRequest
		}
		for _, pr := range p.WorkflowRun.PullRequests {
			numbers = append(numbers, pr.Number)
		}
		// A completed run that did not succeed rings the workflow_run
		// doorbell too, even when it also names pull requests: the issue
		// doorbell is unchanged, and the new kind is what a deployment watch
		// listens for. Other actions and conclusions are dropped for it.
		if p.Action == "completed" && workflowRunConclusions[p.WorkflowRun.Conclusion] {
			if p.WorkflowRun.ID == 0 {
				return nil, ErrBadRequest
			}
			extra = append(extra, g.workflowRunBell(p.Repository.FullName, p.WorkflowRun, action))
		}
	case "dependabot_alert":
		if !dependabotActions[p.Action] {
			return nil, nil
		}
		if p.Alert == nil || p.Alert.Number == 0 {
			return nil, ErrBadRequest
		}
		kind = "dependabot_alert"
		numbers = []int{p.Alert.Number}
	case "deployment":
		// A deployment exists but has no state until it has a status; the
		// doorbell still rings, so a subscriber can learn of it before the
		// first status arrives. The action is the event's own (created).
		if p.Deployment == nil || p.Deployment.ID == 0 {
			return nil, ErrBadRequest
		}
		if p.Repository.FullName == "" {
			return nil, ErrBadRequest
		}
		return []Doorbell{g.deploymentBell(p.Repository.FullName, p.Deployment, action, "", "")}, nil
	case "deployment_status":
		// The state is the point of this event, so it names the action as
		// well as riding in the object: a log line reads
		// "deployment_status.failure" without a second lookup.
		if p.Deployment == nil || p.Deployment.ID == 0 {
			return nil, ErrBadRequest
		}
		if p.DeploymentStatus == nil || p.DeploymentStatus.State == "" {
			return nil, ErrBadRequest
		}
		if p.Repository.FullName == "" {
			return nil, ErrBadRequest
		}
		s := p.DeploymentStatus
		return []Doorbell{g.deploymentBell(p.Repository.FullName, p.Deployment, "deployment_status."+s.State, s.State, deploymentStatusURL(s))}, nil
	default:
		return nil, nil
	}
	if p.Repository.FullName == "" {
		return nil, ErrBadRequest
	}
	// A check that covers several pull requests (one head on two PRs) rings
	// each once.
	seen := map[int]bool{}
	var out []Doorbell
	for _, n := range numbers {
		if n == 0 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, Doorbell{Source: "github", Kind: kind, ID: IssueRef(p.Repository.FullName, n), Unit: p.Repository.FullName, Action: action, At: g.now()})
	}
	return append(out, extra...), nil
}

// Verify implements Adapter: REST reads as the token. The answer names
// the repository as GitHub spells it, and the lease is bound to that, since
// doorbells carry the delivered name. The token goes in a header and
// nowhere else.
func (g *GitHub) Verify(ctx context.Context, token string, w Watch) (Watch, string, error) {
	switch w.Kind {
	case "issue":
		repo, number, ok := ParseIssueRef(w.ID)
		if !ok {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			Number        int    `json:"number"`
			RepositoryURL string `json:"repository_url"`
		}
		if err := g.get(ctx, token, "/repos/"+repo+"/issues/"+strconv.Itoa(number), &out); err != nil {
			return Watch{}, "", err
		}
		if out.Number == 0 {
			return Watch{}, "", ErrForbidden
		}
		// "https://api.github.com/repos/Owner/Repo" → "Owner/Repo"
		_, name, ok := strings.Cut(out.RepositoryURL, "/repos/")
		if !ok || !validRepo(name) {
			name = repo
		}
		return Watch{Kind: "issue", ID: IssueRef(name, out.Number)}, name, nil
	case "dependabot_alert":
		// Reading one alert needs the token's alert access (the
		// security_events scope, or Dependabot alerts read), not just read
		// access to the repository. GitHub answers 403 when it lacks that or
		// alerts are off, and 404 for a repository it may not see.
		repo, number, ok := ParseIssueRef(w.ID)
		if !ok {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			Number int    `json:"number"`
			URL    string `json:"url"`
		}
		if err := g.get(ctx, token, "/repos/"+repo+"/dependabot/alerts/"+strconv.Itoa(number), &out); err != nil {
			return Watch{}, "", err
		}
		if out.Number == 0 {
			return Watch{}, "", ErrForbidden
		}
		// "https://api.github.com/repos/Owner/Repo/dependabot/alerts/4" → "Owner/Repo"
		_, name, ok := strings.Cut(out.URL, "/repos/")
		name, _, found := strings.Cut(name, "/dependabot/")
		if !ok || !found || !validRepo(name) {
			name = repo
		}
		return Watch{Kind: "dependabot_alert", ID: IssueRef(name, out.Number)}, name, nil
	case "repo":
		name, err := g.repoName(ctx, token, w.ID)
		if err != nil {
			return Watch{}, "", err
		}
		return Watch{Kind: "repo", ID: name}, name, nil
	case "dependabot_repo":
		// The repository for its spelling, then one page of its alerts for
		// access: an empty list is as good a proof as a full one, and the
		// list names no repository to take the spelling from.
		name, err := g.repoName(ctx, token, w.ID)
		if err != nil {
			return Watch{}, "", err
		}
		var alerts []json.RawMessage
		if err := g.get(ctx, token, "/repos/"+name+"/dependabot/alerts?per_page=1", &alerts); err != nil {
			return Watch{}, "", err
		}
		return Watch{Kind: "dependabot_repo", ID: name}, name, nil
	case "workflow_run":
		// A run is read like a deployment: the entity id carries the run's
		// number in the repository's own run numbering, and reading it proves
		// the token may see the repository's actions runs. The answer names
		// the repository, which is what the lease binds to.
		repo, id, ok := ParseIssueRef(w.ID)
		if !ok {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			ID         int64 `json:"id"`
			Repository struct {
				FullName string `json:"full_name"`
			} `json:"repository"`
		}
		if err := g.get(ctx, token, "/repos/"+repo+"/actions/runs/"+strconv.Itoa(id), &out); err != nil {
			return Watch{}, "", err
		}
		if out.ID == 0 {
			return Watch{}, "", ErrForbidden
		}
		name := out.Repository.FullName
		if !validRepo(name) {
			name = repo
		}
		return Watch{Kind: "workflow_run", ID: IssueRef(name, int(out.ID))}, name, nil
	case "deployment_repo":
		// Like dependabot_repo: the repository for its spelling, then one
		// page of its deployments for access. Reading a repository's issues
		// does not entitle a token to its deployments, and an empty page
		// proves as much as a full one.
		name, err := g.repoName(ctx, token, w.ID)
		if err != nil {
			return Watch{}, "", err
		}
		var deployments []json.RawMessage
		if err := g.get(ctx, token, "/repos/"+name+"/deployments?per_page=1", &deployments); err != nil {
			return Watch{}, "", err
		}
		return Watch{Kind: "deployment_repo", ID: name}, name, nil
	case "deployment":
		repo, id, ok := ParseIssueRef(w.ID)
		if !ok {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			ID  int64  `json:"id"`
			URL string `json:"url"`
		}
		if err := g.get(ctx, token, "/repos/"+repo+"/deployments/"+strconv.Itoa(id), &out); err != nil {
			return Watch{}, "", err
		}
		if out.ID == 0 {
			return Watch{}, "", ErrForbidden
		}
		// "https://api.github.com/repos/Owner/Repo/deployments/7" → "Owner/Repo"
		_, name, ok := strings.Cut(out.URL, "/repos/")
		name, _, found := strings.Cut(name, "/deployments/")
		if !ok || !found || !validRepo(name) {
			name = repo
		}
		return Watch{Kind: "deployment", ID: IssueRef(name, int(out.ID))}, name, nil
	default:
		return Watch{}, "", ErrForbidden
	}
}

// repoName reads a repository and returns its name as GitHub spells it.
func (g *GitHub) repoName(ctx context.Context, token, repo string) (string, error) {
	if !validRepo(repo) {
		return "", ErrForbidden
	}
	var out struct {
		FullName string `json:"full_name"`
	}
	if err := g.get(ctx, token, "/repos/"+repo, &out); err != nil {
		return "", err
	}
	if out.FullName == "" {
		return "", ErrForbidden
	}
	return out.FullName, nil
}

// get makes one REST read as the token and decodes the answer into out, or
// maps the refusal onto the Adapter errors.
func (g *GitHub) get(ctx context.Context, token, path string, out any) error {
	api := g.API
	if api == "" {
		api = GitHubAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(api, "/")+path, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "hooks-service")
	req.Header.Set("Authorization", "Bearer "+token)
	client := g.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode == http.StatusUnauthorized:
		// A bad or revoked token is 401 whatever was asked. A token that
		// may not see the repository gets a 404, so that it cannot tell a
		// private repository from a missing one, and that is forbidden.
		return ErrBadToken
	case resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0":
		// Rate limited: ask again later, not "you may not".
		return fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode >= 400:
		return ErrForbidden
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	return nil
}
