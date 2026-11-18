package hooks

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"hooks-service/sentryx"
)

// fakeAdapter lets the capture points be reached without a real source.
type fakeAdapter struct {
	verifyErr  error
	webhookErr error
	panic      bool
}

func (f *fakeAdapter) Source() string         { return "linear" }
func (f *fakeAdapter) Enabled() bool          { return true }
func (f *fakeAdapter) UnitKind(string) string { return "" }
func (f *fakeAdapter) Verify(context.Context, string, Watch) (Watch, string, error) {
	return Watch{}, "", f.verifyErr
}
func (f *fakeAdapter) Webhook(*http.Request, []byte) ([]Doorbell, error) {
	if f.panic {
		panic("adapter panic")
	}
	return nil, f.webhookErr
}

func newSentry(t *testing.T) (*sentryx.Client, *sentry.MockTransport) {
	t.Helper()
	t.Setenv("SENTRY_DSN", "")
	mt := &sentry.MockTransport{}
	c, err := sentryx.Init(sentryx.Options{
		Service:   "hooks-service",
		Release:   "rel-9",
		DSN:       "https://public@example.invalid/1",
		Transport: mt,
	})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() {
		c.Close()
		sentryx.Init(sentryx.Options{})
	})
	return c, mt
}

func newServer(a Adapter) *Server {
	return &Server{
		Registry: &Registry{Lease: time.Minute},
		Adapters: []Adapter{a},
		Logger:   slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}
}

func TestSubscribeCaptureHasNoToken(t *testing.T) {
	c, mt := newSentry(t)
	tok := strings.Repeat("z", 6) + "tok"
	// Put the token in the error itself so the scrubber, not just the
	// absence of the token from the capture, is what keeps it out.
	srv := newServer(&fakeAdapter{verifyErr: fmt.Errorf("%w: token=%s", ErrUnverifiable, tok)})
	var logs strings.Builder
	srv.Logger = slog.New(slog.NewJSONHandler(&logs, nil))
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"connection":%q,"source":"linear","token":%q,"watches":[{"kind":"issue","id":"abc"}]}`, conn.ID, tok)
	for i := 1; i <= verifyFailureThreshold; i++ {
		rec := httptest.NewRecorder()
		srv.Subscriber().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/subscribe", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("subscribe %d status = %d", i, rec.Code)
		}
	}
	c.Flush(2 * time.Second)
	evs := mt.Events()
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	blob, _ := json.Marshal(evs[0])
	if strings.Contains(string(blob), tok) {
		t.Errorf("subscribe event leaked the token: %s", blob)
	}
	if strings.Contains(logs.String(), tok) {
		t.Errorf("subscribe log leaked the token: %s", logs.String())
	}
}

func TestSignedDeliveryCaptureHasNoSignature(t *testing.T) {
	c, mt := newSentry(t)
	sig := strings.Repeat("q", 10)
	// The signature header name in the error exercises the signature-header
	// redaction rule at the hooks capture point.
	srv := newServer(&fakeAdapter{webhookErr: fmt.Errorf("%w: linear-signature=%s", ErrBadRequest, sig)})
	req := httptest.NewRequest(http.MethodPost, "/linear", strings.NewReader(`{"action":"update"}`))
	req.Header.Set("Linear-Signature", sig)
	req.Header.Set("Authorization", "Bearer "+sig)
	rec := httptest.NewRecorder()
	srv.Public().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("webhook status = %d", rec.Code)
	}
	c.Flush(2 * time.Second)
	evs := mt.Events()
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	blob, _ := json.Marshal(evs[0])
	if strings.Contains(string(blob), sig) {
		t.Errorf("delivery event leaked the signature: %s", blob)
	}
}

// An unsigned or badly signed delivery is internet noise and is never an
// event; it stays a log line.
func TestUnsignedDeliveryNotCaptured(t *testing.T) {
	c, mt := newSentry(t)
	srv := newServer(&fakeAdapter{webhookErr: ErrUnauthorized})
	rec := httptest.NewRecorder()
	srv.Public().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/linear", strings.NewReader(`{}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("webhook status = %d", rec.Code)
	}
	c.Flush(2 * time.Second)
	if evs := mt.Events(); len(evs) != 0 {
		t.Fatalf("unsigned delivery produced %d events, want 0", len(evs))
	}
}

func TestHooksPanicReported(t *testing.T) {
	c, mt := newSentry(t)
	srv := newServer(&fakeAdapter{panic: true})
	h := c.Recover(srv.Public())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/linear", strings.NewReader(`{}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", rec.Code)
	}
	c.Flush(2 * time.Second)
	evs := mt.Events()
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	if evs[0].Tags["service"] != "hooks-service" || evs[0].Release != "rel-9" {
		t.Errorf("tags = %v release = %q", evs[0].Tags, evs[0].Release)
	}
}
