package hooks

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// mutableSentryHandler answers each request according to a mode that a test
// flips: "ok" reads the entity, "fail" is a 5xx, and anything else is a 429.
// The mode is guarded so a test can switch it between subscribes.
type mutableSentryHandler struct {
	mu   sync.Mutex
	mode string
}

func (h *mutableSentryHandler) set(mode string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.mode = mode
}

func (h *mutableSentryHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	mode := h.mode
	h.mu.Unlock()
	switch mode {
	case "ok":
		w.Header().Set("Content-Type", "application/json")
		// A project read answers with its slug; an issue read with its id
		// and project. One body satisfies both paths.
		fmt.Fprint(w, `{"id":"123","slug":"web","project":{"slug":"web"}}`)
	case "fail":
		w.WriteHeader(http.StatusServiceUnavailable)
	default:
		w.WriteHeader(http.StatusTooManyRequests)
	}
}

// staleServer builds a Server with a frozen clock, a short Sentry cache TTL
// and a long stale grace, an open connection, and the handler's API. The
// returned now func is the shared clock.
func staleServer(t *testing.T, handler http.Handler) (*Server, *Conn, func(time.Duration)) {
	t.Helper()
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL, Now: func() time.Time { return now }})
	srv.Registry.Now = func() time.Time { return now }
	srv.CacheTTL = time.Minute
	srv.SentryCacheTTL = time.Minute
	srv.SentryVerifyStale = 24 * time.Hour
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return srv, conn, func(d time.Duration) { now = now.Add(d) }
}

// TestSubscribeStaleServeOnRateLimit: a Sentry watch verified within the
// stale grace, whose renewal read is refused with a 429, keeps its lease on
// the stale success instead of being rejected, and the serve clears its
// capture streak.
func TestSubscribeStaleServeOnRateLimit(t *testing.T) {
	h := &mutableSentryHandler{mode: "ok"}
	srv, conn, advance := staleServer(t, h)
	watch := Watch{Kind: "project", ID: "acme/web"}

	// A first success caches the verification.
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("first subscribe: events %d leases %+v; want 0 and one lease", n, resp.Leases)
	}

	// Past the TTL but inside the stale grace, a 5xx builds a streak of one.
	advance(2 * time.Minute)
	h.set("fail")
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 || len(resp.Rejected) != 1 {
		t.Fatalf("failure subscribe: events %d rejected %+v; want 0 and one rejected", n, resp.Rejected)
	}

	// A 429 now stale-serves the cached success: leased, not rejected.
	h.set("rate")
	n, resp := subscribeAndCount(t, srv, conn, "tok-1", watch)
	if n != 0 {
		t.Fatalf("stale-serve captured %d events; want 0", n)
	}
	if len(resp.Leases) != 1 || len(resp.Rejected) != 0 {
		t.Fatalf("stale-serve leases %+v rejected %+v; want one lease and none rejected", resp.Leases, resp.Rejected)
	}

	// The stale serve cleared the streak: the next 5xx failures start at one,
	// so only the third captures.
	h.set("fail")
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("after stale serve, failure %d captured %d events; want 0", i, n)
		}
	}
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("after stale serve, failure %d captured %d events; want 1", verifyFailureThreshold, n)
	}
}

