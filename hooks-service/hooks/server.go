package hooks

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"hooks-service/sentryx"
)

// Limits on a subscribe call.
const (
	MaxWatches    = 100
	maxBody       = 1 << 20
	verifyWorkers = 8
	keepalive     = 20 * time.Second
	verifyTimeout = 10 * time.Second
)

// Server serves both listeners from one state.
type Server struct {
	Registry *Registry
	Adapters []Adapter
	// CacheTTL is how long a successful verification is remembered.
	CacheTTL time.Duration
	// SentryCacheTTL, when positive, overrides CacheTTL for Sentry. Sentry
	// verify reads are the scarce ones, so they are kept longer than the
	// rest; a non-positive value means every source shares CacheTTL.
	SentryCacheTTL time.Duration
	// SentryVerifyStale is how long past SentryCacheTTL an expired successful
	// Sentry verify may still be served as a success when a renewal is rate
	// limited. Zero disables stale serving.
	SentryVerifyStale time.Duration
	Logger            *slog.Logger
	// Sessions, when set, routes Linear agent session events and serves
	// the reply endpoint. Nil leaves both off: identify still works, and
	// replies answer 503.
	Sessions *Sessions
	// Slack, when set, serves the Slack adapter (POST /slack), the Slack
	// sign-in flow, its identity endpoint and its reply endpoints. Nil
	// leaves all of them off.
	Slack *Slack
	// SubscriberToken, when set, is required as an Authorization: Bearer
	// token on every subscriber API request. Empty leaves the subscriber API
	// open; main.go allows that only when the subscriber listener is bound
	// to loopback or the operator passes the explicit opt-out, so a
	// non-loopback listener never serves unauthenticated.
	SubscriberToken []byte

	once     sync.Once
	byName   map[string]Adapter
	cache    *verifyCache
	stats    *verifyStats
	failures *verifyFailures
	done     chan struct{}
	stop     sync.Once
}

// Close ends every event stream so subscribers reconnect, to the new pod
// during a rollout. http.Server.Shutdown waits for handlers but does not
// cancel their requests, so without this a stream would hold the old pod
// until the deadline while webhooks already arrive at the new one.
func (s *Server) Close() {
	s.init()
	s.stop.Do(func() { close(s.done) })
}

// LogVerifyStats logs the verification cache counters accumulated since the
// last call, one line per source, and resets them. main.go calls it on a
// ticker so the reads hooks makes per interval are measurable.
func (s *Server) LogVerifyStats() {
	s.init()
	for source, c := range s.stats.snapshot() {
		s.Logger.Info("verify reads", "source", source, "reads", c.Misses, "hits", c.Hits, "misses", c.Misses)
	}
}

func (s *Server) init() {
	s.once.Do(func() {
		s.done = make(chan struct{})
		s.byName = map[string]Adapter{}
		for _, a := range s.Adapters {
			s.byName[a.Source()] = a
		}
		s.cache = &verifyCache{TTL: s.CacheTTL, SentryTTL: s.SentryCacheTTL, Stale: s.SentryVerifyStale, Now: s.Registry.Now}
		s.stats = &verifyStats{}
		s.failures = &verifyFailures{}
		if s.Logger == nil {
			s.Logger = slog.Default()
		}
		if s.Sessions != nil {
			if s.Sessions.Registry == nil {
				s.Sessions.Registry = s.Registry
			}
			if s.Sessions.Logger == nil {
				s.Sessions.Logger = s.Logger
			}
			for _, a := range s.Adapters {
				if l, ok := a.(*Linear); ok && l.OnSession == nil {
					l.OnSession = s.Sessions.Handle
				}
			}
		}
		if s.Slack != nil {
			if s.Slack.Registry == nil {
				s.Slack.Registry = s.Registry
			}
			if s.Slack.Logger == nil {
				s.Slack.Logger = s.Logger
			}
		}
	})
}

