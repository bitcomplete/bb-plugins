package hooks

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Alertmanager is the adapter for Alertmanager's webhooks and v2 API.
//
// An alert is named by its fingerprint, which Alertmanager derives from the
// label set and keeps stable across the firing and the resolved delivery; the
// unit is the alert's `namespace` label. The API has no authentication and no
// per-user tokens, so a lease is not proved with a token the subscriber
// presents; see Verify.
type Alertmanager struct {
	// Secret is the bearer token Alertmanager sends, and the only thing
	// that verifies a delivery. Empty disables the adapter, unless
	// SecretFile is set.
	Secret []byte
	// SecretFile, when set, is read on every use instead of Secret; see
	// Linear.SecretFile.
	SecretFile string
	// API is the v2 API root. It is required: with it empty the adapter is
	// off, so a deployment that does not run Alertmanager need not configure
	// one. It is read only to admit a watch, never to fetch an alert.
	API string
	// HTTP makes the verification read; http.DefaultClient when nil.
	HTTP *http.Client
	Now  func() time.Time
}

// Source implements Adapter.
func (*Alertmanager) Source() string { return "alertmanager" }

// Enabled implements Adapter: the bearer token verifies deliveries and the
// API root is what admits a watch, so both are needed. An unset API turns
// the adapter off, which is how a deployment without Alertmanager runs.
func (a *Alertmanager) Enabled() bool {
	return len(a.secret()) > 0 && strings.TrimSpace(a.API) != ""
}

func (a *Alertmanager) secret() []byte {
	if a.SecretFile == "" {
		return a.Secret
	}
	b, err := os.ReadFile(a.SecretFile)
	if err != nil {
		return nil
	}
	return bytes.TrimSpace(b)
}

func (a *Alertmanager) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// UnitKind implements Adapter: a namespace lease receives every alert
// doorbell whose namespace label is that namespace.
func (*Alertmanager) UnitKind(kind string) string {
	if kind == "alert" {
		return "namespace"
	}
	return ""
}

// bearerOK compares the delivery's bearer token in constant time. Alertmanager
// signs nothing, so the token is the whole proof; a missing header, another
// scheme or a wrong token is the same false, and the handler answers 401 with
// no detail for all of them.
func (a *Alertmanager) bearerOK(r *http.Request) bool {
	const prefix = "Bearer "
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(got, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got[len(prefix):]), a.secret()) == 1
}

// alertmanagerPayload is the v4 webhook payload. Only the fields a doorbell
// is built from are decoded; labels, annotations and generatorURL are
// deliberately not carried, because a doorbell is a pointer and the
// subscriber reads the alert from the API.
type alertmanagerPayload struct {
	Alerts []struct {
		Status      string            `json:"status"`
		Labels      map[string]string `json:"labels"`
		Fingerprint string            `json:"fingerprint"`
	} `json:"alerts"`
}

// Webhook implements Adapter: bearer token first, then the payload. One
// doorbell per alert; an alert with no fingerprint or an unknown status is a
// payload that verified but cannot be read (400), because a doorbell needs
// both. An empty alerts list is acknowledged and dropped.
func (a *Alertmanager) Webhook(r *http.Request, body []byte) ([]Doorbell, error) {
	if !a.Enabled() {
		return nil, ErrDisabled
	}
	if !a.bearerOK(r) {
		return nil, ErrUnauthorized
	}
	var p alertmanagerPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, ErrBadRequest
	}
	var bells []Doorbell
	for _, al := range p.Alerts {
		if al.Fingerprint == "" || (al.Status != "firing" && al.Status != "resolved") {
			return nil, ErrBadRequest
		}
		bells = append(bells, Doorbell{
			Source: "alertmanager",
			Kind:   "alert",
			ID:     al.Fingerprint,
			Unit:   al.Labels["namespace"],
			Action: al.Status,
			At:     a.now(),
		})
	}
	return bells, nil
}

// alertmanagerNamespace reports whether id is usable as a Kubernetes
// namespace name: an RFC 1123 label. The value is used as the lease unit and
// ends up in a subscriber's API filter, so anything else is refused up front
// rather than sent as a URL.
func alertmanagerNamespace(id string) bool {
	if id == "" || len(id) > 63 {
		return false
	}
	for i, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i != 0 && i != len(id)-1:
		default:
			return false
		}
	}
	return true
}

// Verify implements Adapter: a namespace watch is admitted by the
// in-namespace subscriber API plus a reachability read of
// GET /api/v2/status. Alertmanager has no per-user tokens, so no token is
// compared and the token argument is ignored; an unreachable Alertmanager is
// ErrUnverifiable, and a watch that is not a namespace is ErrForbidden. It
// never logs the token (there is none to log).
func (a *Alertmanager) Verify(ctx context.Context, _ string, w Watch) (Watch, string, error) {
	if w.Kind != "namespace" || !alertmanagerNamespace(w.ID) {
		return Watch{}, "", ErrForbidden
	}
	if err := a.status(ctx); err != nil {
		return Watch{}, "", err
	}
	return Watch{Kind: "namespace", ID: w.ID}, w.ID, nil
}

// status reads GET /api/v2/status and reports whether Alertmanager answered
// 2xx. Anything else -- a transport error, a 5xx or an unexpected status --
// is ErrUnverifiable, because the point is only that Alertmanager is
// reachable, and the caller retries rather than dropping the watch.
func (a *Alertmanager) status(ctx context.Context) error {
	api := strings.TrimSpace(a.API)
	if api == "" {
		return fmt.Errorf("%w: no Alertmanager API root configured", ErrUnverifiable)
	}
	endpoint := strings.TrimSuffix(api, "/") + "/api/v2/status"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Accept", "application/json")
	client := a.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	}
	return nil
}
