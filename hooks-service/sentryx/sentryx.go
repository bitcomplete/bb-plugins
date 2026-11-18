// Package sentryx wires Sentry into the hooks service. It is the only place
// that knows about the SDK.
//
// Reporting is off unless SENTRY_DSN is set. The DSN is plain config, not a
// secret: it is read from the environment, never logged, and never written to
// a file. When it is absent every binary behaves exactly as before and the
// startup log says so once.
//
// Everything that leaves for Sentry passes through [scrub] in BeforeSend:
// request bodies and headers are dropped, and the credential-shaped text the
// stewards plugin already redacts from logs is redacted here too. Events are
// errors only: no transactions, no profiling, no PII, no breadcrumbs. The
// SDK's transport queue is in memory; nothing is written to disk, which keeps
// the hooks service's "no persistence" invariant.
package sentryx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
)

// release is the image tag the Dockerfile records, set at build time with
//
//	go build -ldflags "-X hooks-service/sentryx.release=<tag>"
//
// "dev" outside a built image.
var release = "dev"

// environment is fixed: these are production processes.
const environment = "production"

// Options configures Init.
type Options struct {
	// Service is the binary's name, reported as the "service" tag.
	Service string
	// Owner, when set, is reported as the "owner" tag, so one noisy owner
	// is one issue.
	Owner string
	// Release overrides the build-time release. Empty uses the baked value.
	Release string
	// DSN overrides SENTRY_DSN. Empty falls back to the environment. Plain
	// config, never logged.
	DSN string
	// Transport is a test seam. Nil uses the SDK's HTTP transport.
	Transport sentry.Transport
	// Logger receives the one enabled/disabled line at startup. It must be
	// the unwrapped logger: this is called before the slog handler exists.
	// Defaults to slog.Default().
	Logger *slog.Logger
}

// Client is an initialized reporter. A disabled Client is valid and every
// method is a no-op, so callers never need a nil check.
type Client struct {
	client  *sentry.Client
	enabled bool
	log     *slog.Logger
}

// Init builds the reporter from SENTRY_DSN. An unset DSN returns a disabled
// Client and no error. A malformed DSN returns a disabled Client and the
// parse error, so a binary can keep running without Sentry rather than fail
// to start over a bad secret.
func Init(opts Options) (*Client, error) {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	dsn := strings.TrimSpace(opts.DSN)
	if dsn == "" {
		dsn = strings.TrimSpace(os.Getenv("SENTRY_DSN"))
	}
	rel := strings.TrimSpace(opts.Release)
	if rel == "" {
		rel = release
	}
	c := &Client{log: log}
	if dsn == "" {
		log.Info("sentry disabled: SENTRY_DSN is not set", "service", opts.Service)
		setDefault(c)
		return c, nil
	}
	tags := map[string]string{"service": opts.Service}
	if opts.Owner != "" {
		tags["owner"] = opts.Owner
	}
	dedupe := &deduper{window: time.Minute, max: 1024}
	sc, err := sentry.NewClient(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      environment,
		Release:          rel,
		Tags:             tags,
		AttachStacktrace: true,
		// Errors only, and nothing that identifies anyone: no PII, no
		// transactions, no profiling, no breadcrumbs.
		SendDefaultPII:   false,
		TracesSampleRate: 0,
		EnableTracing:    false,
		MaxBreadcrumbs:   -1,
		Transport:        opts.Transport,
		BeforeSend: func(e *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			e = scrub(e)
			if e == nil {
				return nil
			}
			if !dedupe.allow(fingerprint(e), time.Now()) {
				return nil
			}
			return e
		},
	})
	if err != nil {
		// Never log the DSN, only that it could not be used.
		log.Error("sentry disabled: SENTRY_DSN is not usable", "service", opts.Service, "err", err)
		setDefault(c)
		return c, err
	}
	c.client = sc
	c.enabled = true
	log.Info("sentry enabled", "service", opts.Service, "release", rel, "environment", environment)
	setDefault(c)
	return c, nil
}

