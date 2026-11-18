// Package hooks is the one public endpoint of the deployment: sources such as
// Linear deliver webhooks to it, and it tells the developer servers that
// asked about an entity that something changed. Nothing more crosses: a
// doorbell names an entity, and the server fetches it with the developer's
// own credential.
//
// It is not a door to the router. It never proxies and never holds an
// assertion. Authorization to watch an entity is proved, not claimed: a
// subscriber presents the developer's access token for the source, the
// adapter fetches the entity with it, and the token is forgotten. Admission
// is a lease that lives in memory, bound to the subscriber's event stream;
// see docs/hooks.md for the contract both sides implement.
package hooks

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// Doorbell is what a subscriber receives: an entity, and for the logs only,
// what happened to it. One shape for every source, plus the optional
// Deployment or WorkflowRun object a GitHub deployment or workflow_run
// doorbell carries.
type Doorbell struct {
	Source string    `json:"source"`
	Kind   string    `json:"kind"`
	ID     string    `json:"id"`
	Unit   string    `json:"unit"`
	Action string    `json:"action"`
	At     time.Time `json:"at"`
	// Deployment is set only on a GitHub `deployment` doorbell (see the
	// GitHub adapter). It carries the fields of the event that a subscriber
	// decides on -- the environment, ref, commit, state and URL -- because
	// they are not in the entity name and the decision (does this deployment
	// carry my merge?) should not cost a fetch. Nil on every other doorbell.
	Deployment *Deployment `json:"deployment,omitempty"`
	// WorkflowRun is set only on a GitHub `workflow_run` doorbell (see the
	// GitHub adapter). It carries the fields of the run that a subscriber
	// decides on -- which workflow, how it ended, where to look, the commit
	// it ran on and which attempt it was -- because they are not in the
	// entity name and the decision (does this failing run concern my merge?)
	// should not cost a fetch. Nil on every other doorbell.
	WorkflowRun *WorkflowRun `json:"workflow_run,omitempty"`
}

// Deployment is the extra object a GitHub deployment doorbell carries. The
// entity id is "owner/repo#<deployment id>", the same spelling as an issue
// or alert in its own numbering, and Unit is the repository. State is empty
// on a `deployment` event (a deployment has no state of its own until it has
// a status) and GitHub's state (queued, in_progress, success, failure,
// error, inactive, pending) on a `deployment_status` event. URL is the link
// GitHub gave for the status, preferring a human one over the API's.
type Deployment struct {
	ID          int64  `json:"id"`
	Environment string `json:"environment"`
	Ref         string `json:"ref"`
	SHA         string `json:"sha"`
	State       string `json:"state"`
	URL         string `json:"url"`
}

// WorkflowRun is the extra object a GitHub `workflow_run` doorbell carries.
// The entity id is "owner/repo#<run id>", the same spelling as a deployment
// in its own numbering, and Unit is the repository. Only the fields a
// subscriber decides on travel: the workflow's file path (Workflow) and
// name, the run's conclusion, the run's html_url (URL), its head_sha (SHA)
// and which attempt it was. Logs, commit messages, the actor and the branch
// do not; a doorbell is a pointer, and the subscriber fetches the run if it
// needs more.
type WorkflowRun struct {
	// Workflow is the workflow file path, e.g.
	// ".github/workflows/bb-server.yaml".
	Workflow   string `json:"workflow"`
	Name       string `json:"name"`
	Conclusion string `json:"conclusion"`
	URL        string `json:"url"`
	SHA        string `json:"sha"`
	RunAttempt int    `json:"run_attempt"`
}

// Watch names an entity a subscriber wants doorbells for.
type Watch struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	// Capability is an opaque proof carried only by Slack session leases:
	// the wake put it in the plugin's hands and the plugin echoes it here
	// instead of a token. It is never logged. Empty for every other source.
	Capability string `json:"capability,omitempty"`
}