// Public is the internet-facing handler: POST /<source>.
func (s *Server) Public() http.Handler {
	s.init()
	mux := http.NewServeMux()
	for _, a := range s.Adapters {
		a := a
		mux.HandleFunc("POST /"+a.Source(), func(w http.ResponseWriter, r *http.Request) { s.webhook(a, w, r) })
	}
	if s.Slack != nil {
		mux.HandleFunc("POST /slack", s.Slack.HandleWebhook)
		mux.HandleFunc("POST /slack/interactivity", s.Slack.HandleInteractivity)
	}
	// The per-workspace Linear install, completed by an admin in a browser.
	// The callback URI is registered in the Linear application by hand; the
	// public listener is the only one the internet reaches.
	if s.Sessions != nil {
		mux.HandleFunc("GET /linear/install", s.Sessions.linearInstallStart)
		mux.HandleFunc("GET /linear/install/callback", s.Sessions.linearInstallCallback)
	}
	return mux
}

func (s *Server) webhook(a Adapter, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	bells, err := a.Webhook(r, body)
	switch {
	case err == nil:
	case errors.Is(err, ErrDisabled):
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	case errors.Is(err, ErrUnauthorized):
		s.Logger.Warn("webhook refused", "source", a.Source(), "status", 401, "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	case errors.Is(err, ErrBadRequest):
		s.Logger.Warn("webhook refused", "source", a.Source(), "status", 400, "remote", r.RemoteAddr)
		// The signature verified but the payload could not be read. Unsigned
		// and badly signed deliveries never reach here, so internet noise
		// does not become an issue, and the Sentry adapter's own signature
		// failures do not either. Dedupe keeps a repeated bad shape to one
		// issue.
		sentryx.CaptureError(fmt.Errorf("webhook %s: %w", a.Source(), err), "source", a.Source())
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	default:
		s.Logger.Error("webhook", "source", a.Source(), "err", err)
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	// Delivery is in-memory and fast, so it happens before the 200; the
	// source's five-second budget is not in danger.
	for _, d := range bells {
		sent, dropped := s.Registry.Deliver(a, d)
		s.Logger.Info("doorbell", "source", d.Source, "kind", d.Kind, "id", d.ID, "unit", d.Unit, "action", d.Action, "sent", sent, "dropped", dropped)
	}
	w.WriteHeader(http.StatusOK)
}

// Subscriber is the cluster-only handler: GET /v1/events, POST
// /v1/subscribe, POST /v1/identify and POST
// /v1/linear/sessions/{session}/activity. Every route is behind the
// subscriber bearer token when one is configured.
func (s *Server) Subscriber() http.Handler {
	s.init()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/events", s.events)
	mux.HandleFunc("POST /v1/subscribe", s.subscribe)
	mux.HandleFunc("POST /v1/identify", s.identify)
	mux.HandleFunc("POST /v1/linear/sessions/{session}/activity", s.reply)
	if s.Slack != nil {
		mux.HandleFunc("POST /v1/slack/signin/start", s.Slack.handleSigninStart)
		mux.HandleFunc("POST /v1/slack/signin/exchange", s.Slack.handleSigninExchange)
		mux.HandleFunc("GET /v1/slack/bot/channels", s.Slack.handleBotChannels)
		mux.HandleFunc("POST /v1/slack/bot/join", s.Slack.handleJoin)
		mux.HandleFunc("POST /v1/slack/conversations", s.Slack.handleConversations)
		mux.HandleFunc("POST /v1/slack/ephemeral", s.Slack.handleEphemeral)
		mux.HandleFunc("POST /v1/slack/sessions/{session}/message", s.Slack.handleReply)
		mux.HandleFunc("GET /v1/slack/sessions/{session}/files/{id}", s.Slack.handleFile)
		mux.HandleFunc("POST /v1/slack/sessions/{session}/status", s.Slack.handleStatus)
		mux.HandleFunc("POST /v1/slack/sessions/{session}/title", s.Slack.handleTitle)
	}
	return s.requireSubscriberToken(mux)
}

// requireSubscriberToken wraps the subscriber API in a bearer check. With no
// token configured the handler is returned unchanged: CheckSubscriberAuth in
// main.go is what refuses a non-loopback listener without one.
func (s *Server) requireSubscriberToken(next http.Handler) http.Handler {
	if len(s.SubscriberToken) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		got := r.Header.Get("Authorization")
		var token string
		if strings.HasPrefix(got, prefix) {
			token = strings.TrimSpace(got[len(prefix):])
		}
		if subtle.ConstantTimeCompare([]byte(token), s.SubscriberToken) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="hooks-service"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// CheckSubscriberAuth reports whether the subscriber API may start as
// configured. With no token it must be bound to loopback, unless the
// operator explicitly opted out (a namespace-isolated deployment). A
// non-loopback listener with no token is refused so the API is never
// exposed unauthenticated outside a namespace.
func CheckSubscriberAuth(listen, token string, allowUnauthenticated bool) error {
	if strings.TrimSpace(token) != "" || allowUnauthenticated {
		return nil
	}
	if subscriberListenIsLoopback(listen) {
		return nil
	}
	return fmt.Errorf("subscriber API %q has no bearer token and is not bound to loopback; set -subscribe-token (or BB_HOOKS_SUBSCRIBE_TOKEN), or pass -subscribe-allow-unauthenticated", listen)
}

// subscriberListenIsLoopback reports whether a listen address is bound to
// the loopback interface only. An empty host (":8081") binds every
// interface and is not loopback.
func subscriberListenIsLoopback(listen string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(listen))
	if err != nil {
		host = strings.TrimSpace(listen)
	}
	host = strings.TrimSpace(host)
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		sentryx.CaptureError(errors.New("events: response writer cannot stream"))
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	c, err := s.Registry.Open(remote)
	if err != nil {
		s.Logger.Warn("stream refused", "remote", r.RemoteAddr, "err", err)
		sentryx.CaptureError(fmt.Errorf("events: open stream: %w", err), "remote", r.RemoteAddr)
		http.Error(w, "too many streams", http.StatusTooManyRequests)
		return
	}
	defer func() {
		s.Registry.Close(c)
		if s.Slack != nil {
			s.Slack.forgetConnection(c.ID)
		}
	}()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	hello, _ := json.Marshal(map[string]any{"connection": c.ID, "leaseSeconds": int(s.Registry.Lease / time.Second)})
	fmt.Fprintf(w, "event: hello\ndata: %s\n\n", hello)
	fl.Flush()
	s.Logger.Info("stream opened", "connection", c.ID, "remote", r.RemoteAddr, "streams", s.Registry.Len())
	defer func() { s.Logger.Info("stream closed", "connection", c.ID, "streams", s.Registry.Len()-1) }()

	tick := time.NewTicker(keepalive)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		case <-tick.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				s.captureStreamError(r, c, err)
				return
			}
			fl.Flush()
		case d := <-c.Events:
			data, _ := json.Marshal(d)
			if _, err := fmt.Fprintf(w, "id: %d\nevent: doorbell\ndata: %s\n\n", c.Next(), data); err != nil {
				s.captureStreamError(r, c, err)
				return
			}
			fl.Flush()
		case wk := <-c.Wakes:
			data, _ := json.Marshal(wk)
			if _, err := fmt.Fprintf(w, "id: %d\nevent: session\ndata: %s\n\n", c.Next(), data); err != nil {
				s.captureStreamError(r, c, err)
				return
			}
			fl.Flush()
		case wk := <-c.SlackWakes:
			data, _ := json.Marshal(wk)
			if _, err := fmt.Fprintf(w, "id: %d\nevent: session\ndata: %s\n\n", c.Next(), data); err != nil {
				s.captureStreamError(r, c, err)
				return
			}
			fl.Flush()
		}
	}
}

