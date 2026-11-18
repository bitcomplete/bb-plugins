package hooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func alertmanagerRequest(t *testing.T, auth, body string) (*http.Request, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/alertmanager", strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	return req, []byte(body)
}

func TestAlertmanagerWebhook(t *testing.T) {
	const token = "s3cret-token"
	a := &Alertmanager{Secret: []byte(token), API: "http://alertmanager.invalid", Now: func() time.Time { return time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC) }}

	firing := `{"version":"4","groupKey":"{}:{alertname=\"HighErrorRate\"}","status":"firing","receiver":"hooks-service",
		"alerts":[{"status":"firing","labels":{"alertname":"HighErrorRate","namespace":"bb-gate-production","severity":"critical"},
		"annotations":{"summary":"too many errors"},"startsAt":"2026-11-12T11:59:00Z","endsAt":"0001-01-01T00:00:00Z",
		"generatorURL":"http://prometheus.example/graph","fingerprint":"abc123"}]}`
	resolved := `{"version":"4","status":"resolved","receiver":"hooks-service",
		"alerts":[{"status":"resolved","labels":{"alertname":"HighErrorRate","namespace":"bb-gate-production"},"fingerprint":"abc123"}]}`
	multi := `{"version":"4","status":"firing",
		"alerts":[{"status":"firing","labels":{"namespace":"bb-gate-production"},"fingerprint":"f1"},
		          {"status":"resolved","labels":{"namespace":"devbox-production"},"fingerprint":"f2"}]}`
	noNamespace := `{"version":"4","status":"firing",
		"alerts":[{"status":"firing","labels":{"alertname":"ClusterDown"},"fingerprint":"nons"}]}`

	cases := []struct {
		name    string
		auth    string
		body    string
		wantErr error
		want    []Doorbell
	}{
		{"missing bearer", "", firing, ErrUnauthorized, nil},
		{"wrong scheme", "Token " + token, firing, ErrUnauthorized, nil},
		{"wrong bearer", "Bearer nope", firing, ErrUnauthorized, nil},
		{"malformed json", "Bearer " + token, `not json`, ErrBadRequest, nil},
		{"missing fingerprint", "Bearer " + token, `{"alerts":[{"status":"firing","labels":{"namespace":"x"}}]}`, ErrBadRequest, nil},
		{"unknown status", "Bearer " + token, `{"alerts":[{"status":"suppressed","labels":{},"fingerprint":"f"}]}`, ErrBadRequest, nil},
		{"empty alerts", "Bearer " + token, `{"version":"4","alerts":[]}`, nil, nil},
		{
			"firing", "Bearer " + token, firing, nil,
			[]Doorbell{{Source: "alertmanager", Kind: "alert", ID: "abc123", Unit: "bb-gate-production", Action: "firing", At: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)}},
		},
		{
			"resolved", "Bearer " + token, resolved, nil,
			[]Doorbell{{Source: "alertmanager", Kind: "alert", ID: "abc123", Unit: "bb-gate-production", Action: "resolved", At: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)}},
		},
		{
			"multiple", "Bearer " + token, multi, nil,
			[]Doorbell{
				{Source: "alertmanager", Kind: "alert", ID: "f1", Unit: "bb-gate-production", Action: "firing", At: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)},
				{Source: "alertmanager", Kind: "alert", ID: "f2", Unit: "devbox-production", Action: "resolved", At: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)},
			},
		},
		{
			"missing namespace", "Bearer " + token, noNamespace, nil,
			[]Doorbell{{Source: "alertmanager", Kind: "alert", ID: "nons", Unit: "", Action: "firing", At: time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req, body := alertmanagerRequest(t, c.auth, c.body)
			got, err := a.Webhook(req, body)
			if !errors.Is(err, c.wantErr) {
				t.Fatalf("err = %v, want %v", err, c.wantErr)
			}
			if c.wantErr != nil {
				return
			}
			if len(got) != len(c.want) {
				t.Fatalf("doorbells = %+v, want %+v", got, c.want)
			}
			for i := range c.want {
				if got[i] != c.want[i] {
					t.Errorf("doorbell %d = %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestAlertmanagerWebhookDisabled(t *testing.T) {
	a := &Alertmanager{}
	req, body := alertmanagerRequest(t, "Bearer x", `{"alerts":[]}`)
	if _, err := a.Webhook(req, body); !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
}

// TestAlertmanagerDisabledWithoutAPI pins the acceptance rule that the
// adapter is off without an Alertmanager API root, even when the bearer
// token is configured: the URL is what admits a watch, so a deployment that
// does not run Alertmanager stays off.
func TestAlertmanagerDisabledWithoutAPI(t *testing.T) {
	for _, api := range []string{"", "   "} {
		a := &Alertmanager{Secret: []byte("s3cret"), API: api}
		if a.Enabled() {
			t.Fatalf("API %q: Enabled() = true, want false", api)
		}
		req, body := alertmanagerRequest(t, "Bearer s3cret", `{"alerts":[]}`)
		if _, err := a.Webhook(req, body); !errors.Is(err, ErrDisabled) {
			t.Fatalf("API %q: err = %v, want ErrDisabled", api, err)
		}
	}
}

func TestAlertmanagerWebhookSecretFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/alertmanager"
	if err := os.WriteFile(path, []byte("file-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &Alertmanager{SecretFile: path, API: "http://alertmanager.invalid"}
	req, body := alertmanagerRequest(t, "Bearer file-token", `{"alerts":[]}`)
	if _, err := a.Webhook(req, body); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
}

func TestAlertmanagerUnitKind(t *testing.T) {
	a := &Alertmanager{}
	if got := a.UnitKind("alert"); got != "namespace" {
		t.Errorf("UnitKind(alert) = %q, want namespace", got)
	}
	if got := a.UnitKind("issue"); got != "" {
		t.Errorf("UnitKind(issue) = %q, want empty", got)
	}
}

func TestAlertmanagerVerify(t *testing.T) {
	ctx := context.Background()
	reachable := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v2/status" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"status":"success"}`)
	}))
	defer reachable.Close()

	a := &Alertmanager{Secret: []byte("k"), API: reachable.URL}
	got, unit, err := a.Verify(ctx, "", Watch{Kind: "namespace", ID: "bb-gate-production"})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got != (Watch{Kind: "namespace", ID: "bb-gate-production"}) || unit != "bb-gate-production" {
		t.Fatalf("canonical = %+v unit = %q", got, unit)
	}

	cases := []struct {
		name string
		a    *Alertmanager
		w    Watch
		want error
	}{
		{"not a namespace", a, Watch{Kind: "alert", ID: "abc123"}, ErrForbidden},
		{"empty namespace", a, Watch{Kind: "namespace", ID: ""}, ErrForbidden},
		{"bad namespace", a, Watch{Kind: "namespace", ID: "bad ns"}, ErrForbidden},
		{"api 5xx", &Alertmanager{Secret: []byte("k"), API: httptest.NewServer(statusHandler(http.StatusServiceUnavailable, "down")).URL}, Watch{Kind: "namespace", ID: "ns"}, ErrUnverifiable},
		{"api 404", &Alertmanager{Secret: []byte("k"), API: httptest.NewServer(statusHandler(http.StatusNotFound, "nope")).URL}, Watch{Kind: "namespace", ID: "ns"}, ErrUnverifiable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := c.a.Verify(ctx, "ignored", c.w); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
}

func TestAlertmanagerUnverifiableCause(t *testing.T) {
	ctx := context.Background()
	t.Run("transport", func(t *testing.T) {
		a := &Alertmanager{Secret: []byte("k"), API: "https://alertmanager.example.invalid", HTTP: transportFailure()}
		_, _, err := a.Verify(ctx, canaryToken, Watch{Kind: "namespace", ID: "bb-gate-production"})
		checkUnverifiable(t, err, "connection refused")
	})
	t.Run("5xx", func(t *testing.T) {
		srv := httptest.NewServer(statusHandler(http.StatusServiceUnavailable, `{"status":"error"}`))
		defer srv.Close()
		a := &Alertmanager{Secret: []byte("k"), API: srv.URL}
		_, _, err := a.Verify(ctx, canaryToken, Watch{Kind: "namespace", ID: "bb-gate-production"})
		checkUnverifiable(t, err, "status 503")
	})
}

// A namespace watch is admitted without a token, because the Alertmanager API
// has no per-user tokens and the subscriber API is cluster-only; the read of
// /api/v2/status is the only check.
func TestAlertmanagerSubscribeWithoutToken(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":"success"}`)
	}))
	defer api.Close()
	a := &Alertmanager{Secret: []byte("k"), API: api.URL}
	srv := &Server{
		Registry: &Registry{Lease: time.Minute},
		Adapters: []Adapter{a},
		Logger:   slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}
	conn, err := srv.Registry.Open("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"connection":%q,"source":"alertmanager","watches":[{"kind":"namespace","id":"bb-gate-production"}]}`, conn.ID)
	rec := httptest.NewRecorder()
	srv.Subscriber().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/subscribe", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe status = %d: %s", rec.Code, rec.Body.String())
	}
	var out SubscribeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Leases) != 1 || out.Leases[0].Kind != "namespace" || out.Leases[0].ID != "bb-gate-production" || out.Leases[0].Unit != "bb-gate-production" {
		t.Fatalf("leases = %+v", out.Leases)
	}
}
