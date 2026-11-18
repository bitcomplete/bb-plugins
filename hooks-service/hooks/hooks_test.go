package hooks

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeLinear stands in for api.linear.app: it admits a token to a fixed
// set of issues and teams and records the tokens it saw.
type fakeLinear struct {
	mu     sync.Mutex
	issues map[string]string // issue id → team id
	teams  map[string]bool
	token  string
	calls  int
	down   bool
}

func (f *fakeLinear) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		if f.down {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			http.Error(w, `{"errors":[{"message":"Authentication required"}]}`, http.StatusUnauthorized)
			return
		}
		var q struct {
			Query     string            `json:"query"`
			Variables map[string]string `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		id := q.Variables["id"]
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(q.Query, "issue("):
			if team, ok := f.issues[id]; ok {
				fmt.Fprintf(w, `{"data":{"issue":{"id":%q,"team":{"id":%q}}}}`, id, team)
			} else {
				fmt.Fprint(w, `{"data":{"issue":null},"errors":[{"message":"Entity not found: Issue"}]}`)
			}
		default:
			if f.teams[id] {
				fmt.Fprintf(w, `{"data":{"team":{"id":%q}}}`, id)
			} else {
				fmt.Fprint(w, `{"data":{"team":null},"errors":[{"message":"Entity not found: Team"}]}`)
			}
		}
	})
}

type fixture struct {
	t       *testing.T
	now     time.Time
	linear  *Linear
	api     *fakeLinear
	srv     *Server
	public  *httptest.Server
	sub     *httptest.Server
	nowFunc func() time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, now: time.Date(2026, 10, 10, 17, 0, 0, 0, time.UTC)}
	f.nowFunc = func() time.Time { return f.now }
	f.api = &fakeLinear{issues: map[string]string{"iss-1": "team-a", "iss-2": "team-b"}, teams: map[string]bool{"team-a": true}, token: "tok-dev"}
	apiSrv := httptest.NewServer(f.api.handler())
	t.Cleanup(apiSrv.Close)
	f.linear = &Linear{Secret: []byte("s3cret"), API: apiSrv.URL, Now: f.nowFunc}
	f.srv = &Server{Registry: &Registry{Lease: time.Hour, Now: f.nowFunc}, Adapters: []Adapter{f.linear}, CacheTTL: 5 * time.Minute}
	f.public = httptest.NewServer(f.srv.Public())
	t.Cleanup(f.public.Close)
	f.sub = httptest.NewServer(f.srv.Subscriber())
	t.Cleanup(f.sub.Close)
	return f
}

// stream opens /v1/events and returns the connection id and a channel of
// doorbells.
func (f *fixture) stream() (string, <-chan Doorbell, func()) {
	f.t.Helper()
	resp, err := http.Get(f.sub.URL + "/v1/events")
	if err != nil {
		f.t.Fatal(err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		f.t.Fatalf("content-type %q", ct)
	}
	events := make(chan Doorbell, 16)
	helloc := make(chan string, 1)
	go func() {
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		var event, data string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			case line == "":
				switch event {
				case "hello":
					var h struct {
						Connection string `json:"connection"`
					}
					_ = json.Unmarshal([]byte(data), &h)
					helloc <- h.Connection
				case "doorbell":
					var d Doorbell
					_ = json.Unmarshal([]byte(data), &d)
					events <- d
				}
				event, data = "", ""
			}
		}
	}()
	select {
	case id := <-helloc:
		return id, events, func() { resp.Body.Close() }
	case <-time.After(5 * time.Second):
		f.t.Fatal("no hello")
		return "", nil, nil
	}
}

func (f *fixture) subscribe(conn, token string, watches ...Watch) (int, SubscribeResponse) {
	f.t.Helper()
	body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "linear", Token: token, Watches: watches})
	resp, err := http.Post(f.sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out SubscribeResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			f.t.Fatal(err)
		}
	}
	return resp.StatusCode, out
}

func (f *fixture) deliver(typ, action string, data map[string]any, sign bool) int {
	f.t.Helper()
	payload := map[string]any{"action": action, "type": typ, "data": data, "webhookTimestamp": f.now.UnixMilli(), "organizationId": "org"}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/linear", bytes.NewReader(body))
	if sign {
		req.Header.Set("Linear-Signature", f.linear.Sign(body))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func expect(t *testing.T, events <-chan Doorbell, id string) {
	t.Helper()
	select {
	case d := <-events:
		if d.ID != id || d.Kind != "issue" || d.Source != "linear" {
			t.Fatalf("got %+v, want issue %s", d, id)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("no doorbell for %s", id)
	}
}

func expectNone(t *testing.T, events <-chan Doorbell) {
	t.Helper()
	select {
	case d := <-events:
		t.Fatalf("unexpected doorbell %+v", d)
	case <-time.After(150 * time.Millisecond):
	}
}

// sameDoorbell compares two doorbells by value, including the Deployment and
// WorkflowRun objects behind their pointers, so two separately built bells
// with the same fields are equal.
func sameDoorbell(a, b Doorbell) bool {
	ad, bd := a.Deployment, b.Deployment
	aw, bw := a.WorkflowRun, b.WorkflowRun
	a.Deployment, b.Deployment = nil, nil
	a.WorkflowRun, b.WorkflowRun = nil, nil
	if a != b || (ad == nil) != (bd == nil) || (aw == nil) != (bw == nil) {
		return false
	}
	if ad != nil && *ad != *bd {
		return false
	}
	return aw == nil || *aw == *bw
}

func TestSubscribeThenDoorbell(t *testing.T) {
	f := newFixture(t)
	conn, events, closeStream := f.stream()
	defer closeStream()

	status, out := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"}, Watch{Kind: "issue", ID: "nope"})
	if status != 200 {
		t.Fatalf("subscribe status %d", status)
	}
	if len(out.Leases) != 1 || out.Leases[0].ID != "iss-1" || out.Leases[0].Unit != "team-a" {
		t.Fatalf("leases %+v", out.Leases)
	}
	if !out.Leases[0].ExpiresAt.Equal(f.now.Add(time.Hour)) {
		t.Fatalf("expires %v", out.Leases[0].ExpiresAt)
	}
	if len(out.Rejected) != 1 || out.Rejected[0].Reason != "forbidden" {
		t.Fatalf("rejected %+v", out.Rejected)
	}

	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true); s != 200 {
		t.Fatalf("webhook status %d", s)
	}
	expect(t, events, "iss-1")

	// A comment on the watched issue rings the same bell.
	f.deliver("Comment", "create", map[string]any{"id": "c1", "issueId": "iss-1", "issue": map[string]any{"id": "iss-1", "teamId": "team-a"}}, true)
	expect(t, events, "iss-1")

	// An unwatched issue, and a type nobody listens for, ring nothing.
	f.deliver("Issue", "update", map[string]any{"id": "iss-2", "teamId": "team-b"}, true)
	f.deliver("Project", "update", map[string]any{"id": "p1"}, true)
	expectNone(t, events)
}

func TestTeamLeaseReceivesIssues(t *testing.T) {
	f := newFixture(t)
	conn, events, closeStream := f.stream()
	defer closeStream()
	status, out := f.subscribe(conn, "tok-dev", Watch{Kind: "team", ID: "team-a"}, Watch{Kind: "team", ID: "team-b"})
	if status != 200 || len(out.Leases) != 1 || len(out.Rejected) != 1 {
		t.Fatalf("status %d leases %+v rejected %+v", status, out.Leases, out.Rejected)
	}
	f.deliver("Issue", "create", map[string]any{"id": "iss-9", "teamId": "team-a"}, true)
	expect(t, events, "iss-9")
	f.deliver("Issue", "create", map[string]any{"id": "iss-8", "teamId": "team-b"}, true)
	expectNone(t, events)
}

func TestWebhookRefusals(t *testing.T) {
	f := newFixture(t)
	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1"}, false); s != 401 {
		t.Fatalf("unsigned: %d", s)
	}
	// Stale timestamp: body signed correctly but two minutes old.
	payload := map[string]any{"action": "update", "type": "Issue", "data": map[string]any{"id": "iss-1"}, "webhookTimestamp": f.now.Add(-2 * time.Minute).UnixMilli()}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/linear", bytes.NewReader(body))
	req.Header.Set("Linear-Signature", f.linear.Sign(body))
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("stale: %d", resp.StatusCode)
	}
	// Wrong secret.
	req, _ = http.NewRequest(http.MethodPost, f.public.URL+"/linear", bytes.NewReader(body))
	req.Header.Set("Linear-Signature", (&Linear{Secret: []byte("other")}).Sign(body))
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("wrong secret: %d", resp.StatusCode)
	}
}

func TestDisabledAdapter(t *testing.T) {
	f := newFixture(t)
	f.linear.Secret = nil
	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1"}, false); s != 503 {
		t.Fatalf("webhook: %d", s)
	}
	conn, _, closeStream := f.stream()
	defer closeStream()
	if s, _ := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"}); s != 503 {
		t.Fatalf("subscribe: %d", s)
	}
}

func TestSubscribeValidation(t *testing.T) {
	f := newFixture(t)
	conn, _, closeStream := f.stream()
	defer closeStream()
	if s, _ := f.subscribe("c_unknown", "tok-dev", Watch{Kind: "issue", ID: "iss-1"}); s != 404 {
		t.Fatalf("unknown connection: %d", s)
	}
	if s, _ := f.subscribe(conn, "", Watch{Kind: "issue", ID: "iss-1"}); s != 400 {
		t.Fatalf("no token: %d", s)
	}
	if s, _ := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: ""}); s != 400 {
		t.Fatalf("empty id: %d", s)
	}
	many := make([]Watch, MaxWatches+1)
	for i := range many {
		many[i] = Watch{Kind: "issue", ID: fmt.Sprint(i)}
	}
	if s, _ := f.subscribe(conn, "tok-dev", many...); s != 413 {
		t.Fatalf("too many: %d", s)
	}
	// A token the source refuses outright is a 401 for the whole call,
	// so the subscriber refreshes rather than dropping every watch.
	if s, _ := f.subscribe(conn, "tok-wrong", Watch{Kind: "issue", ID: "iss-1"}); s != 401 {
		t.Fatalf("wrong token: %d", s)
	}
	// Zero watches is a valid, empty renewal.
	if s, out := f.subscribe(conn, "tok-dev"); s != 200 || len(out.Leases) != 0 {
		t.Fatalf("no watches: %d %+v", s, out)
	}
}

func TestUnverifiableWhenSourceDown(t *testing.T) {
	f := newFixture(t)
	conn, events, closeStream := f.stream()
	defer closeStream()
	f.api.mu.Lock()
	f.api.down = true
	f.api.mu.Unlock()
	s, out := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	if s != 200 || len(out.Leases) != 0 || out.Rejected[0].Reason != "unverifiable" {
		t.Fatalf("%d %+v", s, out)
	}
	f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true)
	expectNone(t, events)
}

func TestLeaseExpiresAndRenews(t *testing.T) {
	f := newFixture(t)
	conn, events, closeStream := f.stream()
	defer closeStream()
	f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})

	f.now = f.now.Add(30 * time.Minute)
	f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true)
	expect(t, events, "iss-1")

	// Renewal moves the expiry forward from now, and the cache has
	// expired by then so the source is asked again.
	before := f.api.calls
	_, out := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	if !out.Leases[0].ExpiresAt.Equal(f.now.Add(time.Hour)) {
		t.Fatalf("renewed expiry %v", out.Leases[0].ExpiresAt)
	}
	if f.api.calls != before+1 {
		t.Fatalf("expected one verification call, got %d", f.api.calls-before)
	}

	// Let it lapse.
	f.now = f.now.Add(61 * time.Minute)
	f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true)
	expectNone(t, events)
	if n := len(f.srv.Registry.Leases(f.srv.Registry.Get(conn), "linear")); n != 0 {
		t.Fatalf("still holding %d leases", n)
	}
}

func TestVerifyCacheSavesCalls(t *testing.T) {
	f := newFixture(t)
	conn, _, closeStream := f.stream()
	defer closeStream()
	f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	before := f.api.calls
	f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	if f.api.calls != before {
		t.Fatalf("renewal within the cache window hit the source %d times", f.api.calls-before)
	}
	// A different token is a different principal: no cache hit.
	f.api.mu.Lock()
	f.api.token = "tok-other"
	f.api.mu.Unlock()
	f.subscribe(conn, "tok-other", Watch{Kind: "issue", ID: "iss-1"})
	if f.api.calls != before+1 {
		t.Fatalf("other token should have been verified")
	}
}

func TestClosingStreamDropsLeases(t *testing.T) {
	f := newFixture(t)
	conn, _, closeStream := f.stream()
	f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	closeStream()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.Registry.Get(conn) != nil {
		if time.Now().After(deadline) {
			t.Fatal("connection still registered after close")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if s, _ := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"}); s != 404 {
		t.Fatalf("subscribe on closed stream: %d", s)
	}
}

func TestTwoStreamsEachGetTheirOwn(t *testing.T) {
	f := newFixture(t)
	c1, e1, close1 := f.stream()
	defer close1()
	c2, e2, close2 := f.stream()
	defer close2()
	f.subscribe(c1, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	f.subscribe(c2, "tok-dev", Watch{Kind: "issue", ID: "iss-2"})
	f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true)
	expect(t, e1, "iss-1")
	expectNone(t, e2)
}

func TestStreamCapPerRemote(t *testing.T) {
	f := newFixture(t)
	f.srv.Registry.MaxPerRemote = 2
	_, _, c1 := f.stream()
	defer c1()
	_, _, c2 := f.stream()
	defer c2()
	resp, err := http.Get(f.sub.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("third stream: %d", resp.StatusCode)
	}
}

func TestLeaseBoundToCanonicalID(t *testing.T) {
	f := newFixture(t)
	// The fake answers any id it knows under the id asked; teach it an
	// alias the way Linear accepts an issue key.
	f.api.mu.Lock()
	f.api.issues["ENG-1"] = "team-a"
	f.api.mu.Unlock()
	conn, events, closeStream := f.stream()
	defer closeStream()
	_, out := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"})
	if out.Leases[0].ID != "iss-1" {
		t.Fatalf("lease %+v", out.Leases[0])
	}
	f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true)
	expect(t, events, "iss-1")
}

func TestRateLimitedIsUnverifiable(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"errors":[{"message":"Rate limit exceeded","extensions":{"code":"RATELIMITED"}}]}`)
	}))
	defer api.Close()
	l := &Linear{Secret: []byte("k"), API: api.URL}
	if _, _, err := l.Verify(t.Context(), "tok", Watch{Kind: "issue", ID: "iss-1"}); !errors.Is(err, ErrUnverifiable) {
		t.Fatalf("err %v", err)
	}
}

