package sentryx

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

// testDSN is a syntactically valid DSN with no secret in it: the public key
// is a placeholder and the host cannot resolve. Real DSNs live only in the
// sealed Secret.
const testDSN = "https://public@example.invalid/1"

func newTestClient(t *testing.T, opts Options) (*Client, *sentry.MockTransport) {
	t.Helper()
	t.Setenv("SENTRY_DSN", "")
	mt := &sentry.MockTransport{}
	opts.DSN = testDSN
	opts.Transport = mt
	if opts.Release == "" {
		opts.Release = "test-release"
	}
	c, err := Init(opts)
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() {
		c.Close()
		Init(Options{})
	})
	return c, mt
}

func drain(t *testing.T, c *Client, mt *sentry.MockTransport) []*sentry.Event {
	t.Helper()
	c.Flush(2 * time.Second)
	return mt.Events()
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestDisabled(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	c, err := Init(Options{DSN: " "})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if c.Enabled() {
		t.Fatal("empty DSN should disable Sentry")
	}
	c.CaptureError(errors.New("boom"))
	var buf strings.Builder
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil), c))
	log.Error("hello")
	if !strings.Contains(buf.String(), "hello") {
		t.Fatalf("handler did not pass the record through: %q", buf.String())
	}
}

func TestScrubAndTags(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "hooks-service"})
	c.CaptureError(errors.New("token=abc123 leaked"), "authorization", "Bearer supersecret")
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	e := evs[0]
	if got := e.Tags["service"]; got != "hooks-service" {
		t.Errorf("service tag = %q", got)
	}
	if e.Release != "test-release" {
		t.Errorf("release = %q", e.Release)
	}
	if e.Environment != "production" {
		t.Errorf("environment = %q", e.Environment)
	}
	blob := mustJSON(t, e)
	for _, secret := range []string{"abc123", "supersecret"} {
		if strings.Contains(blob, secret) {
			t.Errorf("event leaked %q: %s", secret, blob)
		}
	}
}

func TestOwnerTag(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "other-service", Owner: "tailnet:1001"})
	c.CaptureError(errors.New("boom"))
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	if got := evs[0].Tags["owner"]; got != "tailnet:1001" {
		t.Errorf("owner tag = %q", got)
	}
}

func TestScrubRequestDropsBodiesAndHeaders(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "hooks-service"})
	// Build the credential values at runtime so they do not appear as
	// literals in this file's stack-trace source context.
	tok := strings.Repeat("a", 5) + "123"
	sig := strings.Repeat("b", 8)
	event := c.client.EventFromMessage("webhook failed", sentry.LevelError)
	event.Request = &sentry.Request{
		Data:    fmt.Sprintf(`{"token":"%s"}`, tok),
		Cookies: "session=" + tok,
		Headers: map[string]string{
			"Authorization":         "Bearer " + tok,
			"sentry-hook-signature": sig,
			"X-Hub-Signature-256":   "sha256=" + sig,
			"Linear-Signature":      sig,
			"X-Forwarded-For":       "203.0.113.9",
		},
	}
	c.client.CaptureEvent(event, nil, nil)
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	blob := mustJSON(t, evs[0])
	for _, secret := range []string{tok, sig} {
		if strings.Contains(blob, secret) {
			t.Errorf("event leaked %q: %s", secret, blob)
		}
	}
}

func TestRedactLine(t *testing.T) {
	cases := []struct{ in, want string }{
		{`authorization: Bearer abc123`, `authorization: Bearer [redacted]`},
		{`token=abc123`, `token=[redacted]`},
		{`api_key: "s3cr3t"`, `api_key: "[redacted]"`},
		{`x-hub-signature-256: sha256=deadbeef`, `x-hub-signature-256: [redacted]`},
		{`sentry-hook-signature=deadbeef`, `sentry-hook-signature=[redacted]`},
		{`nothing sensitive here`, `nothing sensitive here`},
	}
	for _, tc := range cases {
		if got := RedactLine(tc.in, 0); got != tc.want {
			t.Errorf("RedactLine(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := RedactLine(strings.Repeat("x", 500), 10); got != strings.Repeat("x", 10)+"…" {
		t.Errorf("clip = %q", got)
	}
}

func TestPanicRecovered(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "hooks-service"})
	h := c.Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("kaboom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	blob := mustJSON(t, evs[0])
	if !strings.Contains(blob, "kaboom") {
		t.Errorf("event does not name the panic: %s", blob)
	}
}

// TestPanicAbortHandlerNotReported checks that http.ErrAbortHandler, which
// the reverse proxy panics with when a client goes away, is not captured but
// is re-panicked unchanged so net/http still aborts the connection silently.
func TestPanicAbortHandlerNotReported(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "other-service"})
	h := c.Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	}()
	if recovered != http.ErrAbortHandler {
		t.Fatalf("recovered %v, want http.ErrAbortHandler", recovered)
	}
	if evs := drain(t, c, mt); len(evs) != 0 {
		t.Fatalf("got %d events, want 0", len(evs))
	}
}

func TestDedupe(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "hooks-service"})
	c.CaptureError(errors.New("same failure"))
	c.CaptureError(errors.New("same failure"))
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1 (deduped)", len(evs))
	}
}

func TestHandlerForwardsErrorsOnly(t *testing.T) {
	c, mt := newTestClient(t, Options{Service: "hooks-service"})
	tok := strings.Repeat("c", 6) + "9"
	var buf strings.Builder
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil), c))
	log.Info("ignored")
	log.Error("boom", "token", tok)
	evs := drain(t, c, mt)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	if evs[0].Message != "boom" {
		t.Errorf("message = %q", evs[0].Message)
	}
	if !strings.Contains(buf.String(), "ignored") || !strings.Contains(buf.String(), "boom") {
		t.Errorf("records did not reach the wrapped handler: %q", buf.String())
	}
	blob := mustJSON(t, evs[0])
	if strings.Contains(blob, tok) {
		t.Errorf("event leaked the token: %s", blob)
	}
}

// TestHandlerForwardsWithAttrs pins that a logger.With attr reaches the
// wrapped handler's output, not only the Sentry extras. The hooks adapter
// builds its routing lines with With("session", …), and those fields went
// missing in production because WithAttrs never forwarded to inner.
func TestHandlerForwardsWithAttrs(t *testing.T) {
	c, _ := newTestClient(t, Options{Service: "hooks-service"})
	var buf strings.Builder
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil), c))
	log.With("session", "D-1:111.222", "action", "message").Info("slack session routed", "connection", "conn-1")
	out := buf.String()
	for _, want := range []string{"session", "D-1:111.222", "action", "message", "connection", "conn-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}

// TestHandlerForwardsWithGroup pins that a WithGroup attr reaches the wrapped
// handler grouped as slog groups it, while the Sentry extras stay keyed by the
// dotted group path.
func TestHandlerForwardsWithGroup(t *testing.T) {
	c, _ := newTestClient(t, Options{Service: "hooks-service"})
	var buf strings.Builder
	log := slog.New(NewHandler(slog.NewJSONHandler(&buf, nil), c))
	log.WithGroup("slack").With("session", "D-1:111.222").Info("slack session routed")
	out := buf.String()
	for _, want := range []string{"slack", "session", "D-1:111.222"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q: %s", want, out)
		}
	}
}
