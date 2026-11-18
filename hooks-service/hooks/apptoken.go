package hooks

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// The app token. Every Linear call for an agent session is made as the bb
// application (actor=app). The service mints that token itself with the
// OAuth client credentials grant, from the application's client id and
// client secret, at startup and again whenever Linear answers 401 to it.
// The token lives in memory only: nothing is persisted beyond the sealed
// client secret, and neither the secret nor the token is ever sent to a
// developer's pod or written to a log.

const (
	// LinearTokenURL is where the client credentials grant is exchanged.
	LinearTokenURL = "https://api.linear.app/oauth/token"
	// LinearAuthorizeURL is Linear's OAuth authorization endpoint, where an
	// admin approves a per-workspace actor=app install.
	LinearAuthorizeURL = "https://linear.app/oauth/authorize"
	// DefaultAppScope is the scope set requested for the app token: enough
	// to read an issue and its people and to post on an agent session, and
	// mentionable but not assignable, so bb is never offered as a delegate.
	// Linear revokes every app token of the application when one is
	// requested with a different scope set, so this is settled once. The
	// per-workspace install requests the same set.
	DefaultAppScope = "read write app:mentionable"
	// defaultAppTokenLife is assumed when the token answer names no
	// expires_in; Linear's client-credentials tokens last 30 days.
	defaultAppTokenLife = 30 * 24 * time.Hour
	// appTokenMargin is how long before expiry a token is replaced, so a
	// call never goes out with one about to lapse.
	appTokenMargin = time.Hour
	// installStateTTL is how long an install approval page may be left open
	// before its signed state is refused.
	installStateTTL = 15 * time.Minute
)

// ErrClientRefused: Linear refused the client id and secret themselves
// (invalid_client or the like), so no app token can be minted until an
// operator fixes the sealed secret. Wraps ErrUnverifiable, because to a
// caller it is "Linear could not be used right now".
var ErrClientRefused = fmt.Errorf("%w: client credentials refused", ErrUnverifiable)

type appToken struct {
	value   string
	expires time.Time
}