func TestCloseEndsStreams(t *testing.T) {
	f := newFixture(t)
	_, events, closeStream := f.stream()
	defer closeStream()
	f.srv.Close()
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("got an event instead of end of stream")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream still open after Close")
	}
}

func TestDuplicateWatchesCollapse(t *testing.T) {
	f := newFixture(t)
	conn, _, closeStream := f.stream()
	defer closeStream()
	_, out := f.subscribe(conn, "tok-dev", Watch{Kind: "issue", ID: "iss-1"}, Watch{Kind: "issue", ID: "iss-1"})
	if len(out.Leases) != 1 {
		t.Fatalf("leases %+v", out.Leases)
	}
}

func TestSecretFileFollowsChanges(t *testing.T) {
	f := newFixture(t)
	path := t.TempDir() + "/linear"
	f.linear.Secret = nil
	f.linear.SecretFile = path
	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1"}, false); s != 503 {
		t.Fatalf("no file: %d", s)
	}
	if err := os.WriteFile(path, []byte("s3cret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true); s != 200 {
		t.Fatalf("with file: %d", s)
	}
	if err := os.WriteFile(path, []byte("rotated"), 0o600); err != nil {
		t.Fatal(err)
	}
	// deliver signs with the adapter's current secret, so this is a valid
	// delivery under the new one; the old secret would be refused.
	if s := f.deliver("Issue", "update", map[string]any{"id": "iss-1", "teamId": "team-a"}, true); s != 200 {
		t.Fatalf("after rotation: %d", s)
	}
	body := []byte(`{"action":"update","type":"Issue","webhookTimestamp":` + fmt.Sprint(f.now.UnixMilli()) + `,"data":{"id":"iss-1"}}`)
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/linear", bytes.NewReader(body))
	req.Header.Set("Linear-Signature", (&Linear{Secret: []byte("s3cret")}).Sign(body))
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("old secret after rotation: %d", resp.StatusCode)
	}
}

func TestLinearWebhookParsing(t *testing.T) {
	l := &Linear{Secret: []byte("k"), Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}
	mk := func(body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/linear", strings.NewReader(body))
		r.Header.Set("Linear-Signature", l.Sign([]byte(body)))
		return r
	}
	ts := `"webhookTimestamp":1700000000000`
	cases := []struct {
		name string
		body string
		want []Doorbell
		err  error
	}{
		{"issue", `{"action":"update","type":"Issue",` + ts + `,"data":{"id":"i1","teamId":"t1"}}`, []Doorbell{{Source: "linear", Kind: "issue", ID: "i1", Unit: "t1", Action: "update"}}, nil},
		{"issue nested team", `{"action":"create","type":"Issue",` + ts + `,"data":{"id":"i1","team":{"id":"t2"}}}`, []Doorbell{{Source: "linear", Kind: "issue", ID: "i1", Unit: "t2", Action: "create"}}, nil},
		{"comment", `{"action":"create","type":"Comment",` + ts + `,"data":{"id":"c1","issueId":"i1","issue":{"id":"i1","teamId":"t1"}}}`, []Doorbell{{Source: "linear", Kind: "issue", ID: "i1", Unit: "t1", Action: "create"}}, nil},
		{"document comment", `{"action":"create","type":"Comment",` + ts + `,"data":{"id":"c1","documentId":"d1"}}`, nil, nil},
		{"revoked", `{"action":"revoked","type":"OAuthApp",` + ts + `,"data":{}}`, nil, nil},
		{"issue without id", `{"action":"update","type":"Issue",` + ts + `,"data":{}}`, nil, ErrBadRequest},
		{"not json", `nope`, nil, ErrBadRequest},
		{"no timestamp", `{"action":"update","type":"Issue","data":{"id":"i1"}}`, nil, ErrUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := l.Webhook(mk(c.body), []byte(c.body))
			if (err == nil) != (c.err == nil) || (err != nil && err != c.err) {
				t.Fatalf("err %v, want %v", err, c.err)
			}
			if len(got) != len(c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
			for i := range got {
				got[i].At = time.Time{}
				if got[i] != c.want[i] {
					t.Fatalf("got %+v, want %+v", got[i], c.want[i])
				}
			}
		})
	}
}

// fakeGitHub stands in for api.github.com: a token may read a fixed set of
// repositories, each spelled as GitHub spells it, with numbered issues, and
// the Dependabot alerts of some of them.
type fakeGitHub struct {
	repos       map[string][]int // canonical full name → issue numbers
	alerts      map[string][]int // canonical full name → alert numbers; absent is a 403
	deployments map[string][]int // canonical full name → deployment ids; absent is a 403
	runs        map[string][]int // canonical full name → workflow run ids; absent is a 403
	token       string
	rateLimit   bool
}

