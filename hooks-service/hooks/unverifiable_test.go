package hooks

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// canaryToken is a recognisable credential. No error text may contain it.
const canaryToken = "canary-token-9f3a2b"

// statusHandler answers every request with one status and body.
func statusHandler(status int, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// transportFailure makes every request fail as a *url.Error whose URL carries
// the token, so printing the transport error verbatim would leak it. The
// wrapped error must name the inner cause instead.
func transportFailure() *http.Client {
	return &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, &url.Error{
			Op:  "Get",
			URL: "https://api.example.invalid/v1?access_token=" + canaryToken,
			Err: errors.New("dial tcp 203.0.113.1:443: connect: connection refused"),
		}
	})}
}

// checkUnverifiable asserts the three properties every ErrUnverifiable return
// must keep: it is still the sentinel, it names its cause, and it carries no
// token.
func checkUnverifiable(t *testing.T, err error, cause string) {
	t.Helper()
	if !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("errors.Is(err, ErrUnverifiable) = false; err = %v", err)
	}
	if !strings.Contains(err.Error(), cause) {
		t.Errorf("error %q does not name the cause %q", err, cause)
	}
	if strings.Contains(err.Error(), canaryToken) {
		t.Errorf("error %q leaks the token", err)
	}
}

func TestSentryUnverifiableCause(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name  string
		serve http.HandlerFunc
		cause string
	}{
		{"5xx", statusHandler(http.StatusServiceUnavailable, `{"detail":"down"}`), "status 503"},
		{"429", statusHandler(http.StatusTooManyRequests, `{"detail":"throttled"}`), "status 429"},
		{"bad json", statusHandler(http.StatusOK, `not json`), "invalid character"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(c.serve)
			defer srv.Close()
			s := &Sentry{Secret: []byte("k"), API: srv.URL + "/api/0"}
			_, _, err := s.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "1234567890"})
			checkUnverifiable(t, err, c.cause)
		})
	}
	t.Run("transport", func(t *testing.T) {
		s := &Sentry{Secret: []byte("k"), API: "https://api.example.invalid/api/0", HTTP: transportFailure()}
		_, _, err := s.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "1234567890"})
		checkUnverifiable(t, err, "connection refused")
	})
}

func TestGitHubUnverifiableCause(t *testing.T) {
	ctx := context.Background()
	rateLimited := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
	}
	cases := []struct {
		name  string
		serve http.HandlerFunc
		cause string
	}{
		{"5xx", statusHandler(http.StatusBadGateway, `{"message":"down"}`), "status 502"},
		{"429", statusHandler(http.StatusTooManyRequests, `{"message":"throttled"}`), "status 429"},
		{"rate limited 403", rateLimited, "status 403"},
		{"bad json", statusHandler(http.StatusOK, `not json`), "invalid character"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(c.serve)
			defer srv.Close()
			g := &GitHub{Secret: []byte("k"), API: srv.URL}
			_, _, err := g.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "Acme/Widgets#7"})
			checkUnverifiable(t, err, c.cause)
		})
	}
	t.Run("transport", func(t *testing.T) {
		g := &GitHub{Secret: []byte("k"), API: "https://api.example.invalid", HTTP: transportFailure()}
		_, _, err := g.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "Acme/Widgets#7"})
		checkUnverifiable(t, err, "connection refused")
	})
}

func TestLinearUnverifiableCause(t *testing.T) {
	ctx := context.Background()
	rateLimited := statusHandler(http.StatusOK, `{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}`)
	cases := []struct {
		name  string
		serve http.HandlerFunc
		cause string
	}{
		{"5xx", statusHandler(http.StatusInternalServerError, `{"errors":[{"message":"boom"}]}`), "status 500"},
		{"429", statusHandler(http.StatusTooManyRequests, `{"errors":[{"message":"throttled"}]}`), "status 429"},
		{"graphql rate limited", rateLimited, "rate limited"},
		{"bad json", statusHandler(http.StatusOK, `not json`), "invalid character"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(c.serve)
			defer srv.Close()
			l := &Linear{Secret: []byte("k"), API: srv.URL}
			_, _, err := l.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "iss-1"})
			checkUnverifiable(t, err, c.cause)
		})
	}
	t.Run("transport", func(t *testing.T) {
		l := &Linear{Secret: []byte("k"), API: "https://api.linear.app/graphql", HTTP: transportFailure()}
		_, _, err := l.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "iss-1"})
		checkUnverifiable(t, err, "connection refused")
	})
	t.Run("timeout", func(t *testing.T) {
		// A client.Do deadline is a transport error too; the retry keeps the
		// wrapped cause and the token out of the error.
		l := &Linear{Secret: []byte("k"), API: "https://api.linear.app/graphql", HTTP: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, &url.Error{Op: "Post", URL: "https://api.linear.app/graphql", Err: context.DeadlineExceeded}
		})}}
		_, _, err := l.Verify(ctx, canaryToken, Watch{Kind: "issue", ID: "iss-1"})
		checkUnverifiable(t, err, "context deadline exceeded")
	})
}