// Enabled reports whether events are being sent.
func (c *Client) Enabled() bool { return c != nil && c.enabled }

// CaptureError reports an error, with optional slog-style key/value attrs
// added as event context. It is a no-op when Sentry is disabled or err is
// nil.
func (c *Client) CaptureError(err error, attrs ...any) {
	if c == nil || !c.enabled || err == nil {
		return
	}
	event := c.client.EventFromException(err, sentry.LevelError)
	if event == nil {
		return
	}
	addExtra(event, attrs)
	c.client.CaptureEvent(event, nil, nil)
}

// CaptureMessage reports a message at error level.
func (c *Client) CaptureMessage(msg string, attrs ...any) {
	if c == nil || !c.enabled || msg == "" {
		return
	}
	event := c.client.EventFromMessage(msg, sentry.LevelError)
	if event == nil {
		return
	}
	addExtra(event, attrs)
	c.client.CaptureEvent(event, nil, nil)
}

// Recover wraps next so a panic in a handler is reported and still answered
// with a 500. The panic is also written to the unwrapped logger, so it stays
// in the pod logs.
func (c *Client) Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			// http.ErrAbortHandler is what net/http and
			// httputil.ReverseProxy panic with when the client goes away
			// mid-response. net/http treats it as a silent abort of the
			// connection, not a fault, so it is not reported. Re-panic so
			// that handling stays exactly as before.
			if v == http.ErrAbortHandler {
				panic(v)
			}
			if c != nil && c.enabled {
				c.client.Recover(v, nil, nil)
			}
			if c != nil && c.log != nil {
				c.log.Error("panic recovered", "err", fmt.Sprint(v), "path", r.URL.Path, "remote", r.RemoteAddr)
			}
			http.Error(w, "internal server error", http.StatusInternalServerError)
		}()
		next.ServeHTTP(w, r)
	})
}

// Flush waits up to timeout for queued events to leave.
func (c *Client) Flush(timeout time.Duration) {
	if c != nil && c.client != nil {
		c.client.Flush(timeout)
	}
}

// Close releases the SDK's resources.
func (c *Client) Close() {
	if c != nil && c.client != nil {
		c.client.Close()
	}
}

// NewHandler wraps inner so Error records are also sent to Sentry, with the
// record's attributes as event context. It is the cheap way to make the
// existing slog.Error calls into events without touching every call site.
func NewHandler(inner slog.Handler, c *Client) slog.Handler {
	return &slogHandler{inner: inner, client: c}
}

var (
	defaultMu     sync.RWMutex
	defaultClient *Client
)

func setDefault(c *Client) {
	defaultMu.Lock()
	defaultClient = c
	defaultMu.Unlock()
}

// Default returns the Client last built by Init, or nil.
func Default() *Client {
	defaultMu.RLock()
	defer defaultMu.RUnlock()
	return defaultClient
}

// CaptureError reports through the default Client. Library packages use it
// so they do not have to thread a Client through every constructor.
func CaptureError(err error, attrs ...any) {
	if c := Default(); c != nil {
		c.CaptureError(err, attrs...)
	}
}

// CaptureMessage reports through the default Client.
func CaptureMessage(msg string, attrs ...any) {
	if c := Default(); c != nil {
		c.CaptureMessage(msg, attrs...)
	}
}

// extraContextKey names the event context that holds the slog-style attrs
// callers pass to CaptureError, CaptureMessage and the slog handler. The SDK
// removed Event.Extra in v0.50.0; for error events the documented replacement
// is a context, which is what Sentry renders as additional data.
const extraContextKey = "extra"

// extraContext returns the event's mutable attrs context, creating it if
// needed. Context is a map, so the returned value aliases the event's.
func extraContext(event *sentry.Event) sentry.Context {
	if event.Contexts == nil {
		event.Contexts = map[string]sentry.Context{}
	}
	ctx, ok := event.Contexts[extraContextKey]
	if !ok || ctx == nil {
		ctx = sentry.Context{}
		event.Contexts[extraContextKey] = ctx
	}
	return ctx
}