// TestSubscribeStaleServeOverBudget: once the per-token issue-read budget is
// spent, a renewal for a watch verified within the stale grace is served from
// the stale entry, not rejected, and makes no live read.
func TestSubscribeStaleServeOverBudget(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, r *http.Request) {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/issues/"), "/")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":%q,"project":{"slug":"web"}}`, id)
	}}
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL, Now: func() time.Time { return now }})
	srv.Registry.Now = func() time.Time { return now }
	srv.CacheTTL = time.Minute
	srv.SentryCacheTTL = time.Minute
	srv.SentryVerifyStale = 24 * time.Hour
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}

	cached := Watch{Kind: "issue", ID: "1"}
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", cached); n != 0 || len(resp.Leases) != 1 {
		t.Fatalf("first subscribe: events %d leases %+v; want 0 and one lease", n, resp.Leases)
	}
	// Spend the rest of the budget on distinct uncached issue watches.
	for id := 2; id <= sentryIssueReadBudget; id++ {
		w := Watch{Kind: "issue", ID: strconv.Itoa(id)}
		if n, resp := subscribeAndCount(t, srv, conn, "tok-1", w); n != 0 || len(resp.Leases) != 1 {
			t.Fatalf("budget subscribe %d: events %d leases %+v; want 0 and one lease", id, n, resp.Leases)
		}
	}
	if got := c.count(); got != sentryIssueReadBudget {
		t.Fatalf("budget used %d live reads, want %d", got, sentryIssueReadBudget)
	}

	// Past the TTL and over budget: the cached watch is stale-served, not
	// rejected, and Sentry sees no new read.
	now = now.Add(2 * time.Minute)
	n, resp := subscribeAndCount(t, srv, conn, "tok-1", cached)
	if n != 0 || len(resp.Leases) != 1 || len(resp.Rejected) != 0 {
		t.Fatalf("over-budget renewal: events %d leases %+v rejected %+v; want 0, one lease, none rejected", n, resp.Leases, resp.Rejected)
	}
	if got := c.count(); got != sentryIssueReadBudget {
		t.Fatalf("over-budget renewal made %d live reads, want still %d", got, sentryIssueReadBudget)
	}
}

// TestSentryIssueReadBudgetCapsLiveReads: ten distinct uncached issue watches
// in one subscribe make at most sentryIssueReadBudget live reads within the
// window; a second subscribe inside the window adds none, and one past the
// window reads again.
func TestSentryIssueReadBudgetCapsLiveReads(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, r *http.Request) {
		id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/issues/"), "/")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":%q,"project":{"slug":"web"}}`, id)
	}}
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL, Now: func() time.Time { return now }})
	srv.Registry.Now = func() time.Time { return now }
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watches := make([]Watch, 10)
	for i := range watches {
		watches[i] = Watch{Kind: "issue", ID: strconv.Itoa(1000 + i)}
	}

	n, resp := subscribeAndCount(t, srv, conn, "tok-1", watches...)
	if n != 0 {
		t.Fatalf("subscribe captured %d events; want 0", n)
	}
	if len(resp.Leases) != sentryIssueReadBudget || len(resp.Rejected) != len(watches)-sentryIssueReadBudget {
		t.Fatalf("subscribe leases %d rejected %d; want %d and %d", len(resp.Leases), len(resp.Rejected), sentryIssueReadBudget, len(watches)-sentryIssueReadBudget)
	}
	if got := c.count(); got != sentryIssueReadBudget {
		t.Fatalf("subscribe made %d live reads, want %d", got, sentryIssueReadBudget)
	}

	// Inside the window the budget is spent: no further live read.
	now = now.Add(sentryIssueReadWindow - time.Minute)
	subscribeAndCount(t, srv, conn, "tok-1", watches...)
	if got := c.count(); got != sentryIssueReadBudget {
		t.Fatalf("in-window subscribe made %d live reads, want still %d", got, sentryIssueReadBudget)
	}

	// Past the window the budget refills.
	now = now.Add(2 * time.Minute)
	subscribeAndCount(t, srv, conn, "tok-1", watches...)
	if got := c.count(); got != 2*sentryIssueReadBudget {
		t.Fatalf("past-window subscribe made %d live reads, want %d", got, 2*sentryIssueReadBudget)
	}
}

