package hooks

import (
	"crypto/sha256"
	"sync"
	"time"
)

// verifyCache remembers that a token could read an entity, so renewing many
// watches costs the source nothing. Keyed by a hash of the token and the
// entity, never the token; only successes are kept; memory only.
type verifyCache struct {
	TTL time.Duration
	// SentryTTL, when positive, overrides TTL for source "sentry". Sentry
	// verify reads are the scarce ones, so they are kept longer than the
	// rest; a non-positive value means every source shares TTL.
	SentryTTL time.Duration
	// Stale, when positive, is how long an expired successful Sentry
	// verification is kept so it can be served as a success when Sentry
	// rate-limits a renewal (the 5-per-30-min issue-read limit). It is the
	// grace past TTL, so an entry lives TTL+Stale. Zero disables stale
	// serving. Only "sentry" gets a grace; every other source is dropped at
	// expiry as before.
	Stale time.Duration
	Now   func() time.Time

	mu      sync.Mutex
	entries map[[32]byte]cacheEntry
}

// ttlFor is how long a successful verify of source is remembered. A
// non-positive shared TTL disables the cache for every source, Sentry
// included, whatever SentryTTL says; otherwise Sentry may override it.
func (c *verifyCache) ttlFor(source string) time.Duration {
	if c.TTL <= 0 {
		return 0
	}
	if source == "sentry" && c.SentryTTL > 0 {
		return c.SentryTTL
	}
	return c.TTL
}

// staleFor is how long past expiry a successful verify of source may still
// be served. Only Sentry has a grace: its issue reads are the scarce ones a
// 429 is worth papering over. Every other source is dropped at expiry.
func (c *verifyCache) staleFor(source string) time.Duration {
	if c.Stale <= 0 || source != "sentry" {
		return 0
	}
	return c.Stale
}

type cacheEntry struct {
	canonical Watch
	unit      string
	expires   time.Time
	// staleUntil is when the entry is finally dropped: expires plus the
	// source's stale grace. It equals expires for a source with no grace.
	staleUntil time.Time
}

func cacheKey(token, source string, w Watch) [32]byte {
	h := sha256.New()
	for _, s := range []string{token, source, w.Kind, w.ID} {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	var k [32]byte
	copy(k[:], h.Sum(nil))
	return k
}

func (c *verifyCache) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *verifyCache) get(token, source string, w Watch) (Watch, string, bool) {
	if c == nil || c.ttlFor(source) <= 0 {
		return Watch{}, "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[cacheKey(token, source, w)]
	if !ok || !e.expires.After(c.now()) {
		return Watch{}, "", false
	}
	return e.canonical, e.unit, true
}

// getStale serves a successful verify whose TTL has passed but whose stale
// grace has not. It is what subscribe falls back to when a renewal read is
// rate limited: the source could not be asked, but the token read the entity
// recently enough that the watch may keep its lease. A source with no grace,
// or an entry past expires+grace, is a miss.
func (c *verifyCache) getStale(token, source string, w Watch) (Watch, string, bool) {
	if c == nil || c.staleFor(source) <= 0 {
		return Watch{}, "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[cacheKey(token, source, w)]
	if !ok || !e.staleUntil.After(c.now()) {
		return Watch{}, "", false
	}
	return e.canonical, e.unit, true
}

func (c *verifyCache) put(token, source string, w, canonical Watch, unit string) {
	if c == nil {
		return
	}
	ttl := c.ttlFor(source)
	if ttl <= 0 {
		return
	}
	now := c.now()
	grace := c.staleFor(source)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[[32]byte]cacheEntry{}
	}
	// Sweep opportunistically; the map is small and this is the write path.
	// An entry is kept past expiry for its stale grace, so the sweep uses
	// staleUntil, not expires.
	for k, e := range c.entries {
		if !e.staleUntil.After(now) {
			delete(c.entries, k)
		}
	}
	c.entries[cacheKey(token, source, w)] = cacheEntry{
		canonical:  canonical,
		unit:       unit,
		expires:    now.Add(ttl),
		staleUntil: now.Add(ttl + grace),
	}
}

// verifyStats counts verification cache outcomes per source, so the reads
// hooks makes per interval are measurable. Memory only; a snapshot resets it.
type verifyStats struct {
	mu     sync.Mutex
	hits   map[string]int
	misses map[string]int
}

// hit records one verify served from the cache.
func (v *verifyStats) hit(source string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.hits == nil {
		v.hits = map[string]int{}
	}
	v.hits[source]++
}

// miss records one verify that had to read the source.
func (v *verifyStats) miss(source string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.misses == nil {
		v.misses = map[string]int{}
	}
	v.misses[source]++
}

// verifyCount is one source's cache hits and misses since the last snapshot.
type verifyCount struct {
	Hits   int
	Misses int
}

// snapshot returns the per-source counts and resets them, so each log line
// covers one interval.
func (v *verifyStats) snapshot() map[string]verifyCount {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make(map[string]verifyCount, len(v.hits)+len(v.misses))
	for source, n := range v.hits {
		c := out[source]
		c.Hits = n
		out[source] = c
	}
	for source, n := range v.misses {
		c := out[source]
		c.Misses = n
		out[source] = c
	}
	v.hits = nil
	v.misses = nil
	return out
}
