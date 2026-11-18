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
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SentryAPI is where entities are fetched to admit a watch.
const SentryAPI = "https://sentry.io/api/0"

// Sentry is the adapter for Sentry's webhooks and REST API.
//
// Entities are named the way Sentry names them: an issue is its id, a string
// of digits, and the unit is the project's slug. Sentry project slugs are
// unique within an organization, not across the whole installation, so a
// project watch is sent as "org/slug" (the two are needed to fetch it) and
// leased under the slug, which is what doorbells carry.
type Sentry struct {
	// Secret signs deliveries: the internal integration's client secret.
	// Empty disables the adapter, unless SecretFile is set.
	Secret []byte
	// SecretFile, when set, is read on every use instead of Secret; see
	// Linear.SecretFile.
	SecretFile string
	// API is the REST root; SentryAPI when empty.
	API string
	// HTTP makes the verification fetches; http.DefaultClient when nil.
	HTTP *http.Client
	Now  func() time.Time
	// Logger takes the 429 Warn line; slog.Default when nil. It never
	// receives the token, the Authorization header or the body.
	Logger *slog.Logger

	// cooldownMu guards cooldown, which records, per token hash, the instant
	// before which no read is made after a 429. The token itself is never
	// stored, only its hash. Memory only.
	cooldownMu sync.Mutex
	cooldown   map[[32]byte]time.Time

	// issueReadMu guards issueReads, a per-token sliding window of issue
	// read instants. Sentry caps issue-detail reads per token, so the
	// budget below keeps a renewal burst from spending the whole allowance
	// and getting a 429; over budget reads answer like the cooldown. Only
	// the token hash is stored. Memory only.
	issueReadMu sync.Mutex
	issueReads  map[[32]byte][]time.Time
}

// logger is the 429 log sink; slog.Default when none was given.
func (s *Sentry) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Source implements Adapter.
func (*Sentry) Source() string { return "sentry" }

// Enabled implements Adapter.
func (s *Sentry) Enabled() bool { return len(s.secret()) > 0 }

func (s *Sentry) secret() []byte {
	if s.SecretFile == "" {
		return s.Secret
	}
	b, err := os.ReadFile(s.SecretFile)
	if err != nil {
		return nil
	}
	return bytes.TrimSpace(b)
}

func (s *Sentry) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// UnitKind implements Adapter: a project lease receives every doorbell for an
// issue in that project.
func (*Sentry) UnitKind(kind string) string {
	if kind == "issue" {
		return "project"
	}
	return ""
}