func (f *fakeGitHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
			return
		}
		if f.rateLimit {
			w.Header().Set("X-RateLimit-Remaining", "0")
			http.Error(w, `{"message":"API rate limit exceeded"}`, http.StatusForbidden)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/repos/"), "/")
		if len(parts) < 2 {
			http.NotFound(w, r)
			return
		}
		var canonical string
		for name := range f.repos {
			if strings.EqualFold(name, parts[0]+"/"+parts[1]) {
				canonical = name
			}
		}
		if canonical == "" {
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if len(parts) == 2 {
			fmt.Fprintf(w, `{"full_name":%q}`, canonical)
			return
		}
		if len(parts) >= 4 && parts[2] == "dependabot" && parts[3] == "alerts" {
			numbers, ok := f.alerts[canonical]
			if !ok {
				http.Error(w, `{"message":"Resource not accessible by personal access token"}`, http.StatusForbidden)
				return
			}
			if len(parts) == 4 {
				if r.URL.Query().Get("per_page") != "1" {
					http.Error(w, `{"message":"want per_page=1"}`, http.StatusBadRequest)
					return
				}
				if len(numbers) == 0 {
					fmt.Fprint(w, `[]`)
				} else {
					fmt.Fprintf(w, `[{"number":%d}]`, numbers[0])
				}
				return
			}
			for _, n := range numbers {
				if len(parts) == 5 && fmt.Sprint(n) == parts[4] {
					fmt.Fprintf(w, `{"number":%d,"state":"open","url":"https://api.github.com/repos/%s/dependabot/alerts/%d"}`, n, canonical, n)
					return
				}
			}
		}
		if len(parts) >= 3 && parts[2] == "deployments" {
			numbers, ok := f.deployments[canonical]
			if !ok {
				http.Error(w, `{"message":"Resource not accessible by personal access token"}`, http.StatusForbidden)
				return
			}
			if len(parts) == 4 {
				for _, n := range numbers {
					if fmt.Sprint(n) == parts[3] {
						fmt.Fprintf(w, `{"id":%d,"url":"https://api.github.com/repos/%s/deployments/%d"}`, n, canonical, n)
						return
					}
				}
				http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
				return
			}
			if r.URL.Query().Get("per_page") != "1" {
				http.Error(w, `{"message":"want per_page=1"}`, http.StatusBadRequest)
				return
			}
			if len(numbers) == 0 {
				fmt.Fprint(w, `[]`)
			} else {
				fmt.Fprintf(w, `[{"id":%d}]`, numbers[0])
			}
			return
		}
		if len(parts) >= 4 && parts[2] == "actions" && parts[3] == "runs" {
			numbers, ok := f.runs[canonical]
			if !ok {
				http.Error(w, `{"message":"Resource not accessible by personal access token"}`, http.StatusForbidden)
				return
			}
			for _, n := range numbers {
				if len(parts) == 5 && fmt.Sprint(n) == parts[4] {
					fmt.Fprintf(w, `{"id":%d,"repository":{"full_name":%q}}`, n, canonical)
					return
				}
			}
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
			return
		}
		if len(parts) == 4 && parts[2] == "issues" {
			for _, n := range f.repos[canonical] {
				if fmt.Sprint(n) == parts[3] {
					fmt.Fprintf(w, `{"number":%d,"repository_url":"https://api.github.com/repos/%s"}`, n, canonical)
					return
				}
			}
		}
		http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
	})
}

