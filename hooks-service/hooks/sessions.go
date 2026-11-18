package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"hooks-service/sentryx"
)

// Agent sessions: a mention of the bb app user in Linear opens a session,
// and every created or prompted event on it is routed, fresh and by rule,
// to one developer's server. The service acknowledges it on Linear itself,
// as the app, before any pod is involved; the server that took it replies
// through the service, which mints and holds the app token (apptoken.go)
// so no pod ever does. See "Agent sessions" in docs/hooks.md.

// Limits on agent sessions.
const (
	// DefaultAckBudget bounds reading the issue and posting the
	// acknowledgement. Linear marks a session unresponsive when nothing is
	// posted within ten seconds of created.
	DefaultAckBudget = 8 * time.Second
	// DefaultSessionKeep is how long a server may post to a session after
	// the last event routed to it. Linear recovers a stale session on any
	// activity, so a steward may answer late.
	DefaultSessionKeep = 24 * time.Hour
	maxReplyBody       = 64 << 10
	maxSessions        = 10000
)

// SessionEvent is one agent session event as the Linear adapter read it
// from a verified delivery.
type SessionEvent struct {
	Action  string // created or prompted
	Session string
	// OrganizationID is the Linear workspace the event came from. The app
	// token for that workspace is chosen by it; an event naming none is
	// dropped.
	OrganizationID string
	Issue          string // the issue's UUID; empty for a mention outside an issue
	Asker          string // the Linear user who mentioned or prompted
	Text           string // what they wrote: untrusted input
	At             time.Time
}

// SessionWake is what the chosen server's stream receives as
// `event: session`. It never carries a token.
type SessionWake struct {
	Source  string    `json:"source"`
	Session string    `json:"session"`
	Action  string    `json:"action"`
	Issue   WakeIssue `json:"issue"`
	Asker   Person    `json:"asker"`
	Owner   Person    `json:"owner"`
	// FromOwner is true when the asker is the server's own user. Anyone
	// else's mention is information, not an instruction, until the owner
	// confirms.
	FromOwner bool `json:"fromOwner"`
	// RoutedAs says which rule chose this server: "assignee" or "asker".
	RoutedAs string      `json:"routedAs"`
	Comment  WakeComment `json:"comment"`
	At       time.Time   `json:"at"`
}

// WakeIssue names the issue a session is on.
type WakeIssue struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Team       string `json:"team"`
	TeamKey    string `json:"teamKey"`
}

// WakeComment is the text of the mention or prompt. Untrusted is true
// unless the server's owner wrote it.
type WakeComment struct {
	Text      string `json:"text"`
	Untrusted bool   `json:"untrusted"`
}

// Sessions routes agent session events and posts activities as the app.
// All state is in memory: the app token it minted, and which user each
// session was routed to, so that only that user's server may post to it.
type Sessions struct {
	Registry *Registry
	// ClientID and ClientSecret are the bb application's OAuth client
	// credentials, exchanged for the app token (actor=app) with the client
	// credentials grant. ClientSecretFile, when set, is read at every
	// exchange instead of ClientSecret: a mounted Secret, so the feature
	// turns on when the key appears and follows a rotation. Either empty
	// means disabled.
	ClientID         string
	ClientSecret     []byte
	ClientSecretFile string
	// TokenURL is the OAuth token endpoint; LinearTokenURL when empty.
	// Scope is the scope set requested; DefaultAppScope when empty.
	TokenURL string
	Scope    string
	// API is the GraphQL endpoint; LinearAPI when empty.
	API    string
	HTTP   *http.Client
	Logger *slog.Logger
	// AckBudget is DefaultAckBudget when zero; Keep is DefaultSessionKeep.
	AckBudget time.Duration
	Keep      time.Duration
	Now       func() time.Time
	// StorePath is the per-workspace token store file. Empty keeps installed
	// workspace tokens in memory only, which is enough for tests.
	StorePath string
	// AllowedWorkspaces lists the non-home Linear organization ids an admin
	// may install bb into. The home workspace needs no entry; a workspace not
	// listed cannot be installed and its events are dropped. Empty is the
	// safe default: no non-home install is admitted.
	AllowedWorkspaces []string
	// InstallRedirectURL is the registered OAuth redirect URI for the
	// per-workspace install callback. It has no built-in default: the
	// deployment sets -linear-install-redirect-url.
	InstallRedirectURL string
	// AuthorizeURL is Linear's OAuth authorization endpoint;
	// LinearAuthorizeURL when empty.
	AuthorizeURL string

	tokMu sync.Mutex
	tok   appToken

	// homeMu guards the lazily resolved home organization id.
	homeMu  sync.Mutex
	homeOrg string

	// wsMu serializes refreshes of installed workspace tokens, so two
	// concurrent 401s do not race a rotating refresh token.
	wsMu sync.Mutex

	storeOnce sync.Once
	store     *tokenStore

	mu     sync.Mutex
	routed map[string]map[string]sessionRoute // session → user → route
}