// captureStreamError reports a write that failed while the request was still
// live. A client that simply disconnected cancels the request context first,
// and that is not an error worth an issue.
func (s *Server) captureStreamError(r *http.Request, c *Conn, err error) {
	if r.Context().Err() != nil {
		return
	}
	sentryx.CaptureError(fmt.Errorf("events: stream write: %w", err), "connection", c.ID, "remote", r.RemoteAddr)
}

// SubscribeRequest is the body of POST /v1/subscribe.
type SubscribeRequest struct {
	Connection string  `json:"connection"`
	Source     string  `json:"source"`
	Token      string  `json:"token"`
	Watches    []Watch `json:"watches"`
}

// Rejected is a watch that was not admitted.
type Rejected struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// SubscribeResponse is the answer to POST /v1/subscribe.
type SubscribeResponse struct {
	Leases   []Lease    `json:"leases"`
	Rejected []Rejected `json:"rejected"`
}

// tokenlessSource reports whether a source admits watches without a token
// the subscriber presents. Slack proves a session lease with a capability
// the wake delivered, and Alertmanager has no per-user tokens at all, so a
// namespace watch rests on the in-namespace subscriber API plus a read of
// its status endpoint; every other source proves one by fetching the entity
// with the subscriber's token.
func tokenlessSource(source string) bool {
	return source == "slack" || source == "alertmanager"
}

