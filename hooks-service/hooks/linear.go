package hooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// LinearAPI is where entities are fetched to admit a watch.
const LinearAPI = "https://api.linear.app/graphql"

// linearSkew is how far a delivery's webhookTimestamp may be from now.
// Linear's own guidance is a minute.
const linearSkew = 60 * time.Second

// Linear is the adapter for Linear's webhooks and API.
type Linear struct {
	// Secret signs deliveries: the webhook's signing secret. Empty disables
	// the adapter, unless SecretFile is set.
	Secret []byte
	// SecretFile, when set, is read on every use instead of Secret: a
	// mounted Kubernetes Secret, which the kubelet refreshes in place. The
	// adapter then turns on when the Secret appears and follows a rotation,
	// with no restart. A missing or empty file means disabled.
	SecretFile string
	// API is the GraphQL endpoint; LinearAPI when empty.
	API string
	// HTTP makes the verification fetches; http.DefaultClient when nil.
	HTTP *http.Client
	Now  func() time.Time
	// OnSession receives every verified agent session event (created or
	// prompted). It must return at once: it runs before the 200. Nil
	// acknowledges and drops them, as for any other type.
	OnSession func(SessionEvent)
}

// Source implements Adapter.
func (*Linear) Source() string { return "linear" }

// Enabled implements Adapter.
func (l *Linear) Enabled() bool { return len(l.secret()) > 0 }

func (l *Linear) secret() []byte {
	if l.SecretFile == "" {
		return l.Secret
	}
	b, err := os.ReadFile(l.SecretFile)
	if err != nil {
		return nil
	}
	return bytes.TrimSpace(b)
}

// UnitKind implements Adapter: a team lease receives every doorbell for an
// issue in that team.
func (*Linear) UnitKind(kind string) string {
	if kind == "issue" {
		return "team"
	}
	return ""
}

