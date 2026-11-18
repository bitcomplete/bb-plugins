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
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestRetryAfterDelay covers the parser directly: seconds, an HTTP-date, and
// the values that make a 429 unretryable.
func TestRetryAfterDelay(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name  string
		value string
		want  time.Duration
		ok    bool
	}{
		{"seconds", "2", 2 * time.Second, true},
		{"zero seconds", "0", 0, true},
		{"padded seconds", " 1 ", time.Second, true},
		{"date within cap", now.Add(3 * time.Second).Format(http.TimeFormat), 3 * time.Second, true},
		{"date in the past", now.Add(-time.Minute).Format(http.TimeFormat), 0, true},
		{"absent", "", 0, false},
		{"garbage", "soon", 0, false},
		{"negative", "-1", 0, false},
		{"fractional seconds", "1.5", 0, false},
		{"seconds beyond cap", "600", 0, false},
		{"date beyond cap", now.Add(time.Hour).Format(http.TimeFormat), 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d, ok := retryAfterDelay(c.value, now)
			if ok != c.ok || d != c.want {
				t.Fatalf("retryAfterDelay(%q) = %v, %v; want %v, %v", c.value, d, ok, c.want, c.ok)
			}
		})
	}
}

// sentryRequestCounter is an httptest handler that answers each request with
// a scripted response and counts them.
type sentryRequestCounter struct {
	mu       sync.Mutex
	requests int
	handler  func(n int, w http.ResponseWriter, r *http.Request)
}

func (c *sentryRequestCounter) serve(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.requests++
	n := c.requests
	c.mu.Unlock()
	c.handler(n, w, r)
}

func (c *sentryRequestCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requests
}

// TestSentryRetriesRateLimitThenSucceeds: a 429 with a usable Retry-After is
// retried once, and a 200 on the retry admits the watch.
func TestSentryRetriesRateLimitThenSucceeds(t *testing.T) {
	c := &sentryRequestCounter{handler: func(n int, w http.ResponseWriter, _ *http.Request) {
		if n == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}}
	srv := httptest.NewServer(http.HandlerFunc(c.serve))
	defer srv.Close()

	s := &Sentry{Secret: []byte("k"), API: srv.URL}
	w, unit, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if w != (Watch{Kind: "project", ID: "web"}) || unit != "web" {
		t.Fatalf("Verify = %v, %q; want project/web, web", w, unit)
	}
	if got := c.count(); got != 2 {
		t.Fatalf("made %d requests, want 2 (one retry)", got)
	}
}

// TestSentryRateLimitAfterRetry: a second 429 after the retry is still
// unverifiable, names the status, and is marked rate limited.
func TestSentryRateLimitAfterRetry(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
	}}
	srv := httptest.NewServer(http.HandlerFunc(c.serve))
	defer srv.Close()

	s := &Sentry{Secret: []byte("k"), API: srv.URL}
	_, _, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"})
	if !errors.Is(err, ErrUnverifiable) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrUnverifiable and ErrRateLimited", err)
	}
	if !strings.Contains(err.Error(), "status 429") {
		t.Fatalf("err = %q; want it to name status 429", err)
	}
	if strings.Contains(err.Error(), canaryToken) {
		t.Fatalf("err = %q leaks the token", err)
	}
	if got := c.count(); got != 2 {
		t.Fatalf("made %d requests, want 2 (one retry)", got)
	}
}

// TestSentryRetryAfterBeyondCap: a Retry-After larger than the cap is not
// slept through; the 429 is returned at once.
func TestSentryRetryAfterBeyondCap(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusTooManyRequests)
	}}
	srv := httptest.NewServer(http.HandlerFunc(c.serve))
	defer srv.Close()

	s := &Sentry{Secret: []byte("k"), API: srv.URL}
	start := time.Now()
	_, _, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Verify took %v; a beyond-cap Retry-After must not be slept", elapsed)
	}
	if !errors.Is(err, ErrUnverifiable) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrUnverifiable and ErrRateLimited", err)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("made %d requests, want 1 (no retry)", got)
	}
}

