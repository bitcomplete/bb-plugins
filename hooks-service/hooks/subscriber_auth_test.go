package hooks

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSubscriberTokenRequired pins the bearer check on the subscriber API:
// without the configured token every route is refused 401, and with it the
// request reaches the handler. It covers the stream, /v1/subscribe and
// /v1/identify, the three the contract names.
func TestSubscriberTokenRequired(t *testing.T) {
	srv := &Server{
		Registry:        &Registry{Lease: time.Hour},
		Adapters:        []Adapter{},
		SubscriberToken: []byte("s3cret"),
	}
	sub := httptest.NewServer(srv.Subscriber())
	defer sub.Close()

	refused := []struct {
		name, method, path, auth string
	}{
		{"stream no token", http.MethodGet, "/v1/events", ""},
		{"stream wrong token", http.MethodGet, "/v1/events", "Bearer nope"},
		{"stream wrong scheme", http.MethodGet, "/v1/events", "Token s3cret"},
		{"subscribe no token", http.MethodPost, "/v1/subscribe", ""},
		{"subscribe wrong token", http.MethodPost, "/v1/subscribe", "Bearer nope"},
		{"identify no token", http.MethodPost, "/v1/identify", ""},
		{"identify wrong token", http.MethodPost, "/v1/identify", "Bearer nope"},
	}
	for _, c := range refused {
		t.Run(c.name, func(t *testing.T) {
			req, err := http.NewRequest(c.method, sub.URL+c.path, strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			if c.auth != "" {
				req.Header.Set("Authorization", c.auth)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", resp.StatusCode)
			}
		})
	}

	// The right token is not refused: the stream opens, and subscribe and
	// identify reach their own validation (400 for the empty body here).
	t.Run("stream accepted", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, sub.URL+"/v1/events", nil)
		req.Header.Set("Authorization", "Bearer s3cret")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
			t.Fatalf("content-type = %q, want text/event-stream", ct)
		}
		_, _ = io.CopyN(io.Discard, resp.Body, 1)
	})
	for _, c := range []struct{ name, path string }{
		{"subscribe accepted", "/v1/subscribe"},
		{"identify accepted", "/v1/identify"},
	} {
		t.Run(c.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodPost, sub.URL+c.path, strings.NewReader("{}"))
			req.Header.Set("Authorization", "Bearer s3cret")
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusUnauthorized {
				t.Fatalf("status = 401, want the token accepted")
			}
		})
	}
}

// TestSubscriberOpenWithoutToken keeps the opt-out path: with no token the
// subscriber API answers as before, which is what a namespace-isolated
// deployment relies on.
func TestSubscriberOpenWithoutToken(t *testing.T) {
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{}}
	sub := httptest.NewServer(srv.Subscriber())
	defer sub.Close()
	resp, err := http.Get(sub.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

// TestCheckSubscriberAuth pins the startup rule: no token is allowed only on
// a loopback listener or with the explicit opt-out, so a non-loopback
// listener never starts unauthenticated by accident.
func TestCheckSubscriberAuth(t *testing.T) {
	cases := []struct {
		name    string
		listen  string
		token   string
		allow   bool
		wantErr bool
	}{
		{"token set", ":8081", "s3cret", false, false},
		{"token set blank", ":8081", "  ", false, true},
		{"opt-out on all interfaces", ":8081", "", true, false},
		{"loopback ipv4", "127.0.0.1:8081", "", false, false},
		{"loopback ipv6", "[::1]:8081", "", false, false},
		{"loopback hostname", "localhost:8081", "", false, false},
		{"all interfaces", ":8081", "", false, true},
		{"wildcard ipv4", "0.0.0.0:8081", "", false, true},
		{"routable ipv4", "10.1.2.3:8081", "", false, true},
		{"empty", "", "", false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := CheckSubscriberAuth(c.listen, c.token, c.allow)
			if (err != nil) != c.wantErr {
				t.Fatalf("CheckSubscriberAuth(%q, %q, %v) = %v, wantErr %v", c.listen, c.token, c.allow, err, c.wantErr)
			}
		})
	}
}