func addExtra(event *sentry.Event, attrs []any) {
	ctx := extraContext(event)
	for i := 0; i+1 < len(attrs); i += 2 {
		ctx[fmt.Sprint(attrs[i])] = attrs[i+1]
	}
}

// slogHandler forwards Error records to Sentry and everything to inner.
type slogHandler struct {
	inner  slog.Handler
	client *Client
	attrs  []slog.Attr
	groups []string
}

func (h *slogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *slogHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError && h.client != nil && h.client.enabled {
		extra := map[string]any{}
		for _, a := range h.attrs {
			addAttr(extra, h.groups, a)
		}
		r.Attrs(func(a slog.Attr) bool {
			addAttr(extra, h.groups, a)
			return true
		})
		h.client.captureMessage(r.Message, extra)
	}
	return h.inner.Handle(ctx, r)
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	nh := *h
	// Forward the attrs to the wrapped handler so a logger.With attr reaches
	// the real output, and keep our own copy for the Sentry extras, which
	// inner never sees. The record itself stays bare, so nothing is emitted
	// twice.
	nh.inner = h.inner.WithAttrs(attrs)
	nh.attrs = append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &nh
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	nh := *h
	nh.inner = h.inner.WithGroup(name)
	nh.groups = append(append([]string{}, h.groups...), name)
	return &nh
}

func (c *Client) captureMessage(msg string, extra map[string]any) {
	event := c.client.EventFromMessage(msg, sentry.LevelError)
	if event == nil {
		return
	}
	ctx := extraContext(event)
	for k, v := range extra {
		ctx[k] = v
	}
	c.client.CaptureEvent(event, nil, nil)
}

func addAttr(m map[string]any, groups []string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		gs := append(append([]string{}, groups...), a.Key)
		for _, ga := range a.Value.Group() {
			addAttr(m, gs, ga)
		}
		return
	}
	key := a.Key
	if len(groups) > 0 {
		key = strings.Join(groups, ".") + "." + key
	}
	m[key] = a.Value.Any()
}

// deduper rate-limits events by fingerprint so a failure that repeats cannot
// loop through Sentry's own doorbell: a Sentry-adapter failure reported to
// Sentry makes an issue, whose webhook comes back to the hooks service, and
// an identical failure there must not be reported again.
type deduper struct {
	mu     sync.Mutex
	seen   map[string]time.Time
	window time.Duration
	max    int
}

func (d *deduper) allow(key string, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.seen == nil {
		d.seen = map[string]time.Time{}
	}
	if at, ok := d.seen[key]; ok && now.Sub(at) < d.window {
		return false
	}
	if len(d.seen) >= d.max {
		var oldestKey string
		var oldest time.Time
		for k, t := range d.seen {
			if oldestKey == "" || t.Before(oldest) {
				oldestKey, oldest = k, t
			}
		}
		delete(d.seen, oldestKey)
	}
	d.seen[key] = now
	return true
}