// TestSentryNoRetryAfterDoesNotRetry: a 429 without a usable Retry-After is
// returned at once, marked rate limited.
func TestSentryNoRetryAfterDoesNotRetry(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}}
	srv := httptest.NewServer(http.HandlerFunc(c.serve))
	defer srv.Close()

	s := &Sentry{Secret: []byte("k"), API: srv.URL}
	_, _, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"})
	if !errors.Is(err, ErrUnverifiable) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrUnverifiable and ErrRateLimited", err)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("made %d requests, want 1 (no retry)", got)
	}
}

// subscribeAndCount runs one subscribe against srv and returns how many
// Sentry events it produced. It installs a fresh Sentry client each call, so
// the client's own deduper cannot hide a capture the counter is meant to
// make; the counter under test lives on srv and is untouched.
func subscribeAndCount(t *testing.T, srv *Server, conn *Conn, token string, watches ...Watch) (int, SubscribeResponse) {
	t.Helper()
	c, mt := newSentry(t)
	body, err := json.Marshal(SubscribeRequest{Connection: conn.ID, Source: "sentry", Token: token, Watches: watches})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.Subscriber().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/subscribe", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp SubscribeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	c.Flush(2 * time.Second)
	return len(mt.Events()), resp
}

// rateLimitedAdapter builds a Server whose Sentry API always answers with
// the handler, and an open connection to subscribe on.
func rateLimitedAdapter(t *testing.T, handler http.HandlerFunc) (*Server, *Conn) {
	t.Helper()
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return srv, conn
}

func always429(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusTooManyRequests)
}

func always503(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusServiceUnavailable)
}

// TestSubscribeRateLimitNeverCaptures: a rate-limited verify never counts
// toward the capture streak, however many renewals in a row are refused, and
// stays rejected as "unverifiable" throughout. A known rate-limit window is a
// log line, not a page.
func TestSubscribeRateLimitNeverCaptures(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, always429)
	watch := Watch{Kind: "project", ID: "acme/web"}

	for i := 1; i <= verifyFailureThreshold+3; i++ {
		n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch)
		if n != 0 {
			t.Fatalf("rate-limited failure %d captured %d events; want 0", i, n)
		}
		if len(resp.Rejected) != 1 || resp.Rejected[0].Reason != "unverifiable" {
			t.Fatalf("rate-limited failure %d rejected = %+v; want one unverifiable", i, resp.Rejected)
		}
	}
}

// TestSubscribeFailureCounterIgnoresToken: the count follows the watch, not
// the credential, so a rotated token does not reset it.
func TestSubscribeFailureCounterIgnoresToken(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, always503)
	watch := Watch{Kind: "project", ID: "acme/web"}

	if n, _ := subscribeAndCount(t, srv, conn, "tok-a", watch); n != 0 {
		t.Fatalf("first failure captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-b", watch); n != 0 {
		t.Fatalf("second failure (other token) captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-a", watch); n != 1 {
		t.Fatalf("third failure captured %d events; want 1", n)
	}
}

// TestSubscribeFailureCounterSeparateWatches: each watch has its own count.
func TestSubscribeFailureCounterSeparateWatches(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, always503)
	one := Watch{Kind: "project", ID: "acme/web"}
	two := Watch{Kind: "project", ID: "acme/api"}

	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", one); n != 0 {
		t.Fatalf("watch one failure 1 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", one); n != 0 {
		t.Fatalf("watch one failure 2 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", two); n != 0 {
		t.Fatalf("watch two failure 1 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", one); n != 1 {
		t.Fatalf("watch one failure 3 captured %d events; want 1", n)
	}
}

// TestSubscribeFailureSuccessResetsCounter: a successful verify clears the
// consecutive count, so the threshold starts over.
func TestSubscribeFailureSuccessResetsCounter(t *testing.T) {
	var mu sync.Mutex
	down := true
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		isDown := down
		mu.Unlock()
		if isDown {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("failure %d captured %d events; want 0", i, n)
		}
	}
	mu.Lock()
	down = false
	mu.Unlock()
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("success captured %d events, leases %+v; want 0 and one lease", n, resp.Leases)
	}
	mu.Lock()
	down = true
	mu.Unlock()
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("after reset, failure %d captured %d events; want 0", i, n)
		}
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("after reset, failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
}