// sessionRoute is where and in which workspace a session was routed.
type sessionRoute struct {
	expires time.Time
	org     string
}

func (s *Sessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Sessions) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Handle takes one event and returns at once; the routing, the
// acknowledgement and the wake happen after the webhook's 200.
func (s *Sessions) Handle(ev SessionEvent) {
	go s.handle(ev)
}

func (s *Sessions) handle(ev SessionEvent) {
	log := s.logger().With("session", ev.Session, "action", ev.Action)
	if !s.Enabled() {
		log.Warn("session dropped: no Linear client credentials")
		return
	}
	budget := s.AckBudget
	if budget <= 0 {
		budget = DefaultAckBudget
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	// The event names the workspace it came from. A workspace with no app
	// token is acknowledged and dropped here, before any Linear call, with
	// one log line naming the organization.
	if ev.OrganizationID == "" {
		log.Warn("session dropped: event names no workspace")
		return
	}
	if _, err := s.tokenFor(ctx, ev.OrganizationID); err != nil {
		if errors.Is(err, ErrNoWorkspace) {
			log.Info("session dropped: no app token for workspace", "organizationId", ev.OrganizationID)
			return
		}
		s.warn(log, "session: workspace app token unavailable", err, "organizationId", ev.OrganizationID)
		return
	}

	if ev.Issue == "" {
		s.ack(ctx, log, ev.OrganizationID, ev.Session, "error", "bb takes mentions on issues only.")
		return
	}
	info, err := s.lookup(ctx, ev.OrganizationID, ev.Issue, ev.Asker)
	if err != nil {
		s.warn(log, "session: issue lookup failed", err, "issue", ev.Issue, "organizationId", ev.OrganizationID)
		s.ack(ctx, log, ev.OrganizationID, ev.Session, "error", "bb could not read this issue to decide whose bb should take it. Mention it again in a minute.")
		return
	}
	r := s.route(info)
	if r.conn == nil {
		log.Info("session not routed", "issue", info.ID, "reason", r.reason)
		s.ack(ctx, log, ev.OrganizationID, ev.Session, "error", r.message)
		return
	}
	s.remember(ev.Session, r.owner.ID, ev.OrganizationID)
	s.ack(ctx, log, ev.OrganizationID, ev.Session, "thought", r.message)

	fromOwner := info.Asker.ID != "" && info.Asker.ID == r.owner.ID
	wake := SessionWake{
		Source:    "linear",
		Session:   ev.Session,
		Action:    ev.Action,
		Issue:     WakeIssue{ID: info.ID, Identifier: info.Identifier, Team: info.Team.ID, TeamKey: info.Team.Key},
		Asker:     info.Asker,
		Owner:     r.owner,
		FromOwner: fromOwner,
		RoutedAs:  r.reason,
		Comment:   WakeComment{Text: ev.Text, Untrusted: !fromOwner},
		At:        ev.At,
	}
	select {
	case r.conn.Wakes <- wake:
		log.Info("session routed", "issue", info.ID, "connection", r.conn.ID, "as", r.reason, "fromOwner", fromOwner, "textLen", len(ev.Text))
	default:
		log.Warn("session wake dropped: stream not reading", "connection", r.conn.ID)
		s.ack(ctx, log, ev.OrganizationID, ev.Session, "error", fmt.Sprintf("%s's bb is not reading its events right now. Mention it again in a minute.", r.owner.Name))
	}
}

func (s *Sessions) ack(ctx context.Context, log *slog.Logger, org, session, kind, body string) {
	if _, err := s.postActivity(ctx, org, session, kind, body); err != nil {
		s.warn(log, "session: activity not posted", err, "kind", kind, "organizationId", org)
	}
}

// warn logs a failed call as the app. Refused client credentials are an
// error an operator must act on: no token can be minted until the sealed
// client secret is right. A token refused even after a fresh mint is the
// same kind of news.
func (s *Sessions) warn(log *slog.Logger, msg string, err error, args ...any) {
	switch {
	case errors.Is(err, ErrClientRefused):
		log.Error(msg+": Linear refused the client credentials; check the sealed client secret and the application's client id", append(args, "err", err)...)
		return
	case errors.Is(err, ErrBadToken):
		log.Error(msg+": Linear refused a freshly minted app token", args...)
		return
	}
	log.Warn(msg, append(args, "err", err)...)
	// A failed mint or reply that is not a credential refusal would
	// otherwise stay in the pod log; report it. The credential refusals
	// above already go out as Error records through the slog handler.
	sentryx.CaptureError(fmt.Errorf("%s: %w", msg, err), args...)
}

type issueInfo struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Team       struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	} `json:"team"`
	Assignee *Person `json:"assignee"`
	Asker    Person  `json:"-"`
}

