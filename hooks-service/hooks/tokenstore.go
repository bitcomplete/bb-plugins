package hooks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The per-workspace app token store. The home workspace's app token is
// minted with the client credentials grant and held in memory (apptoken.go);
// every other workspace needs a one-time actor=app authorization-code install
// by one of its admins, and that token pair is persisted here so it survives
// a restart and can be refreshed. The store is one small JSON file on a PVC,
// written atomically and 0600. No token value is ever logged, returned in an
// error, or sent to a developer's pod.

// ErrNoWorkspace means the event's Linear workspace has no app token: it is
// neither the home workspace nor one the allow-list admits. The event is
// dropped and the organization id is logged.
var ErrNoWorkspace = errors.New("no app token for workspace")

// ErrRefreshRefused: Linear refused a workspace's refresh token (the install
// was revoked or the token rotated away). It wraps ErrUnverifiable, because
// to a caller the workspace's Linear is simply unavailable until an admin
// installs it again.
var ErrRefreshRefused = fmt.Errorf("%w: workspace token refresh refused", ErrUnverifiable)

// storedToken is one installed workspace's app token pair. ExpiresAt is when
// the access token lapses; a zero value means Linear named no lifetime and it
// is refreshed only when refused.
type storedToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	Scope        string    `json:"scope,omitempty"`
}

// tokenStoreFile is the on-disk shape. Version is written so a future change
// can migrate rather than guess.
type tokenStoreFile struct {
	Version    int                    `json:"version"`
	Workspaces map[string]storedToken `json:"workspaces"`
}

// tokenStore is a file-backed map of organization id to token pair. An empty
// path keeps the store in memory only (the tests' default); the cluster mounts
// a PVC and points -linear-token-store at a file on it.
type tokenStore struct {
	path string

	mu sync.Mutex
	ws map[string]storedToken
}

func newTokenStore(path string) *tokenStore {
	return &tokenStore{path: path, ws: map[string]storedToken{}}
}

// load reads the file into memory. A missing file is an empty store, not an
// error: the first install creates it. A malformed file is an error, and the
// caller keeps the empty store rather than refusing to start.
func (st *tokenStore) load() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.path == "" {
		return nil
	}
	raw, err := os.ReadFile(st.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			st.ws = map[string]storedToken{}
			return nil
		}
		return err
	}
	var f tokenStoreFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return err
	}
	if f.Workspaces == nil {
		f.Workspaces = map[string]storedToken{}
	}
	st.ws = f.Workspaces
	return nil
}

// saveLocked writes the store atomically: a 0600 temp file in the same
// directory, fsynced and renamed over the target, so a crash never leaves a
// half-written file and the file is never world-readable.
func (st *tokenStore) saveLocked() error {
	if st.path == "" {
		return nil
	}
	dir := filepath.Dir(st.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(tokenStoreFile{Version: 1, Workspaces: st.ws}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tokens-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, st.path)
}

func (st *tokenStore) get(org string) (storedToken, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	t, ok := st.ws[org]
	return t, ok
}

// put records a token pair and persists the store. A failed write is
// returned; the in-memory copy still holds, so the running pod keeps working
// and a later write can repair the file.
func (st *tokenStore) put(org string, tok storedToken) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.ws == nil {
		st.ws = map[string]storedToken{}
	}
	st.ws[org] = tok
	return st.saveLocked()
}

func (st *tokenStore) delete(org string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, ok := st.ws[org]; !ok {
		return nil
	}
	delete(st.ws, org)
	return st.saveLocked()
}

// list returns a copy of the workspace ids, so a caller may delete while
// iterating.
func (st *tokenStore) list() []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]string, 0, len(st.ws))
	for org := range st.ws {
		out = append(out, org)
	}
	return out
}