// Errors an Adapter answers with. Anything else is a 500 on the webhook
// path and "unverifiable" on the subscribe path.
var (
	// ErrDisabled: the adapter has no secret configured.
	ErrDisabled = errors.New("adapter not configured")
	// ErrUnauthorized: the delivery's signature or timestamp did not verify.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrBadRequest: the delivery verified but could not be read.
	ErrBadRequest = errors.New("bad request")
	// ErrForbidden: the source refused or did not find the entity for this
	// token. Not distinguished, on purpose.
	ErrForbidden = errors.New("forbidden")
	// ErrBadToken: the source refused the token itself, not the entity.
	// The whole subscribe is answered 401 so the subscriber refreshes and
	// retries instead of concluding it lost access to everything.
	ErrBadToken = errors.New("token refused")
	// ErrUnverifiable: the source could not be asked.
	ErrUnverifiable = errors.New("unverifiable")
	// ErrRateLimited: the source answered 429, or a read was over the
	// adapter's own budget. It wraps ErrUnverifiable -- a rate-limited verify
	// is still unverifiable -- and marks the failure as a known, self-clearing
	// window the subscriber logs but does not report: it never counts toward
	// the capture streak.
	ErrRateLimited = errors.New("rate limited")
	// ErrOwned: the session is already leased to another connection's user.
	// Slack session leases are exclusive, so the first admitted user wins.
	ErrOwned = errors.New("owned")
)

// transportCause reduces a client.Do failure to something safe to print. A
// transport error arrives as a *url.Error whose message includes the URL, and
// a credential that sits in a URL would be printed with it. The inner error
// says what went wrong (connection refused, no such host, a timeout) and
// carries no URL, so it is what the wrapped ErrUnverifiable should name.
func transportCause(err error) error {
	for {
		var uerr *url.Error
		if !errors.As(err, &uerr) || uerr.Err == nil {
			return err
		}
		err = uerr.Err
	}
}

// Adapter is one source. It verifies that source's webhooks, maps them to
// doorbells, and fetches an entity with a token to admit a watch. Nothing
// else differs between sources.
type Adapter interface {
	// Source is the name in doorbells and the public path: "linear".
	Source() string
	// Enabled is false when the adapter has no secret; it then answers
	// ErrDisabled to webhooks and subscribes are refused with 503.
	Enabled() bool
	// UnitKind is the Watch.Kind that leases a whole unit ("team") for
	// doorbells of the given kind, or "" when there is none. A lease of
	// that kind receives every doorbell of that kind whose Unit is its ID.
	// One source may have several: reading a unit's issues and reading its
	// security alerts are proved separately.
	UnitKind(kind string) string
	// Webhook verifies one delivery and returns its doorbells, possibly
	// none. body is the raw request body, already read.
	Webhook(r *http.Request, body []byte) ([]Doorbell, error)
	// Verify fetches the entity with the token and returns the entity as
	// the source names it in doorbells (sources often accept aliases such
	// as an issue key on the way in) and its unit, or ErrForbidden /
	// ErrUnverifiable. It must never log the token.
	Verify(ctx context.Context, token string, w Watch) (canonical Watch, unit string, err error)
}

// Matches reports whether a lease on l receives doorbell d. Exact entity, or
// the unit lease kind for d's kind naming d's unit.
func Matches(a Adapter, l Watch, d Doorbell) bool {
	if l.Kind == d.Kind && l.ID == d.ID {
		return true
	}
	uk := a.UnitKind(d.Kind)
	return uk != "" && l.Kind == uk && d.Unit != "" && l.ID == d.Unit
}

// Person is a user as a source names them.
type Person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Identifier is an adapter that can say whose a token is. A server proves
// which user it acts for with that user's own token, the way a lease is
// proven, so nothing it claims about itself is trusted.
type Identifier interface {
	// Identify returns the token's own user, or ErrBadToken, ErrForbidden
	// or ErrUnverifiable. It must never log the token.
	Identify(ctx context.Context, token string) (Person, error)
}