// TestSentryReadBudgetOnlyIssues: the budget meters issue reads only; project
// reads are not the scarce call and are not counted against it.
func TestSentryReadBudgetOnlyIssues(t *testing.T) {
	c := &sentryRequestCounter{handler: func(_ int, w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"slug":"web"}`)
	}}
	api := httptest.NewServer(http.HandlerFunc(c.serve))
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watches := make([]Watch, sentryIssueReadBudget+3)
	for i := range watches {
		watches[i] = Watch{Kind: "project", ID: fmt.Sprintf("acme/web%d", i)}
	}
	if n, resp := subscribeAndCount(t, srv, conn, "tok-1", watches...); n != 0 || len(resp.Leases) != len(watches) {
		t.Fatalf("project subscribe: events %d leases %d; want 0 and %d", n, len(resp.Leases), len(watches))
	}
	if got := c.count(); got != len(watches) {
		t.Fatalf("project subscribe made %d live reads, want %d", got, len(watches))
	}
}

// TestSubscribeRateLimitLogsAndNeverCaptures: a never-verified watch refused
// by a 429 stays unverifiable, logs a Warn, and never captures however many
// rate-limited renewals follow.
func TestSubscribeRateLimitLogsAndNeverCaptures(t *testing.T) {
	srv, conn := rateLimitedAdapter(t, always429)
	var logs strings.Builder
	srv.Logger = slog.New(slog.NewJSONHandler(&logs, nil))
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
	if !strings.Contains(logs.String(), "subscribe verify rate limited") {
		t.Fatalf("no rate-limit Warn logged: %s", logs.String())
	}
}

// TestSubscribeRateLimitDoesNotResetStreak: a rate-limited failure neither
// counts toward nor clears the streak, so a non-429 failure after a run of
// them still captures at the threshold.
func TestSubscribeRateLimitDoesNotResetStreak(t *testing.T) {
	h := &mutableSentryHandler{mode: "fail"}
	api := httptest.NewServer(h)
	defer api.Close()
	srv := newServer(&Sentry{Secret: []byte("k"), API: api.URL})
	srv.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	watch := Watch{Kind: "project", ID: "acme/web"}

	// Two 5xx failures: streak two, no capture.
	for i := 1; i < verifyFailureThreshold; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("failure %d captured %d events; want 0", i, n)
		}
	}
	// Three 429s: no capture, and the streak is untouched.
	h.set("rate")
	for i := 1; i <= 3; i++ {
		if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 0 {
			t.Fatalf("rate-limited failure %d captured %d events; want 0", i, n)
		}
	}
	// One more 5xx reaches the threshold and captures.
	h.set("fail")
	if n, _ := subscribeAndCount(t, srv, conn, "tok-1", watch); n != 1 {
		t.Fatalf("failure after rate limits captured %d events; want 1", n)
	}
}

// TestStaleCacheEntryDroppedAtGraceEnd: a stale success is served inside the
// grace and gone once expires+grace has passed.
func TestStaleCacheEntryDroppedAtGraceEnd(t *testing.T) {
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	c := &verifyCache{TTL: time.Minute, Stale: time.Hour, Now: func() time.Time { return now }}
	w := Watch{Kind: "issue", ID: "1"}
	c.put("tok", "sentry", w, w, "web")

	now = now.Add(2 * time.Minute)
	if _, _, ok := c.getStale("tok", "sentry", w); !ok {
		t.Fatal("stale entry not served inside the grace")
	}
	now = now.Add(time.Hour)
	if _, _, ok := c.getStale("tok", "sentry", w); ok {
		t.Fatal("stale entry served past expires+grace")
	}
}

// TestStaleCacheOnlySentry: the stale grace is Sentry's alone; another
// source's expired entry is not served.
func TestStaleCacheOnlySentry(t *testing.T) {
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	c := &verifyCache{TTL: time.Minute, Stale: time.Hour, Now: func() time.Time { return now }}
	w := Watch{Kind: "issue", ID: "1"}
	c.put("tok", "linear", w, w, "team")

	now = now.Add(2 * time.Minute)
	if _, _, ok := c.getStale("tok", "linear", w); ok {
		t.Fatal("non-Sentry source served a stale entry")
	}
}