func fingerprint(e *sentry.Event) string {
	h := sha256.New()
	io.WriteString(h, string(e.Level))
	io.WriteString(h, "\x00")
	io.WriteString(h, e.Message)
	for _, ex := range e.Exception {
		io.WriteString(h, "\x00")
		io.WriteString(h, ex.Type)
		io.WriteString(h, "\x00")
		io.WriteString(h, ex.Value)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// scrub is BeforeSend: it drops everything that must never reach Sentry and
// redacts credential-shaped text in what is left.
func scrub(e *sentry.Event) *sentry.Event {
	if e == nil {
		return nil
	}
	if e.Request != nil {
		e.Request.Data = ""
		e.Request.Headers = nil
		e.Request.Cookies = ""
		e.Request.Env = nil
		e.Request.QueryString = RedactLine(e.Request.QueryString, 0)
	}
	e.Message = RedactLine(e.Message, 0)
	e.User = sentry.User{}
	for i := range e.Exception {
		e.Exception[i].Type = RedactLine(e.Exception[i].Type, 0)
		e.Exception[i].Value = RedactLine(e.Exception[i].Value, 0)
		scrubStacktrace(e.Exception[i].Stacktrace)
	}
	for i := range e.Threads {
		scrubStacktrace(e.Threads[i].Stacktrace)
	}
	for _, ctx := range e.Contexts {
		for k, v := range ctx {
			ctx[k] = redactField(k, v)
		}
	}
	for k, v := range e.Tags {
		if sensitiveKeyRe.MatchString(k) {
			e.Tags[k] = "[redacted]"
		} else {
			e.Tags[k] = RedactLine(v, 0)
		}
	}
	for _, b := range e.Breadcrumbs {
		if b != nil {
			b.Message = RedactLine(b.Message, 0)
		}
	}
	return e
}

// scrubStacktrace redacts credential-shaped text in a stack trace's source
// context and local variables. Source lines rarely hold a secret, but the
// hooks service handles tokens, and a frame that quotes one must not be the
// one thing that leaks.
func scrubStacktrace(st *sentry.Stacktrace) {
	if st == nil {
		return
	}
	for i := range st.Frames {
		f := &st.Frames[i]
		f.ContextLine = RedactLine(f.ContextLine, 0)
		for j := range f.PreContext {
			f.PreContext[j] = RedactLine(f.PreContext[j], 0)
		}
		for j := range f.PostContext {
			f.PostContext[j] = RedactLine(f.PostContext[j], 0)
		}
		for k, v := range f.Vars {
			f.Vars[k] = redactField(k, v)
		}
	}
}

// RedactLine is the stewards plugin's redactLine (plugins/stewards/ops.ts)
// ported to Go: obvious credentials are replaced and the line is clipped.
// The pattern is deliberately identical so a token that would be redacted in
// a log line is redacted on the way to Sentry too.
var (
	secretRe = regexp.MustCompile(`(?i)((?:authorization|token|secret|password|passwd|api[_-]?key|cookie|set-cookie)["']?\s*[:=]\s*["']?(?:bearer\s+)?|bearer\s+)([^\s"',;]+)`)
	// Signature headers carry the same kind of secret under their own
	// names, which the generic pattern above does not match.
	signatureRe = regexp.MustCompile(`(?i)((?:sentry-hook-signature|linear-signature|x-hub-signature-256)["']?\s*[:=]\s*["']?)([^\s"',;]+)`)
)

// LogLineChars is the default clip length, the same as the stewards plugin's.
const LogLineChars = 400

// RedactLine replaces obvious credentials in line and clips it to max
// characters (LogLineChars when max is not positive).
func RedactLine(line string, max int) string {
	clean := secretRe.ReplaceAllString(line, "${1}[redacted]")
	clean = signatureRe.ReplaceAllString(clean, "${1}[redacted]")
	if max <= 0 {
		max = LogLineChars
	}
	if len(clean) <= max {
		return clean
	}
	return clean[:max] + "…"
}

// sensitiveKeyRe matches a structured field name that names a credential, so
// its value is dropped even when the value itself does not spell out the
// name. redactLine works on whole log lines; a Sentry event has keys and
// values apart.
var sensitiveKeyRe = regexp.MustCompile(`(?i)^(authorization|token|secret|password|passwd|api[_-]?key|cookie|set-cookie|sentry-hook-signature|linear-signature|x-hub-signature-256)$`)

// redactField redacts a value by its field name and by its content.
func redactField(key string, v any) any {
	if sensitiveKeyRe.MatchString(key) {
		return "[redacted]"
	}
	return redactValue(v)
}

func redactValue(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return RedactLine(x, 0)
	case error:
		return RedactLine(x.Error(), 0)
	case fmt.Stringer:
		return RedactLine(x.String(), 0)
	case []string:
		out := make([]string, len(x))
		for i, s := range x {
			out[i] = RedactLine(s, 0)
		}
		return out
	case map[string]string:
		out := make(map[string]string, len(x))
		for k, s := range x {
			out[k] = RedactLine(s, 0)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, s := range x {
			out[k] = redactValue(s)
		}
		return out
	default:
		return x
	}
}