func TestGitHubWebhookParsing(t *testing.T) {
	g := &GitHub{Secret: []byte("k"), Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}
	mk := func(event, body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/github", strings.NewReader(body))
		r.Header.Set("X-GitHub-Event", event)
		r.Header.Set("X-Hub-Signature-256", g.Sign([]byte(body)))
		return r
	}
	repo := `"repository":{"full_name":"Acme/Widgets"}`
	bell := func(n int, action string) Doorbell {
		return Doorbell{Source: "github", Kind: "issue", ID: fmt.Sprintf("Acme/Widgets#%d", n), Unit: "Acme/Widgets", Action: action}
	}
	alertBell := func(n int, action string) Doorbell {
		return Doorbell{Source: "github", Kind: "dependabot_alert", ID: fmt.Sprintf("Acme/Widgets#%d", n), Unit: "Acme/Widgets", Action: action}
	}
	alert := func(action string, n int) string {
		return fmt.Sprintf(`{"action":%q,`+repo+`,"alert":{"number":%d,"state":"open","security_advisory":{"ghsa_id":"GHSA-xxxx"}}}`, action, n)
	}
	// deployment is the `deployment` object both deployment events carry.
	deployment := func(id int, environment, ref, sha string) string {
		return fmt.Sprintf(`{"id":%d,"ref":%q,"sha":%q,"environment":%q,"url":"https://api.github.com/repos/Acme/Widgets/deployments/%d"}`, id, ref, sha, environment, id)
	}
	deployBell := func(id int, action string, d Deployment) Doorbell {
		return Doorbell{Source: "github", Kind: "deployment", ID: fmt.Sprintf("Acme/Widgets#%d", id), Unit: "Acme/Widgets", Action: action, Deployment: &d}
	}
	deploy := deployment(7, "production", "main", "abc123")
	status := func(state string, extra string) string {
		return fmt.Sprintf(`{"state":%q`+extra+`}`, state)
	}
	// run is the `workflow_run` object the workflow_run event carries; prs is
	// the pull_requests array GitHub fills for a run on a pull request.
	run := func(id int, path, name, conclusion, sha string, attempt int, prs string) string {
		return fmt.Sprintf(`{"id":%d,"name":%q,"path":%q,"conclusion":%q,"html_url":"https://github.com/Acme/Widgets/actions/runs/%d","head_sha":%q,"run_attempt":%d,"pull_requests":%s}`, id, name, path, conclusion, id, sha, attempt, prs)
	}
	runBell := func(id int, action string, w WorkflowRun) Doorbell {
		return Doorbell{Source: "github", Kind: "workflow_run", ID: fmt.Sprintf("Acme/Widgets#%d", id), Unit: "Acme/Widgets", Action: action, WorkflowRun: &w}
	}
	cases := []struct {
		name  string
		event string
		body  string
		want  []Doorbell
		err   error
	}{
		{"issue", "issues", `{"action":"labeled",` + repo + `,"issue":{"number":7}}`, []Doorbell{bell(7, "issues.labeled")}, nil},
		{"issue comment", "issue_comment", `{"action":"created",` + repo + `,"issue":{"number":7},"comment":{"id":1}}`, []Doorbell{bell(7, "issue_comment.created")}, nil},
		{"pull request", "pull_request", `{"action":"synchronize",` + repo + `,"pull_request":{"number":9}}`, []Doorbell{bell(9, "pull_request.synchronize")}, nil},
		{"review", "pull_request_review", `{"action":"submitted",` + repo + `,"pull_request":{"number":9},"review":{}}`, []Doorbell{bell(9, "pull_request_review.submitted")}, nil},
		{"review comment", "pull_request_review_comment", `{"action":"created",` + repo + `,"pull_request":{"number":9}}`, []Doorbell{bell(9, "pull_request_review_comment.created")}, nil},
		{"review thread", "pull_request_review_thread", `{"action":"resolved",` + repo + `,"pull_request":{"number":9}}`, []Doorbell{bell(9, "pull_request_review_thread.resolved")}, nil},
		{"check run on two PRs", "check_run", `{"action":"completed",` + repo + `,"check_run":{"pull_requests":[{"number":9},{"number":10},{"number":9}]}}`, []Doorbell{bell(9, "check_run.completed"), bell(10, "check_run.completed")}, nil},
		{"check suite", "check_suite", `{"action":"completed",` + repo + `,"check_suite":{"pull_requests":[{"number":9}]}}`, []Doorbell{bell(9, "check_suite.completed")}, nil},
		{"workflow run issue doorbell", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":{"pull_requests":[{"number":9}]}}`, []Doorbell{bell(9, "workflow_run.completed")}, nil},
		// A completed run that did not succeed rings the workflow_run doorbell.
		// A push-to-main run has an empty pull_requests list and still rings.
		{"workflow run failure", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(42, ".github/workflows/bb-server.yaml", "bb-server", "failure", "abc123", 1, `[]`) + `}`, []Doorbell{runBell(42, "workflow_run.completed", WorkflowRun{Workflow: ".github/workflows/bb-server.yaml", Name: "bb-server", Conclusion: "failure", URL: "https://github.com/Acme/Widgets/actions/runs/42", SHA: "abc123", RunAttempt: 1})}, nil},
		{"workflow run cancelled", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(43, ".github/workflows/image.yaml", "image", "cancelled", "def456", 1, `[]`) + `}`, []Doorbell{runBell(43, "workflow_run.completed", WorkflowRun{Workflow: ".github/workflows/image.yaml", Name: "image", Conclusion: "cancelled", URL: "https://github.com/Acme/Widgets/actions/runs/43", SHA: "def456", RunAttempt: 1})}, nil},
		{"workflow run timed out", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(44, ".github/workflows/bb-server.yaml", "bb-server", "timed_out", "abc123", 2, `[]`) + `}`, []Doorbell{runBell(44, "workflow_run.completed", WorkflowRun{Workflow: ".github/workflows/bb-server.yaml", Name: "bb-server", Conclusion: "timed_out", URL: "https://github.com/Acme/Widgets/actions/runs/44", SHA: "abc123", RunAttempt: 2})}, nil},
		// A re-run is its own event with a higher attempt, so it is a
		// distinguishable doorbell even for the same run id.
		{"workflow run failure, later attempt", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(42, ".github/workflows/bb-server.yaml", "bb-server", "failure", "abc123", 3, `[]`) + `}`, []Doorbell{runBell(42, "workflow_run.completed", WorkflowRun{Workflow: ".github/workflows/bb-server.yaml", Name: "bb-server", Conclusion: "failure", URL: "https://github.com/Acme/Widgets/actions/runs/42", SHA: "abc123", RunAttempt: 3})}, nil},
		// A failed run that names pull requests rings the unchanged issue
		// doorbell and the workflow_run doorbell, in that order.
		{"workflow run failure on a pull request", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(45, ".github/workflows/ci.yaml", "ci", "failure", "abc123", 1, `[{"number":9}]`) + `}`, []Doorbell{bell(9, "workflow_run.completed"), runBell(45, "workflow_run.completed", WorkflowRun{Workflow: ".github/workflows/ci.yaml", Name: "ci", Conclusion: "failure", URL: "https://github.com/Acme/Widgets/actions/runs/45", SHA: "abc123", RunAttempt: 1})}, nil},
		// Successes and non-completed actions are dropped for the new kind;
		// the issue doorbell for a named pull request is still rung.
		{"workflow run success dropped", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(46, ".github/workflows/bb-server.yaml", "bb-server", "success", "abc123", 1, `[]`) + `}`, nil, nil},
		{"workflow run success still rings its issue doorbell", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":` + run(46, ".github/workflows/ci.yaml", "ci", "success", "abc123", 1, `[{"number":9}]`) + `}`, []Doorbell{bell(9, "workflow_run.completed")}, nil},
		{"workflow run other action dropped", "workflow_run", `{"action":"requested",` + repo + `,"workflow_run":` + run(47, ".github/workflows/bb-server.yaml", "bb-server", "", "abc123", 1, `[]`) + `}`, nil, nil},
		{"workflow run in progress dropped", "workflow_run", `{"action":"in_progress",` + repo + `,"workflow_run":` + run(48, ".github/workflows/bb-server.yaml", "bb-server", "", "abc123", 1, `[]`) + `}`, nil, nil},
		{"workflow run failure without id", "workflow_run", `{"action":"completed",` + repo + `,"workflow_run":{"conclusion":"failure","pull_requests":[]}}`, nil, ErrBadRequest},
		{"workflow run without workflow_run", "workflow_run", `{"action":"completed",` + repo + `}`, nil, ErrBadRequest},
		{"workflow run no repository", "workflow_run", `{"action":"completed","workflow_run":` + run(49, ".github/workflows/bb-server.yaml", "bb-server", "failure", "abc123", 1, `[]`) + `}`, nil, ErrBadRequest},
		{"check run from a fork", "check_run", `{"action":"completed",` + repo + `,"check_run":{"pull_requests":[]}}`, nil, nil},
		{"dependabot created", "dependabot_alert", alert("created", 4), []Doorbell{alertBell(4, "dependabot_alert.created")}, nil},
		{"dependabot fixed", "dependabot_alert", alert("fixed", 4), []Doorbell{alertBell(4, "dependabot_alert.fixed")}, nil},
		{"dependabot dismissed", "dependabot_alert", alert("dismissed", 4), []Doorbell{alertBell(4, "dependabot_alert.dismissed")}, nil},
		{"dependabot reopened", "dependabot_alert", alert("reopened", 4), []Doorbell{alertBell(4, "dependabot_alert.reopened")}, nil},
		{"dependabot reintroduced", "dependabot_alert", alert("reintroduced", 4), []Doorbell{alertBell(4, "dependabot_alert.reintroduced")}, nil},
		{"dependabot auto dismissed", "dependabot_alert", alert("auto_dismissed", 4), []Doorbell{alertBell(4, "dependabot_alert.auto_dismissed")}, nil},
		{"dependabot auto reopened", "dependabot_alert", alert("auto_reopened", 4), []Doorbell{alertBell(4, "dependabot_alert.auto_reopened")}, nil},
		{"dependabot withdrawn", "dependabot_alert", alert("withdrawn", 4), []Doorbell{alertBell(4, "dependabot_alert.withdrawn")}, nil},
		{"dependabot unknown action", "dependabot_alert", alert("assignees_changed", 4), nil, nil},
		{"dependabot no action", "dependabot_alert", `{` + repo + `,"alert":{"number":4}}`, nil, nil},
		{"dependabot without alert", "dependabot_alert", `{"action":"created",` + repo + `}`, nil, ErrBadRequest},
		{"dependabot without number", "dependabot_alert", `{"action":"created",` + repo + `,"alert":{}}`, nil, ErrBadRequest},
		{"dependabot no repository", "dependabot_alert", `{"action":"created","alert":{"number":4}}`, nil, ErrBadRequest},
		// A deployment event has no state; the doorbell carries the deployment
		// and its own URL, and the action is the event's own.
		{"deployment created", "deployment", `{"action":"created",` + repo + `,"deployment":` + deploy + `}`, []Doorbell{deployBell(7, "deployment.created", Deployment{ID: 7, Environment: "production", Ref: "main", SHA: "abc123", URL: "https://api.github.com/repos/Acme/Widgets/deployments/7"})}, nil},
		{"deployment without deployment", "deployment", `{"action":"created",` + repo + `}`, nil, ErrBadRequest},
		{"deployment without id", "deployment", `{"action":"created",` + repo + `,"deployment":{"ref":"main"}}`, nil, ErrBadRequest},
		{"deployment no repository", "deployment", `{"action":"created","deployment":` + deploy + `}`, nil, ErrBadRequest},
		// A deployment status is the interesting one: the state and the URL a
		// person can open travel with the doorbell, and a success and a failure
		// are both forwarded.
		{"deployment_status success", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `,"deployment_status":` + status("success", `,"url":"https://api.github.com/repos/Acme/Widgets/deployments/7/statuses/9","log_url":"https://github.com/Acme/Widgets/actions/runs/9"`) + `}`, []Doorbell{deployBell(7, "deployment_status.success", Deployment{ID: 7, Environment: "production", Ref: "main", SHA: "abc123", State: "success", URL: "https://github.com/Acme/Widgets/actions/runs/9"})}, nil},
		{"deployment_status failure", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `,"deployment_status":` + status("failure", `,"url":"https://api.github.com/repos/Acme/Widgets/deployments/7/statuses/10","description":"Deployment failed"`) + `}`, []Doorbell{deployBell(7, "deployment_status.failure", Deployment{ID: 7, Environment: "production", Ref: "main", SHA: "abc123", State: "failure", URL: "https://api.github.com/repos/Acme/Widgets/deployments/7/statuses/10"})}, nil},
		{"deployment_status error", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `,"deployment_status":` + status("error", `,"environment_url":"https://preview.example.com/7"`) + `}`, []Doorbell{deployBell(7, "deployment_status.error", Deployment{ID: 7, Environment: "production", Ref: "main", SHA: "abc123", State: "error", URL: "https://preview.example.com/7"})}, nil},
		{"deployment_status in progress", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `,"deployment_status":` + status("in_progress", "") + `}`, []Doorbell{deployBell(7, "deployment_status.in_progress", Deployment{ID: 7, Environment: "production", Ref: "main", SHA: "abc123", State: "in_progress", URL: "https://api.github.com/repos/Acme/Widgets/deployments/7"})}, nil},
		{"deployment_status without status", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `}`, nil, ErrBadRequest},
		{"deployment_status without state", "deployment_status", `{"action":"created",` + repo + `,"deployment":` + deploy + `,"deployment_status":{"url":"x"}}`, nil, ErrBadRequest},
		{"deployment_status without deployment", "deployment_status", `{"action":"created",` + repo + `,"deployment_status":` + status("success", "") + `}`, nil, ErrBadRequest},
		{"deployment_status no repository", "deployment_status", `{"action":"created","deployment":` + deploy + `,"deployment_status":` + status("success", "") + `}`, nil, ErrBadRequest},
		{"ping", "ping", `{"zen":"Keep it simple.","hook_id":1}`, nil, nil},
		{"push", "push", `{"ref":"refs/heads/main",` + repo + `}`, nil, nil},
		{"status", "status", `{"sha":"abc",` + repo + `}`, nil, nil},
		{"issue without number", "issues", `{"action":"opened",` + repo + `,"issue":{}}`, nil, ErrBadRequest},
		{"no repository", "issues", `{"action":"opened","issue":{"number":7}}`, nil, ErrBadRequest},
		{"not json", "issues", `nope`, nil, ErrBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := g.Webhook(mk(c.event, c.body), []byte(c.body))
			if (err == nil) != (c.err == nil) || (err != nil && err != c.err) {
				t.Fatalf("err %v, want %v", err, c.err)
			}
			if len(got) != len(c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
			for i := range got {
				got[i].At = time.Time{}
				if !sameDoorbell(got[i], c.want[i]) {
					t.Fatalf("got %+v, want %+v", got[i], c.want[i])
				}
			}
		})
	}

	t.Run("signature", func(t *testing.T) {
		for event, body := range map[string]string{"issues": `{"action":"opened",` + repo + `,"issue":{"number":7}}`, "dependabot_alert": alert("created", 4)} {
			for name, sig := range map[string]string{"missing": "", "no prefix": strings.TrimPrefix(g.Sign([]byte(body)), "sha256="), "wrong": "sha256=" + strings.Repeat("0", 64), "not hex": "sha256=zz", "other body": g.Sign([]byte(body + " "))} {
				r := httptest.NewRequest(http.MethodPost, "/github", strings.NewReader(body))
				r.Header.Set("X-GitHub-Event", event)
				if sig != "" {
					r.Header.Set("X-Hub-Signature-256", sig)
				}
				if _, err := g.Webhook(r, []byte(body)); err != ErrUnauthorized {
					t.Fatalf("%s %s: err %v, want unauthorized", event, name, err)
				}
			}
		}
	})
}

// TestGitHubWorkflowRunDoorbellFields pins the shape of the workflow_run
// doorbell: it carries the workflow's path and name, the conclusion, the run
// URL, the head sha and the attempt, and nothing else from the event (no
// logs, commit message, actor, branch or other run text).
func TestGitHubWorkflowRunDoorbellFields(t *testing.T) {
	g := &GitHub{Secret: []byte("k"), Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}
	body := `{"action":"completed","repository":{"full_name":"Acme/Widgets"},` +
		`"workflow_run":{` +
		`"id":42,"name":"bb-server","path":".github/workflows/bb-server.yaml","conclusion":"failure",` +
		`"html_url":"https://github.com/Acme/Widgets/actions/runs/42","head_sha":"abc123","run_attempt":2,` +
		`"logs_url":"https://api.github.com/repos/Acme/Widgets/actions/runs/42/logs",` +
		`"display_title":"ci: build","head_branch":"main","event":"push",` +
		`"head_commit":{"message":"do not carry me","author":{"name":"someone"}},` +
		`"actor":{"login":"someone"},"triggering_actor":{"login":"someone"},"pull_requests":[]}}`
	r := httptest.NewRequest(http.MethodPost, "/github", strings.NewReader(body))
	r.Header.Set("X-GitHub-Event", "workflow_run")
	r.Header.Set("X-Hub-Signature-256", g.Sign([]byte(body)))
	got, err := g.Webhook(r, []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != "workflow_run" || got[0].WorkflowRun == nil {
		t.Fatalf("got %+v", got)
	}
	raw, err := json.Marshal(got[0])
	if err != nil {
		t.Fatal(err)
	}
	var shape struct {
		Kind        string         `json:"kind"`
		ID          string         `json:"id"`
		Unit        string         `json:"unit"`
		WorkflowRun map[string]any `json:"workflow_run"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatal(err)
	}
	if shape.Kind != "workflow_run" || shape.ID != "Acme/Widgets#42" || shape.Unit != "Acme/Widgets" {
		t.Fatalf("doorbell %s %s %s", shape.Kind, shape.ID, shape.Unit)
	}
	want := map[string]any{
		"workflow":    ".github/workflows/bb-server.yaml",
		"name":        "bb-server",
		"conclusion":  "failure",
		"url":         "https://github.com/Acme/Widgets/actions/runs/42",
		"sha":         "abc123",
		"run_attempt": float64(2),
	}
	if !reflect.DeepEqual(shape.WorkflowRun, want) {
		t.Fatalf("workflow_run fields %v, want %v", shape.WorkflowRun, want)
	}
}

func TestGitHubVerify(t *testing.T) {
	api := &fakeGitHub{
		repos:       map[string][]int{"Acme/Widgets": {7, 9}, "Acme/Gears": nil, "Acme/Quiet": nil},
		alerts:      map[string][]int{"Acme/Widgets": {4, 5}, "Acme/Quiet": {}},
		deployments: map[string][]int{"Acme/Widgets": {7, 8}, "Acme/Quiet": {}},
		runs:        map[string][]int{"Acme/Widgets": {42, 43}, "Acme/Quiet": {}},
		token:       "gho_dev",
	}
	srv := httptest.NewServer(api.handler())
	t.Cleanup(srv.Close)
	g := &GitHub{Secret: []byte("k"), API: srv.URL}
	ctx := context.Background()

	cases := []struct {
		name  string
		token string
		w     Watch
		want  Watch
		unit  string
		err   error
	}{
		{"issue, canonical casing", "gho_dev", Watch{Kind: "issue", ID: "acme/widgets#7"}, Watch{Kind: "issue", ID: "Acme/Widgets#7"}, "Acme/Widgets", nil},
		{"pull request through the issues endpoint", "gho_dev", Watch{Kind: "issue", ID: "Acme/Widgets#9"}, Watch{Kind: "issue", ID: "Acme/Widgets#9"}, "Acme/Widgets", nil},
		{"repo", "gho_dev", Watch{Kind: "repo", ID: "ACME/widgets"}, Watch{Kind: "repo", ID: "Acme/Widgets"}, "Acme/Widgets", nil},
		{"missing issue", "gho_dev", Watch{Kind: "issue", ID: "Acme/Widgets#8"}, Watch{}, "", ErrForbidden},
		{"private or missing repo", "gho_dev", Watch{Kind: "issue", ID: "Acme/Secret#1"}, Watch{}, "", ErrForbidden},
		{"malformed id", "gho_dev", Watch{Kind: "issue", ID: "Acme/Widgets"}, Watch{}, "", ErrForbidden},
		{"malformed repo", "gho_dev", Watch{Kind: "repo", ID: "Acme"}, Watch{}, "", ErrForbidden},
		{"unknown kind", "gho_dev", Watch{Kind: "commit", ID: "abc"}, Watch{}, "", ErrForbidden},
		{"alert, canonical casing", "gho_dev", Watch{Kind: "dependabot_alert", ID: "acme/widgets#4"}, Watch{Kind: "dependabot_alert", ID: "Acme/Widgets#4"}, "Acme/Widgets", nil},
		{"missing alert", "gho_dev", Watch{Kind: "dependabot_alert", ID: "Acme/Widgets#6"}, Watch{}, "", ErrForbidden},
		{"alert, no alert access", "gho_dev", Watch{Kind: "dependabot_alert", ID: "Acme/Gears#1"}, Watch{}, "", ErrForbidden},
		{"alert, private or missing repo", "gho_dev", Watch{Kind: "dependabot_alert", ID: "Acme/Secret#1"}, Watch{}, "", ErrForbidden},
		{"alert, malformed id", "gho_dev", Watch{Kind: "dependabot_alert", ID: "Acme/Widgets"}, Watch{}, "", ErrForbidden},
		{"alert, bad token", "nope", Watch{Kind: "dependabot_alert", ID: "Acme/Widgets#4"}, Watch{}, "", ErrBadToken},
		{"dependabot repo, canonical casing", "gho_dev", Watch{Kind: "dependabot_repo", ID: "ACME/widgets"}, Watch{Kind: "dependabot_repo", ID: "Acme/Widgets"}, "Acme/Widgets", nil},
		{"dependabot repo with no alerts", "gho_dev", Watch{Kind: "dependabot_repo", ID: "acme/quiet"}, Watch{Kind: "dependabot_repo", ID: "Acme/Quiet"}, "Acme/Quiet", nil},
		{"dependabot repo, no alert access", "gho_dev", Watch{Kind: "dependabot_repo", ID: "Acme/Gears"}, Watch{}, "", ErrForbidden},
		{"dependabot repo, private or missing", "gho_dev", Watch{Kind: "dependabot_repo", ID: "Acme/Secret"}, Watch{}, "", ErrForbidden},
		{"dependabot repo, malformed", "gho_dev", Watch{Kind: "dependabot_repo", ID: "Acme/Widgets#4"}, Watch{}, "", ErrForbidden},
		{"deployment repo, canonical casing", "gho_dev", Watch{Kind: "deployment_repo", ID: "ACME/widgets"}, Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, "Acme/Widgets", nil},
		{"deployment repo with no deployments", "gho_dev", Watch{Kind: "deployment_repo", ID: "acme/quiet"}, Watch{Kind: "deployment_repo", ID: "Acme/Quiet"}, "Acme/Quiet", nil},
		{"deployment repo, no deployment access", "gho_dev", Watch{Kind: "deployment_repo", ID: "Acme/Gears"}, Watch{}, "", ErrForbidden},
		{"deployment repo, private or missing", "gho_dev", Watch{Kind: "deployment_repo", ID: "Acme/Secret"}, Watch{}, "", ErrForbidden},
		{"deployment repo, malformed", "gho_dev", Watch{Kind: "deployment_repo", ID: "Acme/Widgets#7"}, Watch{}, "", ErrForbidden},
		{"deployment, canonical casing", "gho_dev", Watch{Kind: "deployment", ID: "acme/widgets#7"}, Watch{Kind: "deployment", ID: "Acme/Widgets#7"}, "Acme/Widgets", nil},
		{"missing deployment", "gho_dev", Watch{Kind: "deployment", ID: "Acme/Widgets#9"}, Watch{}, "", ErrForbidden},
		{"deployment, no deployment access", "gho_dev", Watch{Kind: "deployment", ID: "Acme/Gears#1"}, Watch{}, "", ErrForbidden},
		{"deployment, private or missing", "gho_dev", Watch{Kind: "deployment", ID: "Acme/Secret#1"}, Watch{}, "", ErrForbidden},
		{"deployment, malformed", "gho_dev", Watch{Kind: "deployment", ID: "Acme/Widgets"}, Watch{}, "", ErrForbidden},
		{"workflow run, canonical casing", "gho_dev", Watch{Kind: "workflow_run", ID: "acme/widgets#42"}, Watch{Kind: "workflow_run", ID: "Acme/Widgets#42"}, "Acme/Widgets", nil},
		{"missing workflow run", "gho_dev", Watch{Kind: "workflow_run", ID: "Acme/Widgets#44"}, Watch{}, "", ErrForbidden},
		{"workflow run, no run access", "gho_dev", Watch{Kind: "workflow_run", ID: "Acme/Gears#1"}, Watch{}, "", ErrForbidden},
		{"workflow run, private or missing", "gho_dev", Watch{Kind: "workflow_run", ID: "Acme/Secret#1"}, Watch{}, "", ErrForbidden},
		{"workflow run, malformed", "gho_dev", Watch{Kind: "workflow_run", ID: "Acme/Widgets"}, Watch{}, "", ErrForbidden},
		{"bad token", "nope", Watch{Kind: "issue", ID: "Acme/Widgets#7"}, Watch{}, "", ErrBadToken},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, unit, err := g.Verify(ctx, c.token, c.w)
			if err != c.err {
				t.Fatalf("err %v, want %v", err, c.err)
			}
			if got != c.want || unit != c.unit {
				t.Fatalf("got %+v %q, want %+v %q", got, unit, c.want, c.unit)
			}
		})
	}

	t.Run("rate limited is unverifiable", func(t *testing.T) {
		api.rateLimit = true
		defer func() { api.rateLimit = false }()
		for _, w := range []Watch{{Kind: "issue", ID: "Acme/Widgets#7"}, {Kind: "dependabot_alert", ID: "Acme/Widgets#4"}, {Kind: "dependabot_repo", ID: "Acme/Widgets"}, {Kind: "deployment_repo", ID: "Acme/Widgets"}, {Kind: "deployment", ID: "Acme/Widgets#7"}, {Kind: "workflow_run", ID: "Acme/Widgets#42"}} {
			if _, _, err := g.Verify(ctx, "gho_dev", w); !errors.Is(err, ErrUnverifiable) {
				t.Fatalf("%v: err %v, want unverifiable", w, err)
			}
		}
	})
}

func TestGitHubEndToEnd(t *testing.T) {
	api := &fakeGitHub{repos: map[string][]int{"Acme/Widgets": {7, 9}}, token: "gho_dev"}
	apiSrv := httptest.NewServer(api.handler())
	t.Cleanup(apiSrv.Close)
	g := &GitHub{Secret: []byte("s3cret"), API: apiSrv.URL}
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{g}}
	public := httptest.NewServer(srv.Public())
	t.Cleanup(public.Close)
	sub := httptest.NewServer(srv.Subscriber())
	t.Cleanup(sub.Close)
	f := &fixture{t: t, srv: srv, public: public, sub: sub}
	conn, events, closeStream := f.stream()
	defer closeStream()

	body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "github", Token: "gho_dev", Watches: []Watch{{Kind: "issue", ID: "acme/widgets#9"}, {Kind: "issue", ID: "acme/widgets#8"}}})
	resp, err := http.Post(sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var out SubscribeResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if len(out.Leases) != 1 || out.Leases[0].ID != "Acme/Widgets#9" || out.Leases[0].Unit != "Acme/Widgets" {
		t.Fatalf("leases %+v", out.Leases)
	}
	if len(out.Rejected) != 1 || out.Rejected[0].Reason != "forbidden" {
		t.Fatalf("rejected %+v", out.Rejected)
	}

	deliver := func(event, payload string, sign bool) int {
		req, _ := http.NewRequest(http.MethodPost, public.URL+"/github", strings.NewReader(payload))
		req.Header.Set("X-GitHub-Event", event)
		if sign {
			req.Header.Set("X-Hub-Signature-256", g.Sign([]byte(payload)))
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		return r.StatusCode
	}
	repo := `"repository":{"full_name":"Acme/Widgets"}`
	if s := deliver("pull_request_review", `{"action":"submitted",`+repo+`,"pull_request":{"number":9}}`, false); s != 401 {
		t.Fatalf("unsigned: %d", s)
	}
	if s := deliver("ping", `{"zen":"ok"}`, true); s != 200 {
		t.Fatalf("ping: %d", s)
	}
	if s := deliver("pull_request_review", `{"action":"submitted",`+repo+`,"pull_request":{"number":9}}`, true); s != 200 {
		t.Fatalf("review: %d", s)
	}
	select {
	case d := <-events:
		if d.Source != "github" || d.Kind != "issue" || d.ID != "Acme/Widgets#9" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no doorbell")
	}
	// The other pull request is not leased.
	if s := deliver("issue_comment", `{"action":"created",`+repo+`,"issue":{"number":7}}`, true); s != 200 {
		t.Fatalf("comment: %d", s)
	}
	expectNone(t, events)
}

func TestGitHubUnitLeases(t *testing.T) {
	g := &GitHub{}
	issue := Doorbell{Source: "github", Kind: "issue", ID: "Acme/Widgets#4", Unit: "Acme/Widgets"}
	alert := Doorbell{Source: "github", Kind: "dependabot_alert", ID: "Acme/Widgets#4", Unit: "Acme/Widgets"}
	deploy := Doorbell{Source: "github", Kind: "deployment", ID: "Acme/Widgets#7", Unit: "Acme/Widgets"}
	run := Doorbell{Source: "github", Kind: "workflow_run", ID: "Acme/Widgets#42", Unit: "Acme/Widgets"}
	cases := []struct {
		lease Watch
		d     Doorbell
		want  bool
	}{
		{Watch{Kind: "repo", ID: "Acme/Widgets"}, issue, true},
		// Reading a repository does not entitle a token to its alerts.
		{Watch{Kind: "repo", ID: "Acme/Widgets"}, alert, false},
		{Watch{Kind: "dependabot_repo", ID: "Acme/Widgets"}, alert, true},
		{Watch{Kind: "dependabot_repo", ID: "Acme/Widgets"}, issue, false},
		{Watch{Kind: "dependabot_repo", ID: "Acme/Gears"}, alert, false},
		// Issue #4 and alert #4 are different entities.
		{Watch{Kind: "issue", ID: "Acme/Widgets#4"}, alert, false},
		{Watch{Kind: "dependabot_alert", ID: "Acme/Widgets#4"}, issue, false},
		{Watch{Kind: "dependabot_alert", ID: "Acme/Widgets#4"}, alert, true},
		// Reading a repository does not entitle a token to its deployments
		// either; only a deployment_repo lease receives them.
		{Watch{Kind: "repo", ID: "Acme/Widgets"}, deploy, false},
		{Watch{Kind: "dependabot_repo", ID: "Acme/Widgets"}, deploy, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, deploy, true},
		{Watch{Kind: "deployment_repo", ID: "Acme/Gears"}, deploy, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, issue, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, alert, false},
		{Watch{Kind: "deployment", ID: "Acme/Widgets#7"}, deploy, true},
		{Watch{Kind: "deployment", ID: "Acme/Widgets#8"}, deploy, false},
		// A failing workflow run reaches the same subscribers a deployment
		// does (the repo a playbook names as a deployment target), and no
		// others.
		{Watch{Kind: "repo", ID: "Acme/Widgets"}, run, false},
		{Watch{Kind: "dependabot_repo", ID: "Acme/Widgets"}, run, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, run, true},
		{Watch{Kind: "deployment_repo", ID: "Acme/Gears"}, run, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, issue, false},
		{Watch{Kind: "deployment_repo", ID: "Acme/Widgets"}, alert, false},
		{Watch{Kind: "workflow_run", ID: "Acme/Widgets#42"}, run, true},
		{Watch{Kind: "workflow_run", ID: "Acme/Widgets#43"}, run, false},
		{Watch{Kind: "deployment", ID: "Acme/Widgets#7"}, run, false},
	}
	for _, c := range cases {
		if got := Matches(g, c.lease, c.d); got != c.want {
			t.Errorf("lease %+v, doorbell %s %s: got %v, want %v", c.lease, c.d.Kind, c.d.ID, got, c.want)
		}
	}
}

func TestGitHubDependabotEndToEnd(t *testing.T) {
	api := &fakeGitHub{
		repos:  map[string][]int{"Acme/Widgets": {7}, "Acme/Gears": nil},
		alerts: map[string][]int{"Acme/Widgets": {4}},
		token:  "gho_dev",
	}
	apiSrv := httptest.NewServer(api.handler())
	t.Cleanup(apiSrv.Close)
	g := &GitHub{Secret: []byte("s3cret"), API: apiSrv.URL}
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{g}}
	public := httptest.NewServer(srv.Public())
	t.Cleanup(public.Close)
	sub := httptest.NewServer(srv.Subscriber())
	t.Cleanup(sub.Close)
	f := &fixture{t: t, srv: srv, public: public, sub: sub}

	subscribe := func(conn string, watches ...Watch) SubscribeResponse {
		body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "github", Token: "gho_dev", Watches: watches})
		resp, err := http.Post(sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out SubscribeResponse
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	deliver := func(event, payload string) {
		req, _ := http.NewRequest(http.MethodPost, public.URL+"/github", strings.NewReader(payload))
		req.Header.Set("X-GitHub-Event", event)
		req.Header.Set("X-Hub-Signature-256", g.Sign([]byte(payload)))
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatalf("%s: %d", event, r.StatusCode)
		}
	}
	repo := `"repository":{"full_name":"Acme/Widgets"}`
	created := `{"action":"created",` + repo + `,"alert":{"number":4}}`

	// The alerts stream: the repository's alerts, admitted by reading them.
	// A dependabot_repo lease on a repository whose alerts the token cannot
	// read is refused.
	alertsConn, alerts, closeAlerts := f.stream()
	defer closeAlerts()
	out := subscribe(alertsConn, Watch{Kind: "dependabot_repo", ID: "acme/widgets"}, Watch{Kind: "dependabot_repo", ID: "Acme/Gears"})
	if len(out.Leases) != 1 || out.Leases[0].Kind != "dependabot_repo" || out.Leases[0].ID != "Acme/Widgets" || out.Leases[0].Unit != "Acme/Widgets" {
		t.Fatalf("leases %+v", out.Leases)
	}
	if len(out.Rejected) != 1 || out.Rejected[0].ID != "Acme/Gears" || out.Rejected[0].Reason != "forbidden" {
		t.Fatalf("rejected %+v", out.Rejected)
	}
	// The issues stream: a repo lease, which must not hear about alerts.
	issuesConn, issues, closeIssues := f.stream()
	defer closeIssues()
	if out := subscribe(issuesConn, Watch{Kind: "repo", ID: "Acme/Widgets"}); len(out.Leases) != 1 {
		t.Fatalf("repo leases %+v", out)
	}

	deliver("dependabot_alert", created)
	select {
	case d := <-alerts:
		if d.Source != "github" || d.Kind != "dependabot_alert" || d.ID != "Acme/Widgets#4" || d.Unit != "Acme/Widgets" || d.Action != "dependabot_alert.created" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no doorbell")
	}
	expectNone(t, issues)

	// An unknown action rings nobody; an issue rings only the repo lease.
	deliver("dependabot_alert", `{"action":"assignees_changed",`+repo+`,"alert":{"number":4}}`)
	expectNone(t, alerts)
	deliver("issues", `{"action":"labeled",`+repo+`,"issue":{"number":7}}`)
	select {
	case d := <-issues:
		if d.Kind != "issue" || d.ID != "Acme/Widgets#7" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no issue doorbell")
	}
	expectNone(t, alerts)
}

func TestGitHubDeploymentEndToEnd(t *testing.T) {
	api := &fakeGitHub{
		repos:       map[string][]int{"Acme/Widgets": {7}, "Acme/Gears": nil},
		deployments: map[string][]int{"Acme/Widgets": {7, 8}, "Acme/Gears": {1}},
		token:       "gho_dev",
	}
	apiSrv := httptest.NewServer(api.handler())
	t.Cleanup(apiSrv.Close)
	g := &GitHub{Secret: []byte("s3cret"), API: apiSrv.URL}
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{g}}
	public := httptest.NewServer(srv.Public())
	t.Cleanup(public.Close)
	sub := httptest.NewServer(srv.Subscriber())
	t.Cleanup(sub.Close)
	f := &fixture{t: t, srv: srv, public: public, sub: sub}

	subscribe := func(conn string, watches ...Watch) SubscribeResponse {
		body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "github", Token: "gho_dev", Watches: watches})
		resp, err := http.Post(sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out SubscribeResponse
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	deliver := func(event, payload string) {
		req, _ := http.NewRequest(http.MethodPost, public.URL+"/github", strings.NewReader(payload))
		req.Header.Set("X-GitHub-Event", event)
		req.Header.Set("X-Hub-Signature-256", g.Sign([]byte(payload)))
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatalf("%s: %d", event, r.StatusCode)
		}
	}
	repo := `"repository":{"full_name":"Acme/Widgets"}`
	otherRepo := `"repository":{"full_name":"Acme/Gears"}`
	deploy := func(id int) string {
		return fmt.Sprintf(`{"id":%d,"ref":"main","sha":"abc123","environment":"production","url":"https://api.github.com/repos/Acme/Widgets/deployments/%d"}`, id, id)
	}
	status := func(state string) string {
		return fmt.Sprintf(`{"state":%q,"url":"https://api.github.com/repos/Acme/Widgets/deployments/7/statuses/1"}`, state)
	}

	// A deployment_repo lease is admitted by reading the repository's
	// deployments; a repository the token cannot read is refused.
	deploymentsConn, deployments, closeDeployments := f.stream()
	defer closeDeployments()
	out := subscribe(deploymentsConn, Watch{Kind: "deployment_repo", ID: "acme/widgets"}, Watch{Kind: "deployment_repo", ID: "Acme/Secret"})
	if len(out.Leases) != 1 || out.Leases[0].Kind != "deployment_repo" || out.Leases[0].ID != "Acme/Widgets" || out.Leases[0].Unit != "Acme/Widgets" {
		t.Fatalf("leases %+v", out.Leases)
	}
	if len(out.Rejected) != 1 || out.Rejected[0].ID != "Acme/Secret" || out.Rejected[0].Reason != "forbidden" {
		t.Fatalf("rejected %+v", out.Rejected)
	}
	// A repo lease must not hear about deployments.
	issuesConn, issues, closeIssues := f.stream()
	defer closeIssues()
	if out := subscribe(issuesConn, Watch{Kind: "repo", ID: "Acme/Widgets"}); len(out.Leases) != 1 {
		t.Fatalf("repo leases %+v", out)
	}

	// A successful status is routed to the lessee of that repository.
	deliver("deployment_status", `{"action":"created",`+repo+`,"deployment":`+deploy(7)+`,"deployment_status":`+status("success")+`}`)
	select {
	case d := <-deployments:
		if d.Kind != "deployment" || d.ID != "Acme/Widgets#7" || d.Unit != "Acme/Widgets" || d.Action != "deployment_status.success" {
			t.Fatalf("got %+v", d)
		}
		if d.Deployment == nil || d.Deployment.State != "success" || d.Deployment.Environment != "production" || d.Deployment.Ref != "main" || d.Deployment.SHA != "abc123" || d.Deployment.ID != 7 {
			t.Fatalf("deployment %+v", d.Deployment)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no deployment doorbell")
	}
	expectNone(t, issues)

	// A failure is forwarded too.
	deliver("deployment_status", `{"action":"created",`+repo+`,"deployment":`+deploy(7)+`,"deployment_status":`+status("failure")+`}`)
	select {
	case d := <-deployments:
		if d.Action != "deployment_status.failure" || d.Deployment == nil || d.Deployment.State != "failure" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no failure doorbell")
	}

	// A deployment in another repository rings only its own lessee.
	deliver("deployment_status", `{"action":"created",`+otherRepo+`,"deployment":{"id":1,"ref":"main","sha":"def","environment":"production","url":"https://api.github.com/repos/Acme/Gears/deployments/1"},"deployment_status":`+status("success")+`}`)
	expectNone(t, deployments)

	// An event the adapter does not map still rings nobody.
	deliver("page_build", `{"id":1,`+repo+`}`)
	expectNone(t, deployments)
}

func TestGitHubWorkflowRunEndToEnd(t *testing.T) {
	api := &fakeGitHub{
		repos:       map[string][]int{"Acme/Widgets": {7}, "Acme/Gears": nil},
		deployments: map[string][]int{"Acme/Widgets": {7}, "Acme/Gears": {1}},
		runs:        map[string][]int{"Acme/Widgets": {42}, "Acme/Gears": {1}},
		token:       "gho_dev",
	}
	apiSrv := httptest.NewServer(api.handler())
	t.Cleanup(apiSrv.Close)
	g := &GitHub{Secret: []byte("s3cret"), API: apiSrv.URL}
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{g}}
	public := httptest.NewServer(srv.Public())
	t.Cleanup(public.Close)
	sub := httptest.NewServer(srv.Subscriber())
	t.Cleanup(sub.Close)
	f := &fixture{t: t, srv: srv, public: public, sub: sub}

	subscribe := func(conn string, watches ...Watch) SubscribeResponse {
		body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "github", Token: "gho_dev", Watches: watches})
		resp, err := http.Post(sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out SubscribeResponse
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	deliver := func(event, payload string) {
		req, _ := http.NewRequest(http.MethodPost, public.URL+"/github", strings.NewReader(payload))
		req.Header.Set("X-GitHub-Event", event)
		req.Header.Set("X-Hub-Signature-256", g.Sign([]byte(payload)))
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatalf("%s: %d", event, r.StatusCode)
		}
	}
	repo := `"repository":{"full_name":"Acme/Widgets"}`
	run := func(id int, conclusion string, prs string) string {
		return fmt.Sprintf(`{"id":%d,"name":"bb-server","path":".github/workflows/bb-server.yaml","conclusion":%q,"html_url":"https://github.com/Acme/Widgets/actions/runs/%d","head_sha":"abc123","run_attempt":1,"pull_requests":%s}`, id, conclusion, id, prs)
	}

	// The deployment_repo lease is admitted through the repository's
	// deployments, the same read a deployment watch makes; the repo lease is
	// admitted through its issues.
	deploymentsConn, deployments, closeDeployments := f.stream()
	defer closeDeployments()
	if out := subscribe(deploymentsConn, Watch{Kind: "deployment_repo", ID: "acme/widgets"}); len(out.Leases) != 1 {
		t.Fatalf("leases %+v", out)
	}
	issuesConn, issues, closeIssues := f.stream()
	defer closeIssues()
	if out := subscribe(issuesConn, Watch{Kind: "repo", ID: "Acme/Widgets"}); len(out.Leases) != 1 {
		t.Fatalf("repo leases %+v", out)
	}

	// A failed push-to-main run has an empty pull_requests list and still
	// rings the workflow_run doorbell for the deployment_repo lessee.
	deliver("workflow_run", `{"action":"completed",`+repo+`,"workflow_run":`+run(42, "failure", `[]`)+`}`)
	select {
	case d := <-deployments:
		if d.Kind != "workflow_run" || d.ID != "Acme/Widgets#42" || d.Unit != "Acme/Widgets" || d.Action != "workflow_run.completed" {
			t.Fatalf("got %+v", d)
		}
		if d.WorkflowRun == nil || d.WorkflowRun.Workflow != ".github/workflows/bb-server.yaml" || d.WorkflowRun.Name != "bb-server" || d.WorkflowRun.Conclusion != "failure" || d.WorkflowRun.URL != "https://github.com/Acme/Widgets/actions/runs/42" || d.WorkflowRun.SHA != "abc123" || d.WorkflowRun.RunAttempt != 1 {
			t.Fatalf("workflow run %+v", d.WorkflowRun)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no workflow_run doorbell")
	}
	expectNone(t, issues)

	// A success and an in-progress run ring nobody.
	deliver("workflow_run", `{"action":"completed",`+repo+`,"workflow_run":`+run(42, "success", `[]`)+`}`)
	expectNone(t, deployments)
	deliver("workflow_run", `{"action":"in_progress",`+repo+`,"workflow_run":`+run(42, "", `[]`)+`}`)
	expectNone(t, deployments)

	// A failed run that names a pull request rings the unchanged issue
	// doorbell for the repo lease as well as the workflow_run doorbell.
	deliver("workflow_run", `{"action":"completed",`+repo+`,"workflow_run":`+run(43, "failure", `[{"number":7}]`)+`}`)
	select {
	case d := <-deployments:
		if d.Kind != "workflow_run" || d.ID != "Acme/Widgets#43" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no workflow_run doorbell for the PR run")
	}
	select {
	case d := <-issues:
		if d.Kind != "issue" || d.ID != "Acme/Widgets#7" || d.Action != "workflow_run.completed" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no issue doorbell for the PR run")
	}
}

// fakeSentry stands in for sentry.io: a token may read a fixed set of issues
// and projects and records the tokens it saw.
type fakeSentry struct {
	mu        sync.Mutex
	issues    map[string]string // issue id → project slug
	projects  map[string]bool   // "org/slug" → exists
	token     string
	calls     int
	rateLimit bool
	down      bool
}

func (f *fakeSentry) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		if f.down {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if f.rateLimit {
			http.Error(w, `{"detail":"Request was throttled."}`, http.StatusTooManyRequests)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			http.Error(w, `{"detail":"Invalid token"}`, http.StatusUnauthorized)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/0")
		switch {
		case strings.HasPrefix(path, "/issues/"):
			id := strings.TrimSuffix(strings.TrimPrefix(path, "/issues/"), "/")
			if slug, ok := f.issues[id]; ok {
				fmt.Fprintf(w, `{"id":%q,"project":{"slug":%q}}`, id, slug)
			} else {
				http.Error(w, `{"detail":"The requested resource does not exist"}`, http.StatusNotFound)
			}
		case strings.HasPrefix(path, "/projects/"):
			parts := strings.Split(strings.Trim(path, "/"), "/")
			if len(parts) == 3 {
				key := parts[1] + "/" + parts[2]
				if f.projects[key] {
					fmt.Fprintf(w, `{"slug":%q}`, parts[2])
					return
				}
				http.Error(w, `{"detail":"The requested resource does not exist"}`, http.StatusNotFound)
				return
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

// sentryIssuePayload is a recorded issue webhook, trimmed to the fields the
// adapter reads.
const sentryIssuePayload = `{
  "action": "created",
  "installation": {"uuid": "24b397fc-a86e-43ef-9297-949e21b82480"},
  "data": {
    "issue": {
      "url": "https://sentry.io/api/0/organizations/acme/issues/1234567890/",
      "web_url": "https://acme.sentry.io/issues/1234567890/",
      "project_url": "https://acme.sentry.io/issues/?project=4509877862268928",
      "id": "1234567890",
      "shortId": "PYTHON-Y",
      "title": "TypeError: heck is not defined",
      "culprit": "app/views.py in handler",
      "permalink": "https://acme.sentry.io/issues/1234567890/",
      "level": "error",
      "status": "unresolved",
      "substatus": "new",
      "project": {"id": "4509877862268928", "name": "backend", "slug": "backend", "platform": "python"},
      "issueType": "error",
      "issueCategory": "error",
      "count": "3",
      "userCount": 3,
      "firstSeen": "2025-11-10T20:56:00.679000+00:00",
      "lastSeen": "2025-11-10T20:56:00.738000+00:00"
    }
  },
  "actor": {"type": "application", "id": "sentry", "name": "Sentry"}
}`

// sentryIssueAlertPayload is a recorded issue-alert webhook ("Issue Alerts",
// the event_alert resource), trimmed to the fields the adapter reads.
const sentryIssueAlertPayload = `{
  "action": "triggered",
  "actor": {"id": "sentry", "name": "Sentry", "type": "application"},
  "data": {
    "event": {
      "event_id": "e4874d664c3540c1a32eab185f12c5ab",
      "issue_id": "1117540176",
      "issue_url": "https://sentry.io/api/0/organizations/acme/issues/1117540176/",
      "url": "https://sentry.io/api/0/projects/acme/backend/events/e4874d664c3540c1a32eab185f12c5ab/",
      "web_url": "https://acme.sentry.io/issues/1117540176/events/e4874d664c3540c1a32eab185f12c5ab/",
      "title": "ReferenceError: heck is not defined",
      "culprit": "?(<anonymous>)",
      "project": 4509877862268928
    },
    "triggered_rule": "Very Important Alert!",
    "issue_alert": {"title": "Very Important Alert!", "settings": []}
  },
  "installation": {"uuid": "a8e5d37a-696c-4c54-adb5-b3f28d64c7de"}
}`

func TestSentryWebhookParsing(t *testing.T) {
	s := &Sentry{Secret: []byte("k"), Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }}
	mk := func(resource, body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/sentry", strings.NewReader(body))
		r.Header.Set("sentry-hook-resource", resource)
		r.Header.Set("sentry-hook-signature", s.Sign([]byte(body)))
		return r
	}
	cases := []struct {
		name     string
		resource string
		body     string
		want     []Doorbell
		err      error
	}{
		{"issue", "issue", sentryIssuePayload, []Doorbell{{Source: "sentry", Kind: "issue", ID: "1234567890", Unit: "backend", Action: "created"}}, nil},
		{"issue alert", "event_alert", sentryIssueAlertPayload, []Doorbell{{Source: "sentry", Kind: "issue", ID: "1117540176", Unit: "backend", Action: "triggered"}}, nil},
		{"metric alert", "metric_alert", `{"action":"critical","data":{"metric_alert":{"id":"1"}}}`, nil, nil},
		{"installation", "installation", `{"action":"created","data":{"installation":{"uuid":"u"}}}`, nil, nil},
		{"comment", "comment", `{"action":"created","data":{"comment":{"id":"c1"}}}`, nil, nil},
		{"issue without id", "issue", `{"action":"created","data":{"issue":{"project":{"slug":"backend"}}}}`, nil, ErrBadRequest},
		{"issue without project", "issue", `{"action":"created","data":{"issue":{"id":"1"}}}`, []Doorbell{{Source: "sentry", Kind: "issue", ID: "1", Action: "created"}}, nil},
		{"issue alert without issue id", "event_alert", `{"action":"triggered","data":{"event":{"url":"https://sentry.io/api/0/projects/acme/backend/events/e/"}}}`, nil, ErrBadRequest},
		{"issue alert without a project url", "event_alert", `{"action":"triggered","data":{"event":{"issue_id":"7","url":"https://acme.sentry.io/issues/7/events/e/"}}}`, []Doorbell{{Source: "sentry", Kind: "issue", ID: "7", Action: "triggered"}}, nil},
		{"not json", "issue", `nope`, nil, ErrBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := s.Webhook(mk(c.resource, c.body), []byte(c.body))
			if (err == nil) != (c.err == nil) || (err != nil && err != c.err) {
				t.Fatalf("err %v, want %v", err, c.err)
			}
			if len(got) != len(c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
			for i := range got {
				got[i].At = time.Time{}
				if got[i] != c.want[i] {
					t.Fatalf("got %+v, want %+v", got[i], c.want[i])
				}
			}
		})
	}

	t.Run("signature", func(t *testing.T) {
		for name, sig := range map[string]string{
			"missing":    "",
			"wrong":      strings.Repeat("0", 64),
			"not hex":    "zz",
			"other body": s.Sign([]byte(sentryIssuePayload + " ")),
		} {
			r := httptest.NewRequest(http.MethodPost, "/sentry", strings.NewReader(sentryIssuePayload))
			r.Header.Set("sentry-hook-resource", "issue")
			if sig != "" {
				r.Header.Set("sentry-hook-signature", sig)
			}
			if _, err := s.Webhook(r, []byte(sentryIssuePayload)); err != ErrUnauthorized {
				t.Fatalf("%s: err %v, want unauthorized", name, err)
			}
		}
	})
}

func TestSentryVerify(t *testing.T) {
	api := &fakeSentry{
		issues:   map[string]string{"1234567890": "backend", "9": "gears"},
		projects: map[string]bool{"acme/backend": true, "acme/gears": true},
		token:    "sntrys_dev",
	}
	srv := httptest.NewServer(api.handler())
	t.Cleanup(srv.Close)
	s := &Sentry{Secret: []byte("k"), API: srv.URL + "/api/0"}
	ctx := context.Background()

	cases := []struct {
		name  string
		token string
		w     Watch
		want  Watch
		unit  string
		err   error
	}{
		{"issue", "sntrys_dev", Watch{Kind: "issue", ID: "1234567890"}, Watch{Kind: "issue", ID: "1234567890"}, "backend", nil},
		{"missing issue", "sntrys_dev", Watch{Kind: "issue", ID: "42"}, Watch{}, "", ErrForbidden},
		{"malformed issue", "sntrys_dev", Watch{Kind: "issue", ID: "12/34"}, Watch{}, "", ErrForbidden},
		{"issue id with url metacharacters", "sntrys_dev", Watch{Kind: "issue", ID: "%zz"}, Watch{}, "", ErrForbidden},
		{"non-numeric issue id", "sntrys_dev", Watch{Kind: "issue", ID: "abc"}, Watch{}, "", ErrForbidden},
		{"project", "sntrys_dev", Watch{Kind: "project", ID: "acme/backend"}, Watch{Kind: "project", ID: "backend"}, "backend", nil},
		{"project in another org", "sntrys_dev", Watch{Kind: "project", ID: "other/backend"}, Watch{}, "", ErrForbidden},
		{"project without org", "sntrys_dev", Watch{Kind: "project", ID: "backend"}, Watch{}, "", ErrForbidden},
		{"malformed project", "sntrys_dev", Watch{Kind: "project", ID: "acme/back/end"}, Watch{}, "", ErrForbidden},
		{"unknown kind", "sntrys_dev", Watch{Kind: "event", ID: "1"}, Watch{}, "", ErrForbidden},
		{"bad token", "nope", Watch{Kind: "issue", ID: "1234567890"}, Watch{}, "", ErrBadToken},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, unit, err := s.Verify(ctx, c.token, c.w)
			if err != c.err {
				t.Fatalf("err %v, want %v", err, c.err)
			}
			if got != c.want || unit != c.unit {
				t.Fatalf("got %+v %q, want %+v %q", got, unit, c.want, c.unit)
			}
		})
	}

	t.Run("rate limited is unverifiable", func(t *testing.T) {
		api.rateLimit = true
		defer func() { api.rateLimit = false }()
		for _, w := range []Watch{{Kind: "issue", ID: "1234567890"}, {Kind: "project", ID: "acme/backend"}} {
			if _, _, err := s.Verify(ctx, "sntrys_dev", w); !errors.Is(err, ErrUnverifiable) {
				t.Fatalf("%v: err %v, want unverifiable", w, err)
			}
		}
	})

	t.Run("source down is unverifiable", func(t *testing.T) {
		api.down = true
		defer func() { api.down = false }()
		if _, _, err := s.Verify(ctx, "sntrys_dev", Watch{Kind: "issue", ID: "1234567890"}); !errors.Is(err, ErrUnverifiable) {
			t.Fatalf("err %v, want unverifiable", err)
		}
	})
}

func TestSentryEndToEnd(t *testing.T) {
	api := &fakeSentry{
		issues:   map[string]string{"1234567890": "backend"},
		projects: map[string]bool{"acme/backend": true, "acme/secret": false},
		token:    "sntrys_dev",
	}
	apiSrv := httptest.NewServer(api.handler())
	t.Cleanup(apiSrv.Close)
	s := &Sentry{Secret: []byte("s3cret"), API: apiSrv.URL + "/api/0"}
	srv := &Server{Registry: &Registry{Lease: time.Hour}, Adapters: []Adapter{s}}
	public := httptest.NewServer(srv.Public())
	t.Cleanup(public.Close)
	sub := httptest.NewServer(srv.Subscriber())
	t.Cleanup(sub.Close)
	f := &fixture{t: t, srv: srv, public: public, sub: sub}
	conn, events, closeStream := f.stream()
	defer closeStream()

	body, _ := json.Marshal(SubscribeRequest{Connection: conn, Source: "sentry", Token: "sntrys_dev", Watches: []Watch{
		{Kind: "project", ID: "acme/backend"}, {Kind: "issue", ID: "1234567890"}, {Kind: "project", ID: "acme/secret"},
	}})
	resp, err := http.Post(sub.URL+"/v1/subscribe", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var out SubscribeResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if len(out.Leases) != 2 {
		t.Fatalf("leases %+v", out.Leases)
	}
	byKind := map[string]Lease{}
	for _, l := range out.Leases {
		byKind[l.Kind] = l
	}
	if l := byKind["project"]; l.ID != "backend" || l.Unit != "backend" {
		t.Fatalf("project lease %+v", l)
	}
	if l := byKind["issue"]; l.ID != "1234567890" || l.Unit != "backend" {
		t.Fatalf("issue lease %+v", l)
	}
	if len(out.Rejected) != 1 || out.Rejected[0].Reason != "forbidden" {
		t.Fatalf("rejected %+v", out.Rejected)
	}

	deliver := func(resource, payload string, sign bool) int {
		req, _ := http.NewRequest(http.MethodPost, public.URL+"/sentry", strings.NewReader(payload))
		req.Header.Set("sentry-hook-resource", resource)
		if sign {
			req.Header.Set("sentry-hook-signature", s.Sign([]byte(payload)))
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		return r.StatusCode
	}
	// A bad signature is refused and rings nobody.
	if st := deliver("issue", sentryIssuePayload, false); st != 401 {
		t.Fatalf("unsigned: %d", st)
	}
	expectNone(t, events)

	// A project lease receives the issue doorbell.
	if st := deliver("issue", sentryIssuePayload, true); st != 200 {
		t.Fatalf("issue: %d", st)
	}
	select {
	case d := <-events:
		if d.Source != "sentry" || d.Kind != "issue" || d.ID != "1234567890" || d.Unit != "backend" || d.Action != "created" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no issue doorbell")
	}

	// An issue alert for the same project rings it too.
	if st := deliver("event_alert", sentryIssueAlertPayload, true); st != 200 {
		t.Fatalf("issue alert: %d", st)
	}
	select {
	case d := <-events:
		if d.Source != "sentry" || d.Kind != "issue" || d.ID != "1117540176" || d.Unit != "backend" {
			t.Fatalf("got %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no issue-alert doorbell")
	}

	// A resource nobody listens for rings nothing.
	if st := deliver("metric_alert", `{"action":"critical","data":{"metric_alert":{"id":"1"}}}`, true); st != 200 {
		t.Fatalf("metric alert: %d", st)
	}
	expectNone(t, events)
}

func TestSentryDisabled(t *testing.T) {
	s := &Sentry{}
	if _, err := s.Webhook(httptest.NewRequest(http.MethodPost, "/sentry", strings.NewReader(`{}`)), []byte(`{}`)); err != ErrDisabled {
		t.Fatalf("webhook err %v, want disabled", err)
	}
}

func TestSentryProjectSlug(t *testing.T) {
	cases := map[string]string{
		"https://sentry.io/api/0/projects/acme/backend/events/e487/": "backend",
		"https://sentry.io/api/0/projects/acme/backend/":             "backend",
		"https://acme.sentry.io/issues/7/events/e/":                  "",
		"":          "",
		"not a url": "",
	}
	for raw, want := range cases {
		if got := sentryProjectSlug(raw); got != want {
			t.Errorf("sentryProjectSlug(%q) = %q, want %q", raw, got, want)
		}
	}
}