// lookup reads the issue's team and assignee, and the asker's name, as
// the app: the webhook does not reliably carry the assignee.
func (s *Sessions) lookup(ctx context.Context, org, issue, asker string) (issueInfo, error) {
	q := `query($issue: String!) { issue(id: $issue) { id identifier team { id key } assignee { id name } } }`
	vars := map[string]any{"issue": issue}
	if asker != "" {
		q = `query($issue: String!, $user: String!) { issue(id: $issue) { id identifier team { id key } assignee { id name } } user(id: $user) { id name } }`
		vars["user"] = asker
	}
	var out struct {
		Issue *issueInfo `json:"issue"`
		User  *Person    `json:"user"`
	}
	err := s.asWorkspace(ctx, org, func(tok string) error {
		out.Issue, out.User = nil, nil
		return linearGraphQL(ctx, s.HTTP, s.API, tok, q, vars, &out)
	})
	if err != nil {
		return issueInfo{}, err
	}
	if out.Issue == nil || out.Issue.ID == "" {
		return issueInfo{}, ErrForbidden
	}
	info := *out.Issue
	info.Asker = Person{ID: asker}
	if out.User != nil {
		info.Asker = *out.User
	}
	return info, nil
}

type routing struct {
	conn    *Conn
	owner   Person
	reason  string // assignee, asker, or why there is no route
	message string // the acknowledgement or the error activity
}