// TestSubscribeNonRateLimitCaptureThreshold: a 5xx is not reported until the
// same watch has failed verifyFailureThreshold times in a row, exactly as a
// rate limit is; the first two are a log line.
func TestSubscribeNonRateLimitCaptureThreshold(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	watch := Watch{Kind: "project", ID: "acme/web"}
	for i := 1; i < verifyFailureThreshold; i++ {
		n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch)
		if n != 0 {
			t.Fatalf("failure %d captured %d events; want 0", i, n)
		}
		if len(resp.Rejected) != 1 || resp.Rejected[0].Reason != "unverifiable" {
			t.Fatalf("failure %d rejected = %+v; want one unverifiable", i, resp.Rejected)
		}
	}
	n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch)
	if n != 1 {
		t.Fatalf("failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
	if len(resp.Rejected) != 1 || resp.Rejected[0].Reason != "unverifiable" {
		t.Fatalf("rejected = %+v; want one unverifiable", resp.Rejected)
	}
}

// TestSubscribeForbiddenResetsCounter: a 403/404 clears the streak, so a
// later transient failure starts counting from one again.
func TestSubscribeForbiddenResetsCounter(t *testing.T) {
	var mu sync.Mutex
	forbidden := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		isForbidden := forbidden
		mu.Unlock()
		if isForbidden {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"errors":[{"message":"not found"}]}`)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("failure %d captured %d events; want 0", i, n)
		}
	}
	mu.Lock()
	forbidden = true
	mu.Unlock()
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 || len(resp.Rejected) != 1 || resp.Rejected[0].Reason != "forbidden" {
		t.Fatalf("forbidden captured %d events, rejected %+v; want 0 and one forbidden", n, resp.Rejected)
	}
	mu.Lock()
	forbidden = false
	mu.Unlock()
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("after reset, failure %d captured %d events; want 0", i, n)
		}
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("after reset, failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
}

// TestSubscribeBadTokenResetsCounter: a 401 clears the streak, so the next
// transient failure starts counting from one again.
func TestSubscribeBadTokenResetsCounter(t *testing.T) {
	var mu sync.Mutex
	status := http.StatusServiceUnavailable
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		s := status
		mu.Unlock()
		w.WriteHeader(s)
	}))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("failure %d captured %d events; want 0", i, n)
		}
	}
	mu.Lock()
	status = http.StatusUnauthorized
	mu.Unlock()
	body, _ := json.Marshal(SubscribeRequest{Connection: conn.ID, Source: "sentry", Token: "tok-1", Watches: []Watch{watch}})
	rec := httptest.NewRecorder()
	srv.Subscriber().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/subscribe", bytes.NewReader(body)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad-token subscribe status = %d, want 401", rec.Code)
	}
	mu.Lock()
	status = http.StatusServiceUnavailable
	mu.Unlock()
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("after reset, failure %d captured %d events; want 0", i, n)
		}
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("after reset, failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
}

// TestSubscribeCacheHitResetsCounter: a verify served from the cache is a
// success for this connection too, so it clears the streak even though this
// connection made no request.
func TestSubscribeCacheHitResetsCounter(t *testing.T) {
	var mu sync.Mutex
	down := true
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		isDown := down
		mu.Unlock()
		if isDown {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	srv.CacheTTL = time.Minute
	conn1, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	conn2, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	// conn1 builds a streak of two.
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn1, "tok-1", watch); n != 0 {
			t.Fatalf("conn1 failure %d captured %d events; want 0", i, n)
		}
	}
	// conn2's success populates the shared cache.
	mu.Lock()
	down = false
	mu.Unlock()
	if n, resp := subscribeAndCount(t, srv, conn2, "tok-1", watch); n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("conn2 success captured %d events, leases %+v; want 0 and one lease", n, resp.Leases)
	}
	// conn1 now gets a cache hit; it must clear conn1's streak.
	if n, resp := subscribeAndCount(t, srv, conn1, "tok-1", watch); n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("conn1 cache hit captured %d events, leases %+v; want 0 and one lease", n, resp.Leases)
	}
	// A different token bypasses the cache, so the streak starts over:
	// two more failures do not capture.
	mu.Lock()
	down = true
	mu.Unlock()
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn1, "tok-2", watch); n != 0 {
			t.Fatalf("after cache hit, failure %d captured %d events; want 0", i, n)
		}
	}
	if n, _ := subscribeAndCount(t, srv, conn1, "tok-2", watch); n != 1 {
		t.Fatalf("after cache hit, failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
}

// TestSubscribeStreakKeyedByConnection: the same watch on a different
// connection has its own streak, so one connection's failures do not report
// another's watch.
func TestSubscribeStreakKeyedByConnection(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, always503)
	other, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
		t.Fatalf("connection one failure 1 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
		t.Fatalf("connection one failure 2 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, other, "tok-1", watch); n != 0 {
		t.Fatalf("connection two failure 1 captured %d events; want 0", n)
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("connection one failure 3 captured %d events; want 1", n)
	}
}

// TestSentryRateLimitLog: a 429 produces one Warn line carrying Retry-After
// and the Sentry rate-limit headers, and never the token, the Authorization
// header or the body bytes.
func TestSentryRateLimitLog(t *testing.T) {
	const body = `{"detail":"slow down canary-body-7d1f"}`
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "600")
		w.Header().Set("X-Sentry-Rate-Limit-Limit", "100")
		w.Header().Set("X-Sentry-Rate-Limit-Remaining", "0")
		w.Header().Set("X-Sentry-Rate-Limit-Reset", "1712345678")
		w.Header().Set("X-Sentry-Rate-Limit-ConcurrentLimit", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, body)
	}))
	defer api.Close()

	var logs strings.Builder
	s := &Sentry{Secret: []byte("k"), API: api.URL, Logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	_, _, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"})
	if !errors.Is(err, ErrUnverifiable) || !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrUnverifiable and ErrRateLimited", err)
	}
	got := logs.String()
	if n := strings.Count(got, "sentry rate limited"); n != 1 {
		t.Fatalf("logged %d rate-limit lines, want 1: %s", n, got)
	}
	for _, want := range []string{"600", "100", "1712345678", "5", "acme", "web", "project", "sentry"} {
		if !strings.Contains(got, want) {
			t.Errorf("log %q missing %q", got, want)
		}
	}
	for _, secret := range []string{canaryToken, "slow down canary-body", "Authorization", "Bearer"} {
		if strings.Contains(got, secret) {
			t.Errorf("log leaked %q: %s", secret, got)
		}
	}
}

// TestSentryCooldownStopsReads: after a 429 for a token, no read is made for
// that token until Retry-After has elapsed; the answer stays unverifiable and
// rate limited. A different token is not paused.
func TestSentryCooldownStopsReads(t *testing.T) {
	var mu sync.Mutex
	var requests int
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.Header().Set("Retry-After", "600")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer api.Close()
	now := time.Date(2026, 10, 26, 22, 0, 0, 0, time.UTC)
	s := &Sentry{Secret: []byte("k"), API: api.URL, Now: func() time.Time { return now }, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}
	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return requests
	}
	rateLimited := func(token string) {
		t.Helper()
		if _, _, err := s.Verify(context.Background(), token, Watch{Kind: "project", ID: "acme/web"}); !errors.Is(err, ErrUnverifiable) || !errors.Is(err, ErrRateLimited) {
			t.Fatalf("Verify(%s) err = %v; want ErrUnverifiable and ErrRateLimited", token, err)
		}
	}

	rateLimited(canaryToken)
	if got := count(); got != 1 {
		t.Fatalf("first read made %d requests, want 1", got)
	}
	// Inside the window: no read at all.
	now = now.Add(9 * time.Minute)
	rateLimited(canaryToken)
	if got := count(); got != 1 {
		t.Fatalf("inside the window made %d requests, want still 1", got)
	}
	// Another token is not in the cooldown.
	rateLimited("other-token")
	if got := count(); got != 2 {
		t.Fatalf("other token made %d requests, want 2", got)
	}
	// Past the window the read happens again.
	now = now.Add(11 * time.Minute)
	rateLimited(canaryToken)
	if got := count(); got != 3 {
		t.Fatalf("after the window made %d requests, want 3", got)
	}
}

// TestSentryCooldownCap: a Retry-After beyond the cap is clamped, so one 429
// cannot pause a token for as long as Sentry claims.
func TestSentryCooldownCap(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "999999")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer api.Close()
	now := time.Date(2026, 10, 26, 22, 0, 0, 0, time.UTC)
	s := &Sentry{Secret: []byte("k"), API: api.URL, Now: func() time.Time { return now }, Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}
	if _, _, err := s.Verify(context.Background(), canaryToken, Watch{Kind: "project", ID: "acme/web"}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v; want ErrRateLimited", err)
	}
	now = now.Add(sentryCooldownCap - time.Second)
	if !s.blocked(canaryToken) {
		t.Fatalf("token not blocked just inside the capped window")
	}
	now = now.Add(2 * time.Second)
	if s.blocked(canaryToken) {
		t.Fatalf("token still blocked just past the capped window")
	}
}

// TestSubscribeCacheHitMakesNoRead: a watch verified once is served from the
// cache on the next renewal, so Sentry sees zero requests for it.
func TestSubscribeCacheHitMakesNoRead(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}}
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	srv.CacheTTL = 6 * time.Hour
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch)
	if n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("first renewal: events %d leases %+v; want 0 and one lease", n, resp.Leases)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("first renewal made %d reads, want 1", got)
	}
	n, resp = subscribeAndCount(t, srv, conn, "tok-1", watch)
	if n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("second renewal: events %d leases %+v; want 0 and one lease", n, resp.Leases)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("second renewal made %d reads in total, want still 1", got)
	}
}

// TestLogVerifyStats: the counter line reports reads and cache hits/misses
// per source since the last call, and the snapshot resets.
func TestLogVerifyStats(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}}
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	var logs strings.Builder
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	srv.Logger = slog.New(slog.NewJSONHandler(&logs, nil))
	srv.CacheTTL = time.Hour
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}
	subscribeAndCount(t, srv, conn, "tok-1", watch) // miss, one read
	subscribeAndCount(t, srv, conn, "tok-1", watch) // hit
	srv.LogVerifyStats()

	var line string
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, "verify reads") {
			line = l
		}
	}
	if line == "" {
		t.Fatalf("no verify-reads line in %s", logs.String())
	}
	for _, want := range []string{`"source":"sentry"`, `"reads":1`, `"hits":1`, `"misses":1`} {
		if !strings.Contains(line, want) {
			t.Errorf("verify-reads line %s missing %s", line, want)
		}
	}
	logs.Reset()
	srv.LogVerifyStats()
	if strings.Contains(logs.String(), "verify reads") {
		t.Fatalf("second call logged again: %s", logs.String())
	}
}

// countingAdapter is a non-Sentry source that counts its verifies, so a test
// can tell a cache hit from a re-read.
type countingAdapter struct {
	source string

	mu    sync.Mutex
	reads int
}

func (a *countingAdapter) Source() string         { return a.source }
func (a *countingAdapter) Enabled() bool          { return true }
func (a *countingAdapter) UnitKind(string) string { return "" }
func (a *countingAdapter) Webhook(*http.Request, []byte) ([]Doorbell, error) {
	return nil, nil
}
func (a *countingAdapter) Verify(context.Context, string, Watch) (Watch, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reads++
	return Watch{Kind: "issue", ID: "iss-1"}, "unit-1", nil
}

func (a *countingAdapter) readCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reads
}

// subscribeSource runs one subscribe for an arbitrary source and returns the
// response.
func subscribeSource(t *testing.T, srv *Server, conn *Conn, source, token string, watches ...Watch) SubscribeResponse {
	t.Helper()
	body, err := json.Marshal(SubscribeRequest{Connection: conn.ID, Source: source, Token: token, Watches: watches})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.Subscriber().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/subscribe", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d: %s", rec.Code, rec.Body.String())
	}
	var resp SubscribeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

// TestVerifyCacheSentryTTLOutlivesOthers: past the shared cache TTL a Linear
// watch re-reads, while a Sentry watch is still a cache hit; past Sentry's own
// longer TTL it re-reads too.
func TestVerifyCacheSentryTTLOutlivesOthers(t *testing.T) {
	now := time.Date(2026, 10, 26, 22, 0, 0, 0, time.UTC)
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}}
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	linear := &countingAdapter{source: "linear"}
	srv := &Server{
		Registry:       &Registry{Lease: time.Minute, Now: func() time.Time { return now }},
		Adapters:       []Adapter{linear, &Sentry{Secret: []byte("k"), API: api.URL}},
		Logger:         slog.New(slog.NewJSONHandler(io.Discard, nil)),
		CacheTTL:       5 * time.Minute,
		SentryCacheTTL: 6 * time.Hour,
	}
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	sentryWatch := Watch{Kind: "project", ID: "acme/web"}
	linearWatch := Watch{Kind: "issue", ID: "iss-1"}

	if resp := subscribeSource(t, srv, conn, "sentry", "tok", sentryWatch); len(resp.Leases) != 1 {
		t.Fatalf("sentry first subscribe leases = %+v; want one", resp.Leases)
	}
	if resp := subscribeSource(t, srv, conn, "linear", "tok", linearWatch); len(resp.Leases) != 1 {
		t.Fatalf("linear first subscribe leases = %+v; want one", resp.Leases)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("first sentry read count = %d, want 1", got)
	}
	if got := linear.readCount(); got != 1 {
		t.Fatalf("first linear read count = %d, want 1", got)
	}

	// Past the shared 5m TTL: linear re-reads, Sentry still hits the cache.
	now = now.Add(5*time.Minute + time.Second)
	if resp := subscribeSource(t, srv, conn, "sentry", "tok", sentryWatch); len(resp.Leases) != 1 {
		t.Fatalf("sentry second subscribe leases = %+v; want one", resp.Leases)
	}
	if resp := subscribeSource(t, srv, conn, "linear", "tok", linearWatch); len(resp.Leases) != 1 {
		t.Fatalf("linear second subscribe leases = %+v; want one", resp.Leases)
	}
	if got := c.count(); got != 1 {
		t.Fatalf("sentry read count after 5m = %d, want still 1 (cache hit)", got)
	}
	if got := linear.readCount(); got != 2 {
		t.Fatalf("linear read count after 5m = %d, want 2 (re-read)", got)
	}

	// Past Sentry's own 6h TTL: it re-reads too.
	now = now.Add(6 * time.Hour)
	if resp := subscribeSource(t, srv, conn, "sentry", "tok", sentryWatch); len(resp.Leases) != 1 {
		t.Fatalf("sentry third subscribe leases = %+v; want one", resp.Leases)
	}
	if got := c.count(); got != 2 {
		t.Fatalf("sentry read count after 6h = %d, want 2 (re-read)", got)
	}
}

// TestVerifyCacheSharedTTLDisabled: a zero -verify-cache disables the cache
// for every source, Sentry included, whatever -sentry-verify-cache says.
func TestVerifyCacheSharedTTLDisabled(t *testing.T) {
	c := &verifyCache{TTL: 0, SentryTTL: 6 * time.Hour}
	w := Watch{Kind: "project", ID: "acme/web"}
	c.put("tok", "sentry", w, w, "web")
	if _, _, ok := c.get("tok", "sentry", w); ok {
		t.Fatal("sentry served from the cache with -verify-cache=0")
	}
}