func (s *Server) subscribe(w http.ResponseWriter, r *http.Request) {
	var req SubscribeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Whatever happens next, the token leaves with this request.
	token := req.Token
	req.Token = ""
	switch {
	// Slack session leases are proved by the capability in the watch, and
	// Alertmanager namespace leases by the in-namespace subscriber API plus a
	// reachability read (its API has no per-user tokens), so neither needs a
	// token; every other source does.
	case !tokenlessSource(req.Source) && strings.TrimSpace(token) == "", req.Connection == "", req.Source == "":
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	case len(req.Watches) > MaxWatches:
		http.Error(w, "too many watches", http.StatusRequestEntityTooLarge)
		return
	}
	// Validate, and drop repeats: the call is an upsert, so naming an
	// entity twice is one watch.
	seen := map[Watch]bool{}
	watches := req.Watches[:0]
	for _, x := range req.Watches {
		if x.Kind == "" || x.ID == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !seen[x] {
			seen[x] = true
			watches = append(watches, x)
		}
	}
	req.Watches = watches
	// Slack session leases take their own path: the watch carries the
	// capability the wake delivered to the connection's bound Slack user, so
	// admission makes no Slack call and reads no token. A live lease held by
	// another user is rejected "owned".
	if req.Source == "slack" {
		c := s.Registry.Get(req.Connection)
		if c == nil {
			unknownConnection(w)
			return
		}
		s.subscribeSlack(w, c, req.Watches)
		return
	}
	a, ok := s.byName[req.Source]
	if !ok {
		http.Error(w, "unknown source", http.StatusBadRequest)
		return
	}
	if !a.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		// A body the subscriber can tell apart from a 404 for a wrong
		// path, which would otherwise look like a dropped stream forever.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"unknown-connection"}`+"\n")
		return
	}

	type outcome struct {
		canonical Watch
		unit      string
		err       error
	}
	results := make([]outcome, len(req.Watches))
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()
	sem := make(chan struct{}, verifyWorkers)
	var wg sync.WaitGroup
	for i, x := range req.Watches {
		if canonical, unit, hit := s.cache.get(token, req.Source, x); hit {
			// A cached verify is a success for this watch on this
			// connection too, so it clears the streak.
			s.stats.hit(req.Source)
			s.failures.succeed(req.Source, x, c.ID)
			results[i] = outcome{canonical: canonical, unit: unit}
			continue
		}
		s.stats.miss(req.Source)
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, x Watch) {
			defer wg.Done()
			defer func() { <-sem }()
			canonical, unit, err := a.Verify(ctx, token, x)
			switch {
			case err == nil:
				s.cache.put(token, req.Source, x, canonical, unit)
				s.failures.succeed(req.Source, x, c.ID)
			case errors.Is(err, ErrRateLimited):
				// The source could not be asked because it is rate limited.
				// If this token read the watch recently, keep the lease on
				// that stale success instead of dropping a watch that was
				// fine minutes ago; a fresh success is the cache's own hit.
				if sc, su, ok := s.cache.getStale(token, req.Source, x); ok {
					canonical, unit, err = sc, su, nil
					s.failures.succeed(req.Source, x, c.ID)
				}
			}
			results[i] = outcome{canonical: canonical, unit: unit, err: err}
		}(i, x)
	}
	wg.Wait()

	refused := false
	for i, o := range results {
		if errors.Is(o.err, ErrBadToken) {
			// A refused token is not a failing watch: clear its streak so a
			// later renewal with a fresh token starts clean.
			s.failures.succeed(req.Source, req.Watches[i], c.ID)
			refused = true
		}
	}
	if refused {
		http.Error(w, "token refused", http.StatusUnauthorized)
		return
	}
	resp := SubscribeResponse{Leases: []Lease{}, Rejected: []Rejected{}}
	for i, x := range req.Watches {
		switch err := results[i].err; {
		case err == nil:
			resp.Leases = append(resp.Leases, s.Registry.Bind(c, req.Source, results[i].canonical, results[i].unit))
		case errors.Is(err, ErrForbidden):
			// The token may not see the entity (or the source did not find
			// it); that is not a failure to reach the source, so clear the
			// streak.
			s.failures.succeed(req.Source, x, c.ID)
			resp.Rejected = append(resp.Rejected, Rejected{Kind: x.Kind, ID: x.ID, Reason: "forbidden"})
		default:
			resp.Rejected = append(resp.Rejected, Rejected{Kind: x.Kind, ID: x.ID, Reason: "unverifiable"})
			// A rate limit is a known, self-clearing window: it is a log line,
			// and it does not count toward the capture streak, so a burst that
			// stays over Sentry's per-token limit never pages Sentry. Every
			// other transient failure -- a timeout, a transport error, a 5xx
			// -- counts, and is reported once this watch has failed
			// verifyFailureThreshold times in a row on this connection.
			if errors.Is(err, ErrRateLimited) {
				s.Logger.Warn("subscribe verify rate limited", "source", req.Source, "kind", x.Kind, "id", x.ID, "connection", c.ID, "err", sentryx.RedactLine(err.Error(), 0))
				continue
			}
			n := s.failures.fail(req.Source, x, c.ID)
			if n >= verifyFailureThreshold {
				sentryx.CaptureError(fmt.Errorf("subscribe verify %s: %w", req.Source, err), "source", req.Source, "kind", x.Kind)
			} else {
				s.Logger.Warn("subscribe verify failed", "source", req.Source, "kind", x.Kind, "id", x.ID, "connection", c.ID, "streak", n, "err", sentryx.RedactLine(err.Error(), 0))
			}
		}
	}
	sort.Slice(resp.Leases, func(i, j int) bool { return resp.Leases[i].ID < resp.Leases[j].ID })
	s.Logger.Info("subscribe", "connection", c.ID, "source", req.Source, "leased", len(resp.Leases), "rejected", len(resp.Rejected), "held", len(s.Registry.Leases(c, req.Source)))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// subscribeSlack answers POST /v1/subscribe for source "slack". Every watch