// Sign computes the sentry-hook-signature for a body: hex HMAC-SHA256 with
// the internal integration's client secret. Exported for tests and tooling.
func (s *Sentry) Sign(body []byte) string {
	m := hmac.New(sha256.New, s.secret())
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// sentryIssueAlertResource is the sentry-hook-resource header of an issue
// alert ("Issue Alerts", an alert action) delivery. The issue resource is
// "issue".
const sentryIssueAlertResource = "event_alert"

// Webhook implements Adapter. Signature first, then the payload. Sentry
// delivers no timestamp we can bound, so there is no freshness window: a
// replay is a doorbell for an entity the subscriber re-checks anyway. An
// issue webhook, and an issue alert, become an issue doorbell; every other
// resource is acknowledged and dropped.
func (s *Sentry) Webhook(r *http.Request, body []byte) ([]Doorbell, error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	got, err := hex.DecodeString(strings.TrimSpace(r.Header.Get("sentry-hook-signature")))
	if err != nil || len(got) == 0 {
		return nil, ErrUnauthorized
	}
	want, _ := hex.DecodeString(s.Sign(body))
	if !hmac.Equal(got, want) {
		return nil, ErrUnauthorized
	}
	var p struct {
		Action string `json:"action"`
		Data   struct {
			Issue *struct {
				ID      string `json:"id"`
				Project struct {
					Slug string `json:"slug"`
				} `json:"project"`
			} `json:"issue"`
			Event *struct {
				IssueID string `json:"issue_id"`
				URL     string `json:"url"`
			} `json:"event"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrBadRequest
	}
	switch r.Header.Get("sentry-hook-resource") {
	case "issue":
		if p.Data.Issue == nil || p.Data.Issue.ID == "" {
			return nil, ErrBadRequest
		}
		return []Doorbell{{Source: "sentry", Kind: "issue", ID: p.Data.Issue.ID, Unit: p.Data.Issue.Project.Slug, Action: p.Action, At: s.now()}}, nil
	case sentryIssueAlertResource:
		if p.Data.Event == nil || p.Data.Event.IssueID == "" {
			return nil, ErrBadRequest
		}
		return []Doorbell{{Source: "sentry", Kind: "issue", ID: p.Data.Event.IssueID, Unit: sentryProjectSlug(p.Data.Event.URL), Action: p.Action, At: s.now()}}, nil
	default:
		return nil, nil
	}
}

// sentryProjectSlug reads the project slug out of a Sentry API event URL such
// as https://sentry.io/api/0/projects/acme/backend/events/<id>/. An issue
// alert's payload names the project only by id, so this URL is where its slug
// comes from. An URL in another shape yields "".
func sentryProjectSlug(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	for i := 0; i+2 < len(parts); i++ {
		if parts[i] == "projects" {
			return parts[i+2]
		}
	}
	return ""
}

// ParseSentryProject splits "org/slug". The organization is needed to fetch
// the project; the slug alone is what a doorbell carries. Exported for tests
// and tooling.
func ParseSentryProject(id string) (org, slug string, ok bool) {
	org, slug, found := strings.Cut(id, "/")
	if !found || org == "" || slug == "" || strings.Contains(slug, "/") {
		return "", "", false
	}
	if strings.ContainsAny(id, " \t\n?#") {
		return "", "", false
	}
	return org, slug, true
}

// sentryIssueID reports whether id looks like a Sentry issue id: a
// non-empty string of digits. Sentry's ids are numeric, and anything else
// (such as "%zz") would build a URL the API answers unhelpfully rather than
// a clean refusal, so it is forbidden up front.
func sentryIssueID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Verify implements Adapter: REST reads as the token. An issue watch is its
// id; a project watch is "org/slug" and is leased under the project's slug,
// which is the unit doorbells carry. The token goes in a header and nowhere
// else.
func (s *Sentry) Verify(ctx context.Context, token string, w Watch) (Watch, string, error) {
	switch w.Kind {
	case "issue":
		if !sentryIssueID(w.ID) {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			ID      string `json:"id"`
			Project struct {
				Slug string `json:"slug"`
			} `json:"project"`
		}
		if err := s.get(ctx, token, w, "/issues/"+w.ID+"/", &out); err != nil {
			return Watch{}, "", err
		}
		if out.ID == "" {
			return Watch{}, "", ErrForbidden
		}
		return Watch{Kind: "issue", ID: out.ID}, out.Project.Slug, nil
	case "project":
		org, slug, ok := ParseSentryProject(w.ID)
		if !ok {
			return Watch{}, "", ErrForbidden
		}
		var out struct {
			Slug string `json:"slug"`
		}
		if err := s.get(ctx, token, w, "/projects/"+org+"/"+slug+"/", &out); err != nil {
			return Watch{}, "", err
		}
		if out.Slug == "" {
			return Watch{}, "", ErrForbidden
		}
		return Watch{Kind: "project", ID: out.Slug}, out.Slug, nil
	default:
		return Watch{}, "", ErrForbidden
	}
}

// sentryRetryAfterCap bounds how long a 429's Retry-After may pause a verify.
// The verify context (verifyTimeout, 10s) is the outer bound; the cap keeps a
// large Retry-After from eating the whole budget or stalling the subscribe
// call, so it is not slept through.
const sentryRetryAfterCap = 5 * time.Second

// sentryCooldownCap bounds how long a 429 pauses every read for a token. A
// Retry-After beyond it is clamped: an unbounded value would stop renewals for
// that token for as long as Sentry says, which is not the point of a cooldown.
const sentryCooldownCap = time.Hour

// Sentry caps issue-detail reads at 5 per 30 minutes per token. The budget
// leaves one of those five for a real burst or a retry by making at most
// sentryIssueReadBudget live issue reads per sentryIssueReadWindow; a read
// over budget is answered like a 429 cooldown, so subscribe can stale-serve
// a recently verified watch instead of failing it.
const (
	sentryIssueReadBudget = 4
	sentryIssueReadWindow = 30 * time.Minute
)

// errSentryRateLimited is what a 429, and the cooldown that follows one,
// answer: unverifiable (the source could not be asked) and marked rate
// limited. It carries no response detail.
var errSentryRateLimited = fmt.Errorf("%w: %w: status %d", ErrUnverifiable, ErrRateLimited, http.StatusTooManyRequests)

// parseRetryAfter parses a Retry-After header value -- delay-seconds or an
// HTTP-date -- and returns the non-negative delay and whether the value is
// usable. An absent, malformed or negative value is not usable. The delay is
// not capped here; each caller bounds it to its own window.
func parseRetryAfter(value string, now time.Time) (time.Duration, bool) {
	v := strings.TrimSpace(value)
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	t, err := http.ParseTime(v)
	if err != nil {
		return 0, false
	}
	d := t.Sub(now)
	if d < 0 {
		d = 0
	}
	return d, true
}

// retryAfterDelay bounds parseRetryAfter to the in-call retry cap: a value
// larger than sentryRetryAfterCap is not usable, because the retry must not
// eat the verify budget.
func retryAfterDelay(value string, now time.Time) (time.Duration, bool) {
	d, ok := parseRetryAfter(value, now)
	if !ok || d > sentryRetryAfterCap {
		return 0, false
	}
	return d, true
}

// allowIssueRead reports whether token may make another live issue read
// inside the current sentryIssueReadWindow, and records it when so. Reads
// older than the window are forgotten, so the budget is a sliding window,
// not a fixed one that could allow a double burst across a boundary. Only
// issue reads are metered; a project read is not the scarce call.
func (s *Sentry) allowIssueRead(token string) bool {
	k := sha256.Sum256([]byte(token))
	now := s.now()
	s.issueReadMu.Lock()
	defer s.issueReadMu.Unlock()
	if s.issueReads == nil {
		s.issueReads = map[[32]byte][]time.Time{}
	}
	reads := s.issueReads[k]
	kept := reads[:0]
	for _, t := range reads {
		if t.Add(sentryIssueReadWindow).After(now) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= sentryIssueReadBudget {
		s.issueReads[k] = kept
		return false
	}
	s.issueReads[k] = append(kept, now)
	return true
}

// blockUntil records that a 429 for token means no read is made before t. The
// latest instant wins, so an earlier short cooldown cannot shorten a later
// long one.
func (s *Sentry) blockUntil(token string, t time.Time) {
	k := sha256.Sum256([]byte(token))
	s.cooldownMu.Lock()
	defer s.cooldownMu.Unlock()
	if s.cooldown == nil {
		s.cooldown = map[[32]byte]time.Time{}
	}
	// Sweep elapsed entries opportunistically; the map is small and this is
	// the write path, so a token that rotates away does not leave its entry
	// behind forever.
	now := s.now()
	for k, until := range s.cooldown {
		if !until.After(now) {
			delete(s.cooldown, k)
		}
	}
	if t.After(s.cooldown[k]) {
		s.cooldown[k] = t
	}
}

// blocked reports whether token is inside a 429 cooldown. An elapsed entry is
// dropped so the map does not grow with rotated tokens.
func (s *Sentry) blocked(token string) bool {
	k := sha256.Sum256([]byte(token))
	s.cooldownMu.Lock()
	defer s.cooldownMu.Unlock()
	until, ok := s.cooldown[k]
	if !ok {
		return false
	}
	if !until.After(s.now()) {
		delete(s.cooldown, k)
		return false
	}
	return true
}

// observeRateLimit records one 429: a Warn line carrying the response's
// rate-limit headers, and a cooldown that stops reads for this token until
// Retry-After has elapsed. It never logs the token, the Authorization header
// or the body bytes.
func (s *Sentry) observeRateLimit(token string, w Watch, resp *http.Response) {
	now := s.now()
	if d, ok := parseRetryAfter(resp.Header.Get("Retry-After"), now); ok {
		if d > sentryCooldownCap {
			d = sentryCooldownCap
		}
		s.blockUntil(token, now.Add(d))
	}
	attrs := []any{
		"source", s.Source(),
		"kind", w.Kind,
		"id", w.ID,
		"status", resp.StatusCode,
		"retry_after", resp.Header.Get("Retry-After"),
		"rate_limit_limit", resp.Header.Get("X-Sentry-Rate-Limit-Limit"),
		"rate_limit_remaining", resp.Header.Get("X-Sentry-Rate-Limit-Remaining"),
		"rate_limit_reset", resp.Header.Get("X-Sentry-Rate-Limit-Reset"),
		"rate_limit_concurrent", resp.Header.Get("X-Sentry-Rate-Limit-ConcurrentLimit"),
	}
	if w.Kind == "project" {
		if org, slug, ok := ParseSentryProject(w.ID); ok {
			attrs = append(attrs, "org", org, "project", slug)
		}
	}
	s.logger().Warn("sentry rate limited", attrs...)
}

// sleepContext waits for d or until ctx is done, whichever comes first.
func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// get makes one REST read as the token and decodes the answer into out, or
// maps the refusal onto the Adapter errors. A 429 is retried at most once
// when it carries a usable Retry-After, bounded by the cap and the context.
// While a token is inside a 429 cooldown, no read is made at all: the answer
// is the same unverifiable/rate-limited error a live 429 would give. An issue
// read over the per-token budget answers the same way, without a live call.
func (s *Sentry) get(ctx context.Context, token string, w Watch, path string, out any) error {
	if s.blocked(token) {
		return errSentryRateLimited
	}
	api := s.API
	if api == "" {
		api = SentryAPI
	}
	endpoint := strings.TrimSuffix(api, "/") + path
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	// At most one retry: attempt 0 is the first read, attempt 1 the retry
	// after a usable Retry-After. Any second 429 is returned as rate limited.
	for attempt := 0; ; attempt++ {
		// Meter every live issue read, retries included, so the budget is a
		// bound on requests reaching Sentry and not just on get calls.
		if w.Kind == "issue" && !s.allowIssueRead(token) {
			return errSentryRateLimited
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrUnverifiable, err)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("%w: %v", ErrUnverifiable, err)
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			s.observeRateLimit(token, w, resp)
			if attempt == 0 {
				delay, ok := retryAfterDelay(resp.Header.Get("Retry-After"), s.now())
				if ok {
					if err := sleepContext(ctx, delay); err != nil {
						// The deadline cut the wait short; the 429 is still why.
						return errSentryRateLimited
					}
					continue
				}
			}
			return errSentryRateLimited
		}
		switch {
		case resp.StatusCode >= 500:
			return fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
		case resp.StatusCode == http.StatusUnauthorized:
			// A bad or revoked token is 401 whatever was asked. A token that
			// may not see the project gets a 403 or a 404.
			return ErrBadToken
		case resp.StatusCode >= 400:
			return ErrForbidden
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("%w: %v", ErrUnverifiable, err)
		}
		return nil
	}
}
