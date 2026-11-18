package hooks

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// flakyTransport fails the first failN requests with a transport error and
// delegates the rest to base. It counts every call, so a test can assert how
// many attempts Verify made.
type flakyTransport struct {
	failN int64
	calls int64
	base  http.RoundTripper
	cause error
}

func (f *flakyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	n := atomic.AddInt64(&f.calls, 1)
	if n <= f.failN {
		cause := f.cause
		if cause == nil {
			cause = errors.New("dial tcp 203.0.113.1:443: connect: connection refused")
		}
		return nil, &url.Error{Op: "Post", URL: r.URL.String(), Err: cause}
	}
	base := f.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(r)
}

func flakyLinear(t *testing.T, failN int64, cause error) (*Linear, *flakyTransport) {
	t.Helper()
	tr := &flakyTransport{failN: failN, cause: cause}
	return &Linear{Secret: []byte("k"), API: "https://api.linear.app/graphql", HTTP: &http.Client{Transport: tr}}, tr
}

// TestLinearVerifyRetriesTransportOnceThenSucceeds: a first transport failure
// is retried once, and a successful retry admits the watch with its
// canonical id and unit.
func TestLinearVerifyRetriesTransportOnceThenSucceeds(t *testing.T) {
	srv := httptest.NewServer(statusHandler(http.StatusOK, `{"data":{"issue":{"id":"uuid-1","team":{"id":"team-1"}}}}`))
	defer srv.Close()
	tr := &flakyTransport{failN: 1, base: http.DefaultTransport}
	l := &Linear{Secret: []byte("k"), API: srv.URL, HTTP: &http.Client{Transport: tr}}

	w, unit, err := l.Verify(context.Background(), canaryToken, Watch{Kind: "issue", ID: "iss-1"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if w != (Watch{Kind: "issue", ID: "uuid-1"}) || unit != "team-1" {
		t.Fatalf("Verify = %v, %q; want issue/uuid-1, team-1", w, unit)
	}
	if got := atomic.LoadInt64(&tr.calls); got != 2 {
		t.Fatalf("made %d requests, want 2 (one retry)", got)
	}
}

// TestLinearVerifyRetriesTransportThenGivesUp: when both attempts fail, the
// error is still ErrUnverifiable, names the transport cause and leaks no
// token.
func TestLinearVerifyRetriesTransportThenGivesUp(t *testing.T) {
	l, tr := flakyLinear(t, 100, context.DeadlineExceeded)
	_, _, err := l.Verify(context.Background(), canaryToken, Watch{Kind: "issue", ID: "iss-1"})
	if !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("err = %v; want ErrUnverifiable", err)
	}
	if !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("err = %q; want it to name the cause", err)
	}
	if strings.Contains(err.Error(), canaryToken) {
		t.Fatalf("err = %q leaks the token", err)
	}
	if got := atomic.LoadInt64(&tr.calls); got != 2 {
		t.Fatalf("made %d requests, want 2 (one retry)", got)
	}
}

// TestLinearVerifyRetryBoundedByContext: the backoff between attempts is
// bounded by the request context, so a deadline that expires first ends the
// verify without a second request.
func TestLinearVerifyRetryBoundedByContext(t *testing.T) {
	l, tr := flakyLinear(t, 100, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err := l.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "iss-1"})
	if !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("err = %v; want ErrUnverifiable", err)
	}
	if got := atomic.LoadInt64(&tr.calls); got != 1 {
		t.Fatalf("made %d requests, want 1 (the context ended before the retry)", got)
	}
	if elapsed := time.Since(start); elapsed >= linearRetryBackoff {
		t.Fatalf("Verify took %v; the backoff must be bounded by the context", elapsed)
	}
}

// TestLinearVerifyNoRetryOnSourceAnswer: a 4xx, a 401 and a 429 are answers,
// not transport failures, so none is retried.
func TestLinearVerifyNoRetryOnSourceAnswer(t *testing.T) {
	cases := []struct {
		status int
		want   error
	}{
		{http.StatusBadRequest, ErrForbidden},
		{http.StatusForbidden, ErrForbidden},
		{http.StatusNotFound, ErrForbidden},
		{http.StatusUnauthorized, ErrBadToken},
		{http.StatusTooManyRequests, ErrUnverifiable},
	}
	for _, c := range cases {
		t.Run(http.StatusText(c.status), func(t *testing.T) {
			var calls int64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				atomic.AddInt64(&calls, 1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(c.status)
				fmt.Fprint(w, `{"errors":[{"message":"no"}]}`)
			}))
			defer srv.Close()
			l := &Linear{Secret: []byte("k"), API: srv.URL}
			_, _, err := l.Verify(context.Background(), canaryToken, Watch{Kind: "issue", ID: "iss-1"})
			if got := atomic.LoadInt64(&calls); got != 1 {
				t.Fatalf("made %d requests, want 1 (no retry)", got)
			}
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v; want %v", err, c.want)
			}
			if strings.Contains(err.Error(), canaryToken) {
				t.Fatalf("err = %q leaks the token", err)
			}
		})
	}
}

// TestLinearVerifyNoRetryOnGraphQLRateLimit: Linear's coded rate-limit error
// is an answer, and retrying a limiter makes it worse.
func TestLinearVerifyNoRetryOnGraphQLRateLimit(t *testing.T) {
	var calls int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}`)
	}))
	defer srv.Close()
	l := &Linear{Secret: []byte("k"), API: srv.URL}
	_, _, err := l.Verify(context.Background(), canaryToken, Watch{Kind: "issue", ID: "iss-1"})
	if !errors.Is(err, ErrUnverifiable) || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("err = %v; want ErrUnverifiable naming the rate limit", err)
	}
	if got := atomic.LoadInt64(&calls); got != 1 {
		t.Fatalf("made %d requests, want 1 (no retry)", got)
	}
}