// is a session lease proved by the capability in the watch; the connection's
// bound Slack user is the subject, and no Slack call or token read is made.
// A session already leased by another user is rejected "owned"; a forged or
// other-user capability, or a connection with no Slack identity, is rejected
// "forbidden".
func (s *Server) subscribeSlack(w http.ResponseWriter, c *Conn, watches []Watch) {
	if s.Slack == nil {
		http.Error(w, "unknown source", http.StatusBadRequest)
		return
	}
	if !s.Slack.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	resp := SubscribeResponse{Leases: []Lease{}, Rejected: []Rejected{}}
	for _, x := range watches {
		lease, err := s.Slack.admitSession(c, x)
		switch {
		case err == nil:
			resp.Leases = append(resp.Leases, lease)
		case errors.Is(err, ErrOwned):
			resp.Rejected = append(resp.Rejected, Rejected{Kind: x.Kind, ID: x.ID, Reason: "owned"})
		default:
			resp.Rejected = append(resp.Rejected, Rejected{Kind: x.Kind, ID: x.ID, Reason: "forbidden"})
		}
	}
	sort.Slice(resp.Leases, func(i, j int) bool { return resp.Leases[i].ID < resp.Leases[j].ID })
	s.Logger.Info("subscribe", "connection", c.ID, "source", "slack", "leased", len(resp.Leases), "rejected", len(resp.Rejected))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