// route applies the rule, with no memory of earlier events: the
// assignee's server if they have one connected, and then only if one of
// its projects lists the issue's team (no falling through to the asker);
// else the asker's server; else nobody.
func (s *Sessions) route(info issueInfo) routing {
	if a := info.Assignee; a != nil && a.ID != "" {
		if c, id := s.Registry.ByUser("linear", a.ID); c != nil {
			owner := Person{ID: id.User, Name: nameOr(a.Name, id.Name)}
			if !id.Units[info.Team.ID] {
				return routing{reason: "assignee-team", message: fmt.Sprintf(
					"This issue is assigned to %s, but none of the projects on %s's bb lists team %s, so it cannot take this. Add the team to a project there, or reassign the issue.",
					owner.Name, owner.Name, teamName(info))}
			}
			return routing{conn: c, owner: owner, reason: "assignee", message: fmt.Sprintf(
				"%s's bb is taking this (the issue's assignee).", owner.Name)}
		}
	}
	if c, id := s.Registry.ByUser("linear", info.Asker.ID); c != nil {
		owner := Person{ID: id.User, Name: nameOr(info.Asker.Name, id.Name)}
		return routing{conn: c, owner: owner, reason: "asker", message: fmt.Sprintf(
			"%s's bb is taking this (no assignee with a bb, so it went to the person who asked).", owner.Name)}
	}
	who := "the person who asked"
	if info.Asker.Name != "" {
		who = info.Asker.Name
	}
	if a := info.Assignee; a != nil && a.ID != "" {
		return routing{reason: "none", message: fmt.Sprintf(
			"Nobody's bb covers this issue: neither %s (the assignee) nor %s has a bb server connected right now.", nameOr(a.Name, "the assignee"), who)}
	}
	return routing{reason: "none", message: fmt.Sprintf(
		"Nobody's bb covers this issue: it is unassigned, and %s has no bb server connected right now.", who)}
}

func nameOr(a, b string) string {
	if a != "" {
		return a
	}
	if b != "" {
		return b
	}
	return "someone"
}

func teamName(info issueInfo) string {
	if info.Team.Key != "" {
		return info.Team.Key
	}
	return info.Team.ID
}