func (l *Linear) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// Sign computes the Linear-Signature for a body: hex HMAC-SHA256 with the
// webhook's signing secret. Exported for tests and tooling.
func (l *Linear) Sign(body []byte) string {
	m := hmac.New(sha256.New, l.secret())
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// Webhook implements Adapter. Signature first, then the timestamp window,
// then the payload; a failure of either check is ErrUnauthorized without
// detail. Issues and comments become issue doorbells; everything else is
// acknowledged and dropped.
func (l *Linear) Webhook(r *http.Request, body []byte) ([]Doorbell, error) {
	if !l.Enabled() {
		return nil, ErrDisabled
	}
	got, err := hex.DecodeString(strings.TrimSpace(r.Header.Get("Linear-Signature")))
	if err != nil || len(got) == 0 {
		return nil, ErrUnauthorized
	}
	want, _ := hex.DecodeString(l.Sign(body))
	if !hmac.Equal(got, want) {
		return nil, ErrUnauthorized
	}
	var p struct {
		Action    string          `json:"action"`
		Type      string          `json:"type"`
		Timestamp int64           `json:"webhookTimestamp"`
		Data      json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrBadRequest
	}
	if p.Timestamp == 0 {
		return nil, ErrUnauthorized
	}
	at := time.UnixMilli(p.Timestamp)
	if d := l.now().Sub(at); d > linearSkew || d < -linearSkew {
		return nil, ErrUnauthorized
	}
	switch p.Type {
	case "Issue":
		var d struct {
			ID     string `json:"id"`
			TeamID string `json:"teamId"`
			Team   struct {
				ID string `json:"id"`
			} `json:"team"`
		}
		if err := json.Unmarshal(p.Data, &d); err != nil || d.ID == "" {
			return nil, ErrBadRequest
		}
		unit := d.TeamID
		if unit == "" {
			unit = d.Team.ID
		}
		return []Doorbell{{Source: "linear", Kind: "issue", ID: d.ID, Unit: unit, Action: p.Action, At: at}}, nil
	case "Comment":
		var d struct {
			IssueID string `json:"issueId"`
			Issue   struct {
				ID     string `json:"id"`
				TeamID string `json:"teamId"`
				Team   struct {
					ID string `json:"id"`
				} `json:"team"`
			} `json:"issue"`
		}
		if err := json.Unmarshal(p.Data, &d); err != nil {
			return nil, ErrBadRequest
		}
		id := d.IssueID
		if id == "" {
			id = d.Issue.ID
		}
		if id == "" {
			// A comment on something that is not an issue, such as a
			// document. Nothing to ring.
			return nil, nil
		}
		unit := d.Issue.TeamID
		if unit == "" {
			unit = d.Issue.Team.ID
		}
		return []Doorbell{{Source: "linear", Kind: "issue", ID: id, Unit: unit, Action: p.Action, At: at}}, nil
	case "AgentSessionEvent":
		if l.OnSession == nil || (p.Action != "created" && p.Action != "prompted") {
			return nil, nil
		}
		ev, err := parseSessionEvent(body, at)
		if err != nil {
			return nil, ErrBadRequest
		}
		l.OnSession(ev)
		return nil, nil
	default:
		return nil, nil
	}
}

// parseSessionEvent reads an AgentSessionEvent. The whole payload is at the
// top level, not under data. Who asked is the author of the prompt on
// prompted and the session's creator (the mention's author) on created;
// the text is the prompt or the mentioning comment, with the prompt context
// for a mention that is not in a comment.
func parseSessionEvent(body []byte, at time.Time) (SessionEvent, error) {
	type ref struct {
		ID string `json:"id"`
	}
	var p struct {
		Action         string `json:"action"`
		OrganizationID string `json:"organizationId"`
		AgentSession   struct {
			ID        string `json:"id"`
			IssueID   string `json:"issueId"`
			Issue     *ref   `json:"issue"`
			CreatorID string `json:"creatorId"`
			Creator   *ref   `json:"creator"`
			Comment   *struct {
				Body string `json:"body"`
			} `json:"comment"`
		} `json:"agentSession"`
		AgentActivity *struct {
			UserID  string `json:"userId"`
			User    *ref   `json:"user"`
			Body    string `json:"body"`
			Content struct {
				Body string `json:"body"`
			} `json:"content"`
		} `json:"agentActivity"`
		PromptContext string `json:"promptContext"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return SessionEvent{}, err
	}
	s := p.AgentSession
	if s.ID == "" {
		return SessionEvent{}, fmt.Errorf("no session id")
	}
	ev := SessionEvent{Action: p.Action, Session: s.ID, OrganizationID: p.OrganizationID, Issue: s.IssueID, Asker: s.CreatorID, At: at}
	if ev.Issue == "" && s.Issue != nil {
		ev.Issue = s.Issue.ID
	}
	if ev.Asker == "" && s.Creator != nil {
		ev.Asker = s.Creator.ID
	}
	if s.Comment != nil {
		ev.Text = s.Comment.Body
	}
	if ev.Text == "" {
		ev.Text = p.PromptContext
	}
	if a := p.AgentActivity; p.Action == "prompted" && a != nil {
		switch {
		case a.UserID != "":
			ev.Asker = a.UserID
		case a.User != nil && a.User.ID != "":
			ev.Asker = a.User.ID
		}
		if a.Body != "" {
			ev.Text = a.Body
		} else if a.Content.Body != "" {
			ev.Text = a.Content.Body
		}
	}
	return ev, nil
}

// Identify implements Identifier: the token's own user, read with viewer.
// The token goes in a header and nowhere else.
func (l *Linear) Identify(ctx context.Context, token string) (Person, error) {
	var out struct {
		Viewer *Person `json:"viewer"`
	}
	if err := linearGraphQL(ctx, l.HTTP, l.API, token, `query { viewer { id name } }`, nil, &out); err != nil {
		return Person{}, err
	}
	if out.Viewer == nil || out.Viewer.ID == "" {
		return Person{}, ErrForbidden
	}
	return *out.Viewer, nil
}

// linearGraphQL runs one GraphQL operation as token and decodes data into
// out. 401 is ErrBadToken; 5xx, 429, a rate-limit error or no answer is
// ErrUnverifiable; any other error or 4xx is ErrForbidden.
func linearGraphQL(ctx context.Context, client *http.Client, api, token, query string, vars map[string]any, out any) error {
	body, _ := json.Marshal(map[string]any{"query": query, "variables": vars})
	if api == "" {
		api = LinearAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, api, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
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
		return ErrBadToken
	}
	var env struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Extensions struct {
				Code string `json:"code"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	for _, e := range env.Errors {
		if e.Extensions.Code == "RATELIMITED" {
			return fmt.Errorf("%w: rate limited", ErrUnverifiable)
		}
	}
	if resp.StatusCode >= 400 || len(env.Errors) > 0 {
		return ErrForbidden
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return ErrForbidden
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	return nil
}

const (
	linearIssueQuery = `query($id: String!) { issue(id: $id) { id team { id } } }`
	linearTeamQuery  = `query($id: String!) { team(id: $id) { id } }`
)

// linearRetryBackoff is how long Verify waits before its single retry of a
// transport error. It is short next to the subscribe verify budget and is
// itself bounded by the request context.
const linearRetryBackoff = 250 * time.Millisecond

// linearDo sends the GraphQL request and, when client.Do fails with a
// transport error or timeout, retries it once after linearRetryBackoff. The
// backoff is bounded by the request context. A source answer -- a 4xx, a 429
// or a GraphQL rate-limit error -- is not a transport error and is not
// retried here; retrying a limiter makes it worse.
func linearDo(ctx context.Context, client *http.Client, api, token string, body []byte) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, api, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnverifiable, err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err == nil {
			return resp, nil
		}
		if attempt > 0 {
			return nil, fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
		}
		if serr := sleepContext(ctx, linearRetryBackoff); serr != nil {
			// The request context ended before the retry could run; the
			// transport error is still the cause.
			return nil, fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
		}
	}
}

// Verify implements Adapter: one GraphQL read as the token. A GraphQL
// error, a null result, or a 4xx is ErrForbidden; anything that stops the
// question being asked is ErrUnverifiable. The token goes in a header and
// nowhere else.
func (l *Linear) Verify(ctx context.Context, token string, w Watch) (Watch, string, error) {
	var q string
	switch w.Kind {
	case "issue":
		q = linearIssueQuery
	case "team":
		q = linearTeamQuery
	default:
		return Watch{}, "", ErrForbidden
	}
	body, _ := json.Marshal(map[string]any{"query": q, "variables": map[string]string{"id": w.ID}})
	api := l.API
	if api == "" {
		api = LinearAPI
	}
	client := l.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := linearDo(ctx, client, api, token, body)
	if err != nil {
		return Watch{}, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Watch{}, "", fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return Watch{}, "", fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode == http.StatusUnauthorized:
		// Linear answers an invalid or expired token with 401 whatever
		// was asked; an entity the token may not see is a 200 with an
		// error, or a 400.
		return Watch{}, "", ErrBadToken
	}
	var out struct {
		Data struct {
			Issue *struct {
				ID   string `json:"id"`
				Team struct {
					ID string `json:"id"`
				} `json:"team"`
			} `json:"issue"`
			Team *struct {
				ID string `json:"id"`
			} `json:"team"`
		} `json:"data"`
		Errors []struct {
			Extensions struct {
				Code string `json:"code"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return Watch{}, "", fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	// Linear answers a rate limit as a 400 with a coded error. That is
	// "ask again later", not "you may not": a subscriber renewing many
	// watches must not lose them to it.
	for _, e := range out.Errors {
		if e.Extensions.Code == "RATELIMITED" {
			return Watch{}, "", fmt.Errorf("%w: rate limited", ErrUnverifiable)
		}
	}
	if resp.StatusCode >= 400 || len(out.Errors) > 0 {
		return Watch{}, "", ErrForbidden
	}
	// Linear accepts an issue key or team key where an id is expected, so
	// the lease is bound to the UUID the answer names: doorbells carry
	// UUIDs, and a lease under an alias would never ring.
	switch w.Kind {
	case "issue":
		if out.Data.Issue == nil || out.Data.Issue.ID == "" {
			return Watch{}, "", ErrForbidden
		}
		return Watch{Kind: "issue", ID: out.Data.Issue.ID}, out.Data.Issue.Team.ID, nil
	default:
		if out.Data.Team == nil || out.Data.Team.ID == "" {
			return Watch{}, "", ErrForbidden
		}
		return Watch{Kind: "team", ID: out.Data.Team.ID}, out.Data.Team.ID, nil
	}
}