func (s *Sessions) clientSecret() string {
	if s.ClientSecretFile == "" {
		return strings.TrimSpace(string(s.ClientSecret))
	}
	b, err := os.ReadFile(s.ClientSecretFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Enabled is false until the client id and client secret are configured.
func (s *Sessions) Enabled() bool { return s != nil && s.ClientID != "" && s.clientSecret() != "" }

// Start mints the first app token so the first session event does not pay
// for it inside the acknowledgement budget, and reconciles the workspace
// token store against the allow-list so a removed workspace's install is
// deleted on startup. Failure of either is not fatal: the token is minted on
// first use instead, and a store failure leaves the last good copy.
func (s *Sessions) Start(ctx context.Context) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	if err := s.reconcileStore(); err != nil {
		s.logger().Warn("linear token store not reconciled", "err", err)
	}
	_, err := s.mint(ctx, "")
	return err
}

// current returns a token good for at least appTokenMargin, minting one
// when there is none or the held one is about to lapse.
func (s *Sessions) current(ctx context.Context) (string, error) {
	s.tokMu.Lock()
	if t := s.tok; t.value != "" && s.now().Add(appTokenMargin).Before(t.expires) {
		s.tokMu.Unlock()
		return t.value, nil
	}
	s.tokMu.Unlock()
	return s.mint(ctx, "")
}

// mint exchanges the client credentials for a new token and holds it.
// stale is the token the caller just saw refused: when another caller has
// already replaced it, that replacement is returned and nothing is minted,
// so a burst of 401s costs one exchange.
func (s *Sessions) mint(ctx context.Context, stale string) (string, error) {
	s.tokMu.Lock()
	defer s.tokMu.Unlock()
	if t := s.tok; t.value != "" && t.value != stale && s.now().Add(appTokenMargin).Before(t.expires) {
		return t.value, nil
	}
	secret := s.clientSecret()
	if s.ClientID == "" || secret == "" {
		return "", ErrDisabled
	}
	scope := s.Scope
	if scope == "" {
		scope = DefaultAppScope
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {s.ClientID},
		"client_secret": {secret},
		"scope":         {scope},
	}
	endpoint := s.TokenURL
	if endpoint == "" {
		endpoint = LinearTokenURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("%w: mint: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		// The error may quote the URL; it never carries the form.
		return "", fmt.Errorf("%w: mint: %v", ErrUnverifiable, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%w: mint: reading the answer", ErrUnverifiable)
	}
	// The answer holds the token; only its OAuth error code is ever
	// repeated, never the body.
	var out struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int64  `json:"expires_in"`
		Error       string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return "", fmt.Errorf("%w: mint: Linear answered %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode >= 400:
		code := out.Error
		if code == "" {
			code = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return "", fmt.Errorf("%w (%s)", ErrClientRefused, code)
	case out.AccessToken == "":
		return "", fmt.Errorf("%w: mint: no token in the answer", ErrUnverifiable)
	}
	life := defaultAppTokenLife
	if out.ExpiresIn > 0 {
		life = time.Duration(out.ExpiresIn) * time.Second
	}
	s.tok = appToken{value: out.AccessToken, expires: s.now().Add(life)}
	s.logger().Info("app token minted", "scope", scope, "expiresIn", life.Round(time.Second).String())
	return out.AccessToken, nil
}

// asApp runs one call as the app. A 401 means the token was revoked or
// lapsed early: a fresh one is minted and the call made once more.
func (s *Sessions) asApp(ctx context.Context, call func(tok string) error) error {
	tok, err := s.current(ctx)
	if err != nil {
		return err
	}
	err = call(tok)
	if !errors.Is(err, ErrBadToken) {
		return err
	}
	s.logger().Warn("app token refused; minting a new one")
	tok, err = s.mint(ctx, tok)
	if err != nil {
		return err
	}
	return call(tok)
}

// tokenStore returns the per-workspace store, loading it once. A load
// failure is logged and leaves an empty store: the pod still runs and a
// later install repairs the file.
func (s *Sessions) tokenStore() *tokenStore {
	s.storeOnce.Do(func() {
		s.store = newTokenStore(s.StorePath)
		if err := s.store.load(); err != nil {
			s.logger().Warn("linear token store not loaded; starting empty", "err", err)
		}
	})
	return s.store
}

// reconcileStore deletes every installed workspace that is no longer in the
// allow-list. That is how an install is revoked: the token pair is removed
// on the next start, and the log names the workspace and never a token.
func (s *Sessions) reconcileStore() error {
	store := s.tokenStore()
	for _, org := range store.list() {
		if s.workspaceAllowed(org) {
			continue
		}
		if err := store.delete(org); err != nil {
			return err
		}
		s.logger().Info("removed Linear workspace token: not in the allow-list", "organizationId", org)
	}
	return nil
}

// workspaceAllowed reports whether org is on the non-home install allow-list.
func (s *Sessions) workspaceAllowed(org string) bool {
	for _, id := range s.AllowedWorkspaces {
		if strings.TrimSpace(id) == org {
			return true
		}
	}
	return false
}

// tokenFor returns a usable app token for the event's workspace. An
// installed workspace's token comes from the store (refreshed as needed); the
// home workspace's is minted with the client credentials grant. Anything else
// is ErrNoWorkspace: the event is dropped before any Linear call.
func (s *Sessions) tokenFor(ctx context.Context, org string) (string, error) {
	if org == "" {
		return "", ErrNoWorkspace
	}
	if _, ok := s.tokenStore().get(org); ok {
		if !s.workspaceAllowed(org) {
			return "", ErrNoWorkspace
		}
		return s.workspaceToken(ctx, org, "")
	}
	home, err := s.homeOrganization(ctx)
	if err != nil {
		return "", err
	}
	if org == home {
		return s.current(ctx)
	}
	return "", ErrNoWorkspace
}

// homeOrganization resolves, once, which organization the application's
// client-credentials token belongs to. The token is minted as usual and
// asked for `organization { id }`; nothing else is read. The answer is
// cached for the process's life.
func (s *Sessions) homeOrganization(ctx context.Context) (string, error) {
	s.homeMu.Lock()
	if s.homeOrg != "" {
		org := s.homeOrg
		s.homeMu.Unlock()
		return org, nil
	}
	s.homeMu.Unlock()

	var out struct {
		Organization *struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	err := s.asApp(ctx, func(tok string) error {
		out.Organization = nil
		return linearGraphQL(ctx, s.HTTP, s.API, tok, `query { organization { id } }`, nil, &out)
	})
	if err != nil {
		return "", err
	}
	if out.Organization == nil || out.Organization.ID == "" {
		return "", fmt.Errorf("%w: home organization not found", ErrUnverifiable)
	}
	s.homeMu.Lock()
	s.homeOrg = out.Organization.ID
	s.homeMu.Unlock()
	s.logger().Info("home Linear workspace resolved", "organizationId", out.Organization.ID)
	return out.Organization.ID, nil
}

// asWorkspace runs one call as the app in org. A 401 means the workspace's
// token lapsed or was revoked: an installed workspace is refreshed once, and
// the home workspace re-minted once, then the call is made again.
func (s *Sessions) asWorkspace(ctx context.Context, org string, call func(tok string) error) error {
	tok, err := s.tokenFor(ctx, org)
	if err != nil {
		return err
	}
	err = call(tok)
	if !errors.Is(err, ErrBadToken) {
		return err
	}
	s.logger().Warn("workspace app token refused; refreshing", "organizationId", org)
	tok, err = s.reacquire(ctx, org, tok)
	if err != nil {
		return err
	}
	return call(tok)
}

// reacquire replaces a token Linear refused, once. An installed workspace
// refreshes its pair; the home workspace mints a new client-credentials
// token.
func (s *Sessions) reacquire(ctx context.Context, org, stale string) (string, error) {
	if _, ok := s.tokenStore().get(org); ok {
		return s.workspaceToken(ctx, org, stale)
	}
	return s.mint(ctx, stale)
}

// workspaceToken returns an installed workspace's access token, refreshing
// it when it is within the margin of expiry or when stale is the token just
// refused. A usable token is returned without the refresh lock, so a refresh
// of one workspace never delays a call in another; refreshes themselves are
// serialized, so a rotating refresh token is not raced by concurrent calls.
func (s *Sessions) workspaceToken(ctx context.Context, org, stale string) (string, error) {
	if st, ok := s.tokenStore().get(org); ok && st.AccessToken != "" && st.AccessToken != stale && s.now().Add(appTokenMargin).Before(st.ExpiresAt) {
		return st.AccessToken, nil
	}
	s.wsMu.Lock()
	defer s.wsMu.Unlock()
	st, ok := s.tokenStore().get(org)
	if !ok {
		return "", ErrNoWorkspace
	}
	if st.AccessToken != "" && st.AccessToken != stale && s.now().Add(appTokenMargin).Before(st.ExpiresAt) {
		return st.AccessToken, nil
	}
	nt, err := s.refresh(ctx, org, st)
	if err != nil {
		return "", err
	}
	return nt.AccessToken, nil
}

// refresh exchanges an installed workspace's refresh token for a new pair
// and persists it. Linear may rotate the refresh token, so the answer's is
// stored when it names one. A refusal is ErrRefreshRefused, logged with the
// workspace id and Linear's error code only; no token or secret is ever
// logged or put in the error.
func (s *Sessions) refresh(ctx context.Context, org string, st storedToken) (storedToken, error) {
	if st.RefreshToken == "" {
		s.logger().Warn("workspace token cannot be refreshed: no refresh token", "organizationId", org)
		return storedToken{}, fmt.Errorf("%w: no refresh token for workspace", ErrUnverifiable)
	}
	secret := s.clientSecret()
	if s.ClientID == "" || secret == "" {
		return storedToken{}, ErrDisabled
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {st.RefreshToken},
		"client_id":     {s.ClientID},
		"client_secret": {secret},
	}
	endpoint := s.TokenURL
	if endpoint == "" {
		endpoint = LinearTokenURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: refresh: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: refresh: %v", ErrUnverifiable, transportCause(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: refresh: reading the answer", ErrUnverifiable)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
		Error        string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return storedToken{}, fmt.Errorf("%w: refresh: Linear answered %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode >= 400:
		code := out.Error
		if code == "" {
			code = fmt.Sprintf("status %d", resp.StatusCode)
		}
		s.logger().Warn("workspace token refresh refused", "organizationId", org, "code", code)
		return storedToken{}, fmt.Errorf("%w (%s)", ErrRefreshRefused, code)
	case out.AccessToken == "":
		return storedToken{}, fmt.Errorf("%w: refresh: no token in the answer", ErrUnverifiable)
	}
	if out.RefreshToken == "" {
		out.RefreshToken = st.RefreshToken
	}
	life := defaultAppTokenLife
	if out.ExpiresIn > 0 {
		life = time.Duration(out.ExpiresIn) * time.Second
	}
	nt := storedToken{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, ExpiresAt: s.now().Add(life), Scope: out.Scope}
	if err := s.tokenStore().put(org, nt); err != nil {
		s.logger().Warn("workspace token not persisted", "organizationId", org, "err", err)
	}
	s.logger().Info("workspace token refreshed", "organizationId", org, "expiresIn", life.Round(time.Second).String())
	return nt, nil
}

// The install flow. A Linear admin opens GET /linear/install, approves the
// application with actor=app in the workspace, and comes back to
// GET /linear/install/callback with a code and a signed state. The callback
// exchanges the code, reads the workspace the token belongs to, refuses it
// unless the allow-list names it, and stores the token pair. Nothing is
// stored for a refused workspace.

// installAuthorizeURL is Linear's authorization endpoint, overridable for
// tests.
func (s *Sessions) installAuthorizeURL() string {
	if s.AuthorizeURL != "" {
		return s.AuthorizeURL
	}
	return LinearAuthorizeURL
}

// installRedirect is the registered callback URI, overridable for tests.
// There is no built-in default: it is deployment configuration and must be
// listed in the Linear application's redirect URIs by hand, so an operator
// sets -linear-install-redirect-url (or LINEAR_INSTALL_REDIRECT_URL).
func (s *Sessions) installRedirect() string {
	return s.InstallRedirectURL
}

// stateKey derives the HMAC key for install state from the client secret, so
// a state cannot be forged without the secret and survives a restart.
func (s *Sessions) stateKey() []byte {
	sum := sha256.Sum256([]byte("hooks-service linear install state\x00" + s.clientSecret()))
	return sum[:]
}

// installState signs a timestamp and nonce: base64url(ts.nonce).mac. No
// server-side storage is needed and a restart does not invalidate an open
// approval page.
func (s *Sessions) installState() (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	payload := strconv.FormatInt(s.now().Unix(), 10) + "." + base64.RawURLEncoding.EncodeToString(nonce)
	mac := hmac.New(sha256.New, s.stateKey())
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// validInstallState checks the signature and the age. A bad, tampered,
// future or older-than-installStateTTL state is refused.
func (s *Sessions) validInstallState(state string) bool {
	parts := strings.Split(state, ".")
	if len(parts) != 3 {
		return false
	}
	ts, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, s.stateKey())
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(mac.Sum(nil), want) {
		return false
	}
	at := time.Unix(ts, 0)
	age := s.now().Sub(at)
	return age <= installStateTTL && age >= -time.Minute
}

// linearInstallStart redirects the admin's browser to Linear's consent page.
func (s *Sessions) linearInstallStart(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	state, err := s.installState()
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	scope := s.Scope
	if scope == "" {
		scope = DefaultAppScope
	}
	u, err := url.Parse(s.installAuthorizeURL())
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	q := u.Query()
	q.Set("client_id", s.ClientID)
	q.Set("redirect_uri", s.installRedirect())
	q.Set("response_type", "code")
	q.Set("scope", strings.Join(strings.Fields(scope), ","))
	q.Set("state", state)
	q.Set("actor", "app")
	q.Set("prompt", "consent")
	u.RawQuery = q.Encode()
	s.logger().Info("linear install started")
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// linearInstallCallback completes the install. It refuses a bad or expired
// state, a workspace not on the allow-list, and any exchange failure; in
// every refusal nothing is stored.
func (s *Sessions) linearInstallCallback(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		s.logger().Warn("linear install refused by Linear", "error", e)
		http.Error(w, "Linear refused the install", http.StatusBadRequest)
		return
	}
	if !s.validInstallState(q.Get("state")) {
		s.logger().Warn("linear install callback: bad or expired state")
		http.Error(w, "bad or expired state", http.StatusBadRequest)
		return
	}
	code := q.Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	tok, err := s.exchangeCode(r.Context(), code)
	if err != nil {
		s.warn(s.logger(), "linear install: code exchange failed", err)
		http.Error(w, "install failed", http.StatusBadGateway)
		return
	}
	org, name, err := s.workspaceOfToken(r.Context(), tok.AccessToken)
	if err != nil {
		s.warn(s.logger(), "linear install: workspace not read", err)
		http.Error(w, "install failed", http.StatusBadGateway)
		return
	}
	if !s.workspaceAllowed(org) {
		s.logger().Warn("linear install refused: workspace not in the allow-list", "organizationId", org)
		http.Error(w, "this workspace is not on the allow-list", http.StatusForbidden)
		return
	}
	if err := s.tokenStore().put(org, tok); err != nil {
		s.warn(s.logger(), "linear install: token not stored", err)
		http.Error(w, "install failed", http.StatusInternalServerError)
		return
	}
	s.logger().Info("linear workspace installed", "organizationId", org)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, "<!doctype html><meta charset=\"utf-8\"><title>bb installed</title><p>bb is installed in %s. You can close this tab.</p>\n", html.EscapeString(name))
}

// exchangeCode exchanges an authorization code for the workspace's token
// pair. The code and the tokens are never logged.
func (s *Sessions) exchangeCode(ctx context.Context, code string) (storedToken, error) {
	secret := s.clientSecret()
	if s.ClientID == "" || secret == "" {
		return storedToken{}, ErrDisabled
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {s.installRedirect()},
		"client_id":     {s.ClientID},
		"client_secret": {secret},
	}
	endpoint := s.TokenURL
	if endpoint == "" {
		endpoint = LinearTokenURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: install: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: install: %v", ErrUnverifiable, transportCause(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return storedToken{}, fmt.Errorf("%w: install: reading the answer", ErrUnverifiable)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
		Error        string `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return storedToken{}, fmt.Errorf("%w: install: Linear answered %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode >= 400:
		code := out.Error
		if code == "" {
			code = fmt.Sprintf("status %d", resp.StatusCode)
		}
		return storedToken{}, fmt.Errorf("%w: install: %s", ErrUnverifiable, code)
	case out.AccessToken == "":
		return storedToken{}, fmt.Errorf("%w: install: no token in the answer", ErrUnverifiable)
	}
	life := defaultAppTokenLife
	if out.ExpiresIn > 0 {
		life = time.Duration(out.ExpiresIn) * time.Second
	}
	return storedToken{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, ExpiresAt: s.now().Add(life), Scope: out.Scope}, nil
}

// workspaceOfToken reads which organization an app token belongs to, with
// that token. Only the id and name are read.
func (s *Sessions) workspaceOfToken(ctx context.Context, token string) (string, string, error) {
	var out struct {
		Organization *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"organization"`
	}
	if err := linearGraphQL(ctx, s.HTTP, s.API, token, `query { organization { id name } }`, nil, &out); err != nil {
		return "", "", err
	}
	if out.Organization == nil || out.Organization.ID == "" {
		return "", "", fmt.Errorf("%w: workspace not found", ErrUnverifiable)
	}
	return out.Organization.ID, out.Organization.Name, nil
}