// remember records that session was routed to user in org, so that user's
// server may post to it until Keep after the last such event, and the reply
// is made in the workspace it was routed in.
func (s *Sessions) remember(session, user, org string) {
	keep := s.Keep
	if keep <= 0 {
		keep = DefaultSessionKeep
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.routed == nil {
		s.routed = map[string]map[string]sessionRoute{}
	}
	if len(s.routed) >= maxSessions {
		s.sweepLocked(now)
	}
	if len(s.routed) >= maxSessions {
		// Still full of live sessions: drop the one closest to expiring.
		var oldest string
		var at time.Time
		for id, users := range s.routed {
			for _, r := range users {
				if oldest == "" || r.expires.Before(at) {
					oldest, at = id, r.expires
				}
			}
		}
		delete(s.routed, oldest)
	}
	if s.routed[session] == nil {
		s.routed[session] = map[string]sessionRoute{}
	}
	s.routed[session][user] = sessionRoute{expires: now.Add(keep), org: org}
}

func (s *Sessions) sweepLocked(now time.Time) {
	for id, users := range s.routed {
		for u, r := range users {
			if !r.expires.After(now) {
				delete(users, u)
			}
		}
		if len(users) == 0 {
			delete(s.routed, id)
		}
	}
}

// allowed reports whether session was routed to user and has not lapsed.
func (s *Sessions) allowed(session, user string) bool {
	_, ok := s.workspaceOf(session, user)
	return ok
}

// workspaceOf returns the workspace the session was routed in, when the
// route is live. The reply endpoint uses this and never a workspace from a
// pod.
func (s *Sessions) workspaceOf(session, user string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.routed[session][user]
	if !ok || !r.expires.After(s.now()) {
		return "", false
	}
	return r.org, true
}

func (s *Sessions) postActivity(ctx context.Context, org, session, kind, body string) (string, error) {
	var out struct {
		AgentActivityCreate struct {
			Success       bool `json:"success"`
			AgentActivity struct {
				ID string `json:"id"`
			} `json:"agentActivity"`
		} `json:"agentActivityCreate"`
	}
	input := map[string]any{"agentSessionId": session, "content": map[string]any{"type": kind, "body": body}}
	err := s.asWorkspace(ctx, org, func(tok string) error {
		return linearGraphQL(ctx, s.HTTP, s.API, tok,
			`mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }`,
			map[string]any{"input": input}, &out)
	})
	if err != nil {
		return "", err
	}
	if !out.AgentActivityCreate.Success {
		return "", ErrForbidden
	}
	return out.AgentActivityCreate.AgentActivity.ID, nil
}

func (s *Sessions) setExternalURL(ctx context.Context, org, session, link string) error {
	var out struct {
		AgentSessionUpdate struct {
			Success bool `json:"success"`
		} `json:"agentSessionUpdate"`
	}
	input := map[string]any{"externalUrls": []map[string]string{{"label": "bb thread", "url": link}}}
	err := s.asWorkspace(ctx, org, func(tok string) error {
		return linearGraphQL(ctx, s.HTTP, s.API, tok,
			`mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
			map[string]any{"id": session, "input": input}, &out)
	})
	if err != nil {
		return err
	}
	if !out.AgentSessionUpdate.Success {
		return ErrForbidden
	}
	return nil
}

// IdentifyRequest is the body of POST /v1/identify.
type IdentifyRequest struct {
	Connection string `json:"connection"`
	Source     string `json:"source"`
	Token      string `json:"token"`
	// Teams are the units the server's projects cover: for Linear, team
	// UUIDs (keys are accepted and answered as UUIDs).
	Teams []string `json:"teams"`
}

// IdentifyResponse is the answer to POST /v1/identify.
type IdentifyResponse struct {
	User      Person     `json:"user"`
	Teams     []string   `json:"teams"`
	Rejected  []Rejected `json:"rejected"`
	ExpiresAt time.Time  `json:"expiresAt"`
}

// identify proves which user a stream's server acts for, with that user's
// own token, and which teams its projects cover, each checked with the
// same token as a team lease is. The token is used here and forgotten.
func (s *Server) identify(w http.ResponseWriter, r *http.Request) {
	var req IdentifyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token := req.Token
	req.Token = ""
	// Slack has no leases: its identity is proved with a "Sign in with
	// Slack" token and bound to the connection, and its reply endpoints
	// live on the Slack service.
	if req.Source == "slack" {
		if s.Slack == nil {
			http.Error(w, "unknown source", http.StatusBadRequest)
			return
		}
		s.Slack.identify(w, r, req, token)
		return
	}
	switch {
	case strings.TrimSpace(token) == "", req.Connection == "", req.Source == "":
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	case len(req.Teams) > MaxWatches:
		http.Error(w, "too many teams", http.StatusRequestEntityTooLarge)
		return
	}
	a, ok := s.byName[req.Source]
	if !ok {
		http.Error(w, "unknown source", http.StatusBadRequest)
		return
	}
	// The teams a server covers are the units of its issue doorbells, so
	// they are proved as a team lease for issues is.
	idr, ok := a.(Identifier)
	unitKind := a.UnitKind("issue")
	if !ok || unitKind == "" {
		http.Error(w, "source has no identities", http.StatusBadRequest)
		return
	}
	if !a.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()

	who, err := idr.Identify(ctx, token)
	switch {
	case err == nil:
	case errors.Is(err, ErrBadToken):
		http.Error(w, "token refused", http.StatusUnauthorized)
		return
	case errors.Is(err, ErrForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	default:
		http.Error(w, "unverifiable", http.StatusServiceUnavailable)
		return
	}

	seen := map[string]bool{}
	var teams []string
	for _, t := range req.Teams {
		if t != "" && !seen[t] {
			seen[t] = true
			teams = append(teams, t)
		}
	}
	errs := make([]error, len(teams))
	canon := make([]string, len(teams))
	var wg sync.WaitGroup
	sem := make(chan struct{}, verifyWorkers)
	for i, t := range teams {
		x := Watch{Kind: unitKind, ID: t}
		if cw, _, hit := s.cache.get(token, req.Source, x); hit {
			canon[i] = cw.ID
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, x Watch) {
			defer wg.Done()
			defer func() { <-sem }()
			cw, unit, err := a.Verify(ctx, token, x)
			if err == nil {
				s.cache.put(token, req.Source, x, cw, unit)
			}
			canon[i], errs[i] = cw.ID, err
		}(i, x)
	}
	wg.Wait()

	resp := IdentifyResponse{User: who, Teams: []string{}, Rejected: []Rejected{}}
	for i, t := range teams {
		switch err := errs[i]; {
		case err == nil:
			resp.Teams = append(resp.Teams, canon[i])
		case errors.Is(err, ErrBadToken):
			http.Error(w, "token refused", http.StatusUnauthorized)
			return
		case errors.Is(err, ErrForbidden):
			resp.Rejected = append(resp.Rejected, Rejected{Kind: unitKind, ID: t, Reason: "forbidden"})
		default:
			resp.Rejected = append(resp.Rejected, Rejected{Kind: unitKind, ID: t, Reason: "unverifiable"})
		}
	}
	sort.Strings(resp.Teams)
	resp.ExpiresAt = s.Registry.Identify(c, req.Source, who.ID, who.Name, resp.Teams)
	s.Logger.Info("identify", "connection", c.ID, "source", req.Source, "user", who.ID, "teams", len(resp.Teams), "rejected", len(resp.Rejected))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// ReplyRequest is the body of POST /v1/linear/sessions/{session}/activity.
type ReplyRequest struct {
	Connection string `json:"connection"`
	// Kind is response, elicitation or error. The service posts its own
	// thoughts; a server may not.
	Kind string `json:"kind"`
	Body string `json:"body"`
	// ExternalURL, when set, becomes the session's one external link
	// (labelled "bb thread"), set before the activity is posted.
	ExternalURL string `json:"externalUrl,omitempty"`
}

// ReplyResponse is the answer to a reply.
type ReplyResponse struct {
	Activity string `json:"activity"`
}

var replyKinds = map[string]bool{"response": true, "elicitation": true, "error": true}

// reply posts an activity on a session as the app, for the server the
// session was routed to and nobody else. The app token is used here and
// never leaves the service; nothing Linear answers is passed back.
func (s *Server) reply(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	var req ReplyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if session == "" || req.Connection == "" || !replyKinds[req.Kind] || strings.TrimSpace(req.Body) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Body) > maxReplyBody {
		http.Error(w, "body too long", http.StatusRequestEntityTooLarge)
		return
	}
	if req.ExternalURL != "" {
		u, err := url.Parse(req.ExternalURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			http.Error(w, "bad externalUrl", http.StatusBadRequest)
			return
		}
	}
	ss := s.Sessions
	if !ss.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	id, ok := s.Registry.IdentityOf(c, "linear")
	if !ok {
		jsonError(w, http.StatusForbidden, "not-identified")
		return
	}
	org, ok := ss.workspaceOf(session, id.User)
	if !ok {
		s.Logger.Warn("reply refused: session not routed here", "connection", c.ID, "session", session, "user", id.User)
		jsonError(w, http.StatusForbidden, "not-routed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()
	if req.ExternalURL != "" {
		if err := ss.setExternalURL(ctx, org, session, req.ExternalURL); err != nil {
			ss.warn(s.Logger, "reply: external link not set", err, "session", session, "organizationId", org)
			linearFailed(w, err)
			return
		}
	}
	act, err := ss.postActivity(ctx, org, session, req.Kind, req.Body)
	if err != nil {
		ss.warn(s.Logger, "reply: activity not posted", err, "session", session, "kind", req.Kind, "organizationId", org)
		linearFailed(w, err)
		return
	}
	s.Logger.Info("reply", "connection", c.ID, "session", session, "kind", req.Kind, "bodyLen", len(req.Body), "externalUrl", req.ExternalURL != "")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ReplyResponse{Activity: act})
}

// linearFailed answers a refused or failed post without passing on what
// Linear said: 503 when it may work on a retry, 502 when Linear refused.
func linearFailed(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrUnverifiable) || errors.Is(err, context.DeadlineExceeded) {
		jsonError(w, http.StatusServiceUnavailable, "linear-unavailable")
		return
	}
	jsonError(w, http.StatusBadGateway, "linear-refused")
}

func jsonError(w http.ResponseWriter, status int, code string) {
	var b bytes.Buffer
	_ = json.NewEncoder(&b).Encode(map[string]string{"error": code})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b.Bytes())
}

func unknownConnection(w http.ResponseWriter) {
	// A body the subscriber can tell apart from a 404 for a wrong path,
	// which would otherwise look like a dropped stream forever.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, `{"error":"unknown-connection"}`+"\n")
}

// Slack opened conversations (BB-261). A conversation bb opened with POST
// /v1/slack/conversations is recorded keyed by session and indexed by
// channel, so a top-level reply in a DM or group DM can find the single
// conversation bb opened there and the wake can be marked opened. The rest
// of the Slack session state is in slack.go.

// slackOpened is one conversation bb opened: the channel, the owner whose
// server opened it, the connection that did, and when the record lapses. In
// memory only; a restart forgets it, while the capability derived from the
// signing secret still admits the lease.
type slackOpened struct {
	channel string
	user    string
	conn    string
	expires time.Time
}

// rememberOpened records a conversation bb opened, so replies in it route to
// the opener's session and its wakes carry opened:true.
func (s *Slack) rememberOpened(session, channel, user, conn string) {
	if session == "" || channel == "" {
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.opened == nil {
		s.opened = map[string]slackOpened{}
	}
	if s.openedByChannel == nil {
		s.openedByChannel = map[string]map[string]time.Time{}
	}
	if len(s.opened) >= maxSlackSessions {
		for id, o := range s.opened {
			if !o.expires.After(now) {
				delete(s.opened, id)
			}
		}
	}
	if len(s.opened) >= maxSlackSessions {
		// Still full of live records: drop the one closest to expiring, so
		// the cap is a hard bound.
		var oldest string
		var at time.Time
		for id, o := range s.opened {
			if oldest == "" || o.expires.Before(at) {
				oldest, at = id, o.expires
			}
		}
		if oldest != "" {
			if o := s.opened[oldest]; o.channel != "" {
				if m := s.openedByChannel[o.channel]; m != nil {
					delete(m, oldest)
				}
			}
			delete(s.opened, oldest)
		}
	}
	exp := now.Add(DefaultSessionKeep)
	s.opened[session] = slackOpened{channel: channel, user: user, conn: conn, expires: exp}
	m := s.openedByChannel[channel]
	if m == nil {
		m = map[string]time.Time{}
		s.openedByChannel[channel] = m
	}
	m[session] = exp
}

// isOpened reports whether session is a live conversation bb opened.
func (s *Slack) isOpened(session string) bool {
	_, ok := s.openedRecord(session)
	return ok
}

// openedConn returns the connection that opened a live conversation, when
// session is one. A lease on it is accepted only from that connection.
func (s *Slack) openedConn(session string) (string, bool) {
	o, ok := s.openedRecord(session)
	return o.conn, ok
}

// openedRecord returns the live opened conversation for a session, dropping
// a lapsed one on the way out.
func (s *Slack) openedRecord(session string) (slackOpened, bool) {
	if session == "" {
		return slackOpened{}, false
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.opened[session]
	if !ok {
		return slackOpened{}, false
	}
	if !o.expires.After(now) {
		delete(s.opened, session)
		if m := s.openedByChannel[o.channel]; m != nil {
			delete(m, session)
		}
		return slackOpened{}, false
	}
	return o, true
}

// openedLeaseForChannel returns the session of the single conversation bb
// opened in channel that has a live lease, and whether there is exactly one.
// A channel with none, or with more than one, is false: the caller falls
// back to today's routing, so a second open cannot hijack a top-level
// message. It is the per-channel lease lookup the top-level im/mpim rule
// uses.
func (s *Slack) openedLeaseForChannel(channel string) (string, bool) {
	if channel == "" {
		return "", false
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.openedByChannel[channel]
	if m == nil {
		return "", false
	}
	found := ""
	n := 0
	for session, exp := range m {
		if !exp.After(now) {
			delete(m, session)
			delete(s.opened, session)
			continue
		}
		l, ok := s.leases[session]
		if !ok || !l.expires.After(now) {
			continue
		}
		if s.Registry != nil && s.Registry.Get(l.conn) == nil {
			continue
		}
		n++
		found = session
	}
	if len(m) == 0 {
		delete(s.openedByChannel, channel)
	}
	return found, n == 1
}
