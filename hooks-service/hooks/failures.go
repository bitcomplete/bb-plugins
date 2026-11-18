package hooks

import "sync"

// verifyFailureThreshold is how many consecutive unverifiable verifies a
// watch may have before the failure is reported to Sentry. A single
// transient timeout or transport error is expected to clear on its own; a
// watch that keeps failing is worth an issue.
const verifyFailureThreshold = 3

// verifyFailures counts consecutive unverifiable verifies per watch, so a
// transient failure is not reported to Sentry on the first rejection. The
// key is the source, the watch and the connection it was subscribed on,
// never the token: a token is rotated and shared, while the watch and the
// connection are what is being watched. A successful verify, and a refusal
// of the token or the entity (401/403), clear the entry. Memory only, and
// only for watches that are currently failing.
//
// The count is over every unverifiable failure except a rate limit: a watch
// that has failed three times running has failed, and a 5xx after two
// timeouts is still its third consecutive failure. A rate-limited failure is
// a known window that neither counts toward nor clears the streak. Every
// counted failure is suppressed until the threshold, so one slow Linear call
// neither drops the lease nor reaches Sentry.
type verifyFailures struct {
	mu     sync.Mutex
	counts map[watchKey]int
}

type watchKey struct {
	source     string
	kind       string
	id         string
	connection string
}

// fail records one unverifiable verify and returns the watch's consecutive
// failure count.
func (f *verifyFailures) fail(source string, w Watch, connection string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.counts == nil {
		f.counts = map[watchKey]int{}
	}
	k := watchKey{source, w.Kind, w.ID, connection}
	f.counts[k]++
	return f.counts[k]
}

// succeed clears the watch's consecutive failure count.
func (f *verifyFailures) succeed(source string, w Watch, connection string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.counts, watchKey{source, w.Kind, w.ID, connection})
}
