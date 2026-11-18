package hooks

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Registry holds every open event stream and the leases bound to it. All
// in memory: a lease must not outlive the token that proved it, and a
// restart is repaired by subscribers re-sending their watch sets.
type Registry struct {
	Lease time.Duration
	Now   func() time.Time
	// MaxPerRemote caps open streams from one address (one pod). A
	// subscriber needs one; the cap keeps a broken or hostile one from
	// holding memory for everyone. 0 means DefaultMaxPerRemote.
	MaxPerRemote int

	mu    sync.Mutex
	conns map[string]*Conn
}

// DefaultMaxPerRemote is the stream cap per address when unset.
const DefaultMaxPerRemote = 8

// ErrTooManyStreams: the remote already holds MaxPerRemote streams.
var ErrTooManyStreams = errors.New("too many streams from this address")

// Conn is one subscriber stream.
type Conn struct {
	ID     string
	Remote string
	// Events is what the stream handler drains. Bounded: a subscriber that
	// stops reading loses doorbells rather than holding memory, which is
	// safe because doorbells are a hint and the subscriber re-checks.
	Events chan Doorbell
	// Wakes carries agent sessions routed to this stream, bounded the same
	// way. See Sessions.
	Wakes chan SessionWake
	// SlackWakes carries Slack agent sessions routed to this stream, the
	// same shape with source "slack". See Slack.
	SlackWakes chan SlackWake

	mu       sync.Mutex
	seq      uint64
	leases   map[leaseKey]lease
	identity map[string]Identity // by source
}

// Identity is who a stream's server proved it is for one source, with the
// developer's own token, and the units its projects cover. Like a lease it
// lives in memory, bound to the stream, and expires unless re-proven.
type Identity struct {
	User    string
	Name    string
	Units   map[string]bool
	Proven  time.Time
	Expires time.Time
}

type leaseKey struct {
	source string
	w      Watch
}

type lease struct {
	unit    string
	expires time.Time
}

// Lease is an admitted watch as reported back to the subscriber.
type Lease struct {
	Kind      string    `json:"kind"`
	ID        string    `json:"id"`
	Unit      string    `json:"unit"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (r *Registry) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Open registers a new stream from remote (an address without port) and
// returns it, or ErrTooManyStreams.
func (r *Registry) Open(remote string) (*Conn, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failing is not something to continue past
	}
	c := &Conn{
		ID:         "c_" + hex.EncodeToString(b),
		Remote:     remote,
		Events:     make(chan Doorbell, 256),
		Wakes:      make(chan SessionWake, 16),
		SlackWakes: make(chan SlackWake, 16),
		leases:     map[leaseKey]lease{},
		identity:   map[string]Identity{},
	}
	limit := r.MaxPerRemote
	if limit <= 0 {
		limit = DefaultMaxPerRemote
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns == nil {
		r.conns = map[string]*Conn{}
	}
	n := 0
	for _, o := range r.conns {
		if o.Remote == remote {
			n++
		}
	}
	if n >= limit {
		return nil, ErrTooManyStreams
	}
	r.conns[c.ID] = c
	return c, nil
}

// Close forgets a stream and every lease bound to it.
func (r *Registry) Close(c *Conn) {
	r.mu.Lock()
	delete(r.conns, c.ID)
	r.mu.Unlock()
}

// Get returns a stream by id, or nil.
func (r *Registry) Get(id string) *Conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.conns[id]
}

// Len is the number of open streams.
func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

// Bind admits or renews a watch on the stream and returns the lease.
func (r *Registry) Bind(c *Conn, source string, w Watch, unit string) Lease {
	exp := r.now().Add(r.Lease)
	c.mu.Lock()
	c.leases[leaseKey{source, w}] = lease{unit: unit, expires: exp}
	c.mu.Unlock()
	return Lease{Kind: w.Kind, ID: w.ID, Unit: unit, ExpiresAt: exp}
}

// Identify binds a proven identity to the stream for a source, replacing
// any earlier one: units is the whole set, not an addition. Returns when it
// expires.
func (r *Registry) Identify(c *Conn, source, user, name string, units []string) time.Time {
	now := r.now()
	id := Identity{User: user, Name: name, Units: map[string]bool{}, Proven: now, Expires: now.Add(r.Lease)}
	for _, u := range units {
		id.Units[u] = true
	}
	c.mu.Lock()
	c.identity[source] = id
	c.mu.Unlock()
	return id.Expires
}

// IdentityOf returns the stream's current identity for a source.
func (r *Registry) IdentityOf(c *Conn, source string) (Identity, bool) {
	now := r.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	id, ok := c.identity[source]
	if !ok || !id.Expires.After(now) {
		delete(c.identity, source)
		return Identity{}, false
	}
	return id, true
}

// ByUser returns the open stream that most recently proved it is user for
// a source, or nil. Only connected servers can be found: there is no
// record of anyone who is not connected right now.
func (r *Registry) ByUser(source, user string) (*Conn, Identity) {
	if user == "" {
		return nil, Identity{}
	}
	r.mu.Lock()
	conns := make([]*Conn, 0, len(r.conns))
	for _, c := range r.conns {
		conns = append(conns, c)
	}
	r.mu.Unlock()
	var best *Conn
	var bestID Identity
	for _, c := range conns {
		id, ok := r.IdentityOf(c, source)
		if !ok || id.User != user {
			continue
		}
		if best == nil || id.Proven.After(bestID.Proven) {
			best, bestID = c, id
		}
	}
	return best, bestID
}

// Leases returns the stream's current, unexpired leases for a source.
func (r *Registry) Leases(c *Conn, source string) []Lease {
	now := r.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Lease
	for k, l := range c.leases {
		if k.source != source {
			continue
		}
		if !l.expires.After(now) {
			delete(c.leases, k)
			continue
		}
		out = append(out, Lease{Kind: k.w.Kind, ID: k.w.ID, Unit: l.unit, ExpiresAt: l.expires})
	}
	return out
}

// Deliver sends d to every stream holding a matching current lease. One
// doorbell per stream however many of its leases match. Returns how many
// streams it reached and how many dropped it for a full buffer.
func (r *Registry) Deliver(a Adapter, d Doorbell) (sent, dropped int) {
	now := r.now()
	r.mu.Lock()
	conns := make([]*Conn, 0, len(r.conns))
	for _, c := range r.conns {
		conns = append(conns, c)
	}
	r.mu.Unlock()
	for _, c := range conns {
		if !c.matches(a, d, now) {
			continue
		}
		select {
		case c.Events <- d:
			sent++
		default:
			dropped++
		}
	}
	return sent, dropped
}

func (c *Conn) matches(a Adapter, d Doorbell, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, l := range c.leases {
		if !l.expires.After(now) {
			delete(c.leases, k)
			continue
		}
		if k.source == d.Source && Matches(a, k.w, d) {
			return true
		}
	}
	return false
}

// Next returns the stream's next event sequence number.
func (c *Conn) Next() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	return c.seq
}
