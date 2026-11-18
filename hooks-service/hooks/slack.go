package hooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"hooks-service/sentryx"
)

// Slack is the one team Slack app. It verifies deliveries to POST /slack,
// routes assistant sessions to the one server whose owner has proved the
// Slack user, and posts replies with the bot token it holds. The app's bot
// token, signing secret and client secret never reach a developer's pod;
// the one Slack credential a pod holds is the developer's own OAuth v2 user
// token, returned by the exchange and presented here to identify (see
// docs/hooks.md, "Slack agent").
//
// It is not an Adapter: it has no leases and no verification fetch, and its
// identity (POST /v1/identify, source "slack") and reply endpoints live
// beside the Linear ones in Server.Subscriber.

const (
	// SlackAPI is the Slack Web API root.
	SlackAPI = "https://slack.com/api"
	// SlackAuthorizeURL is the OAuth v2 authorization endpoint.
	SlackAuthorizeURL = "https://slack.com/oauth/v2/authorize"
	// SlackTokenURL exchanges the authorization code for the user token.
	SlackTokenURL = "https://slack.com/api/oauth.v2.access"
	// SlackSkew is how far a delivery's timestamp may be from now. Slack's
	// own guidance is five minutes.
	SlackSkew = 5 * time.Minute
	// SlackSigninTTL bounds a sign-in flow: state is single use and this is
	// how long it lives whether or not it is completed.
	SlackSigninTTL = 10 * time.Minute
	// slackUserScope is the user scope set the developer's own token is
	// granted: channel lists only, never message access and never email.
	slackUserScope = "channels:read,groups:read"
	// slackChannelsTTL is how long the bot's channel-membership list is
	// cached; the picker only needs it to flag channels bb is not in.
	slackChannelsTTL = 3 * time.Minute
	// slackNameTTL is how long a user's display name read from users.info is
	// cached, so a busy channel does not look the same person up on every
	// message. In memory only, and it holds names only.
	slackNameTTL = 5 * time.Minute
	// maxSlackNameCache caps the in-memory user-name cache.
	maxSlackNameCache = 4096
	// slackResolveTimeout bounds the whole mention resolution for one wake:
	// a lookup that is slow or down falls back to the id rather than
	// delaying the message past this bound.
	slackResolveTimeout = 3 * time.Second
	// slackLookupTimeout bounds one users.info or conversations.info lookup.
	slackLookupTimeout = 2 * time.Second
	// maxSlackChannelPages caps the users.conversations pagination so a
	// misbehaving cursor cannot spin the handler. 50 pages of 200 is far
	// more channels than any workspace has.
	maxSlackChannelPages = 50
	// slackDedupeTTL is how long an event id, or a routed message's
	// channel:ts, is remembered to drop Slack's retries and the second
	// delivery of a tagged reply. In memory only.
	slackDedupeTTL = 10 * time.Minute
	// maxSlackDedupe caps the two in-memory dedupe tables: the event ids
	// remembered for Slack retries and the routed messages remembered by
	// channel:ts. Beyond it each table is swept of lapsed entries.
	maxSlackDedupe = 4096
	// slackMentionGrace is how long an untagged channel message waits for a
	// same-key mention to supersede it before it routes as an untagged
	// follow-up. A tagged message half routes at once and needs no grace; the
	// hold covers the case where the message half arrived before the bot user
	// id was resolved or tagged the bot in a form the parser does not
	// recognize.
	slackMentionGrace = 2 * time.Second
	// maxSlackSessions caps the in-memory route table.
	maxSlackSessions = 10000
	// maxSlackPending caps the untagged channel messages held for the mention
	// grace at once. It is far more than can arrive in a grace window; beyond
	// it a message is routed at once rather than held.
	maxSlackPending = 4096
	// slackSessionKind is the Watch.Kind of a Slack session lease on
	// POST /v1/subscribe.
	slackSessionKind = "session"
	// maxSlackLeases caps the in-memory session lease table.
	maxSlackLeases = 10000
	// slackCapabilityLabel domain-separates the session capability key from
	// the request-signature key. The capability key is
	// HMAC(signingSecret, label), never the signing secret itself.
	slackCapabilityLabel = "hooks-service slack session capability v1"
	// maxSlackSigninFlows caps in-flight sign-in flows.
	maxSlackSigninFlows = 1000
	// slackReplyBody is the largest reply this service will post.
	slackReplyBody = 32 << 10
	// maxSlackEphemeralChannels caps the channels remembered per connection
	// for the ephemeral endpoint, so a misbehaving wake source cannot grow
	// the table without bound.
	maxSlackEphemeralChannels = 256
	// maxSlackUserBindings caps the per-Slack-user last-bound table. In
	// memory only: a restart forgets, and the startup grace covers the
	// reconnecting pods.
	maxSlackUserBindings = 10000
	// maxSlackNotices caps the per-session not-connected dedupe table.
	maxSlackNotices = 4096
	// slackBindWindow is how long after a user was last bound the service
	// says "not connected right now" instead of "not set up yet".
	slackBindWindow = 14 * 24 * time.Hour
	// slackStartupGrace is how long after the service starts every user with
	// no bound connection gets the not-connected reply, while pods reconnect.
	slackStartupGrace = 2 * time.Minute
	// slackNoticeDedupe is how long one session's not-connected notice is
	// remembered, so a person retrying at once gets one reply.
	slackNoticeDedupe = 5 * time.Minute
	// slackAskClassTTL is how long a Slack user's classification (member,
	// guest or stranger) is cached, so a burst of messages from one person
	// makes one users.info call. In memory only.
	slackAskClassTTL = 5 * time.Minute
	// maxSlackAskClasses caps the in-memory classification cache.
	maxSlackAskClasses = 4096
	// slackImageMaxBytes is the largest image the file endpoint forwards:
	// png, jpeg, gif or webp.
	slackImageMaxBytes = 10 << 20
	// slackTextMaxBytes is the largest text-like file the file endpoint
	// forwards: text, csv, json, markdown or code.
	slackTextMaxBytes = 1 << 20
	// maxSlackFileSessions caps the sessions whose routed file ids are
	// remembered for the file endpoint.
	maxSlackFileSessions = 4096
	// maxSlackFilesPerSession caps the file ids remembered per session.
	maxSlackFilesPerSession = 64
	// maxSlackFilePreview caps a snippet preview carried on the wake, so a
	// large snippet cannot inflate a wake.
	maxSlackFilePreview = 2048
	// slackFileFetchTimeout bounds one Slack url_private fetch.
	slackFileFetchTimeout = 20 * time.Second
	// maxSlackHistoryMessages caps the earlier thread messages carried on a
	// session's first wake (BB-162). The oldest beyond it are dropped, with
	// a marker.
	maxSlackHistoryMessages = 50
	// slackHistoryFetchLimit is how many messages the service asks Slack's
	// conversations.replies for per page before clipping to
	// maxSlackHistoryMessages. Slack recommends no more than 200 at a time.
	slackHistoryFetchLimit = 200
	// maxSlackHistoryPages bounds conversations.replies pagination, so a
	// misbehaving cursor cannot spin the lookup; the overall history timeout
	// is the real bound.
	maxSlackHistoryPages = 50
	// slackHistoryTextBudget caps the total text carried in a first wake's
	// history, in bytes. The oldest messages are dropped, with a marker,
	// until it fits.
	slackHistoryTextBudget = 8 << 10
	// slackHistoryTimeout bounds the whole conversations.replies lookup and
	// its name resolution for one wake; each Slack call within it is bounded
	// by slackLookupTimeout. A timeout sends the wake without history.
	slackHistoryTimeout = 3 * time.Second
	// slackHistoryClipMarker is the text of the marker entry prepended to a
	// first wake's history when the oldest messages were dropped to fit
	// maxSlackHistoryMessages or slackHistoryTextBudget.
	slackHistoryClipMarker = "[earlier messages omitted]"
	// slackUserListTTL is how long the workspace user list read with
	// users.list is cached, so a burst of conversation opens makes one call.
	// In memory only, and it holds names only.
	slackUserListTTL = 3 * time.Minute
	// maxSlackUserPages caps users.list pagination, so a misbehaving cursor
	// cannot spin the handler.
	maxSlackUserPages = 50
	// maxSlackConversationUsers caps the users one conversations.open
	// accepts. Slack allows up to 8 in a group DM.
	maxSlackConversationUsers = 8
	// maxSlackCandidates caps the near matches an unknown conversation
	// opener's user entry carries, so the plugin can offer a short list.
	maxSlackCandidates = 5
)

// SlackWake is what the chosen server's stream receives as `event: session`
// for source "slack". It follows the Linear session wake shape: the plugin
// switches on source and reads session, action and comment. It never
// carries a token.
type SlackWake struct {
	Source  string `json:"source"`
	Session string `json:"session"`
	Action  string `json:"action"`
	// Mention is true when the wake came from a channel app_mention or a
	// channel message that tags the bot, rather than a DM or assistant-thread
	// event. The plugin uses it to tell a channel conversation from a DM.
	Mention bool `json:"mention"`
	// Tagged is true when the message addressed bb directly: a DM, a channel
	// app_mention, or a channel message that tags the bot. It is false for an
	// untagged follow-up in a channel thread bb is already part of, which does
	// not oblige a reply.
	Tagged bool `json:"tagged"`
	// Opened is true when the wake is a message in a conversation bb opened
	// with POST /v1/slack/conversations, rather than one that woke the thread.
	// The plugin frames these as the next message in a conversation it
	// started; it is omitted when false, so an ordinary wake is unchanged.
	Opened  bool   `json:"opened,omitempty"`
	Channel string `json:"channel"`
	// ContextChannel is the channel the user was viewing when an assistant
	// thread's context changed; empty on every other wake. The assistant
	// thread itself lives in the DM named by Channel, so this is the only
	// place the viewed channel appears.
	ContextChannel string      `json:"contextChannel,omitempty"`
	Thread         string      `json:"thread"`
	Asker          Person      `json:"asker"`
	Owner          Person      `json:"owner"`
	FromOwner      bool        `json:"fromOwner"`
	RoutedAs       string      `json:"routedAs"`
	Comment        WakeComment `json:"comment"`
	// TS is the message's own Slack timestamp, the key the plugin matches an
	// edit or deletion to the wake it delivered. It is empty (and omitted) on
	// wakes that are not a message.
	TS string `json:"ts,omitempty"`
	// Mentions is every user mention resolved in Comment.Text, in order of
	// appearance and deduplicated, so a reply can write <@id>. Omitted when
	// there are none, so a wake with no mentions is byte-identical to
	// before this field existed.
	Mentions []SlackMention `json:"mentions,omitempty"`
	// Files names the message's attachments, metadata only, so the plugin can
	// say what was not forwarded. It is omitted when there are none, so a wake
	// without files is byte-identical to before this field existed.
	Files []SlackFile `json:"files,omitempty"`
	// History is the thread's earlier messages on the first wake of a
	// session (BB-162), oldest first, with Slack's control sequences
	// resolved. It is omitted when there is none, so an ordinary wake is
	// byte-identical. The file ids it names are metadata only and are never
	// remembered for the file endpoint, so its bytes cannot be served.
	History []SlackHistoryMessage `json:"history,omitempty"`
	At      time.Time             `json:"at"`
	// ActionID and Value are the clicked Block Kit action on a block_action
	// wake; empty on every other wake.
	ActionID string `json:"actionId,omitempty"`
	Value    string `json:"value,omitempty"`
	// ResponseURL is the capability Slack hands the app to replace the
	// ephemeral message a block_action came from. It is a secret-like
	// capability: it reaches the routed pod on the stream and is never
	// logged. Empty on every other wake.
	ResponseURL string `json:"responseUrl,omitempty"`
	// Capability is the opaque proof that the session belongs to Owner: an
	// HMAC over "session|user" keyed by a value derived from the signing
	// secret. The plugin stores it and echoes it on POST /v1/subscribe to
	// lease the session; it is never logged. Empty when Session is empty.
	Capability string `json:"capability,omitempty"`
}

// SlackMention is one user mention resolved in a wake's text: the Slack user
// id and the name it was rendered as. The plugin uses the id to write a real
// <@U…> in a reply.
type SlackMention struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SlackFile is one attachment named on a wake: its Slack file id, a display
// name (the file's name, falling back to its title), and its mime type and
// size in bytes. Metadata only. Filetype and Preview are additive and let the
// plugin decide without a fetch; the endpoint that serves the bytes uses the
// unexported urlPrivate, which never crosses a wake.
type SlackFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	// Filetype is Slack's short type label ("png", "python", …). Omitted
	// when Slack sent none, so a wake without one is unchanged.
	Filetype string `json:"filetype,omitempty"`
	// Preview is a snippet's short text, which the plugin may inline without
	// a fetch. Omitted when there is none.
	Preview string `json:"preview,omitempty"`
	// urlPrivate is the authenticated download URL Slack sent. It is kept in
	// memory only: never marshaled onto a wake, never logged, and used by the
	// file endpoint to stream the bytes.
	urlPrivate string
}

// SlackHistoryUser is who posted one earlier message in a first wake's
// thread history: the Slack user id and the display name it was rendered as.
// The app's own posts are named "bb". A clip marker carries an empty user.
type SlackHistoryUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SlackHistoryMessage is one earlier message in a first wake's thread
// history (BB-162). TS is the message's Slack timestamp, User is who posted
// it, Text is the message text with Slack's control sequences resolved
// exactly as comment.text, and Files is the message's attachments, metadata
// only. The file ids here are not remembered for the file endpoint, so its
// bytes cannot be served. A clip marker — the oldest messages were dropped
// to fit maxSlackHistoryMessages or slackHistoryTextBudget — is an entry
// with an empty User whose Text is slackHistoryClipMarker.
type SlackHistoryMessage struct {
	TS    string           `json:"ts"`
	User  SlackHistoryUser `json:"user"`
	Text  string           `json:"text"`
	Files []SlackFile      `json:"files,omitempty"`
}

// slackFileRef is one file id remembered for a session: the url_private the
// file endpoint fetches it from, and the metadata it enforces limits with.
// In memory only, and never logged.
type slackFileRef struct {
	url      string
	mimeType string
	filetype string
	size     int64
	expires  time.Time
}

// slackNameCacheEntry is one cached user display name with its expiry.
// The cache holds names only.
type slackNameCacheEntry struct {
	name    string
	expires time.Time
}

// slackAskClass is what a Slack asker is, read with users.info before the
// no-server reply. A guest or Slack Connect stranger can never bind a
// server, so the service does not tell them to set one up.
type slackAskClass int

const (
	// slackAskMember is a non-guest member of the app's workspace.
	slackAskMember slackAskClass = iota
	// slackAskGuest is a workspace guest (is_restricted or
	// is_ultra_restricted); it cannot bind a server.
	slackAskGuest
	// slackAskStranger is a Slack Connect external user, a bot or app user,
	// or a user whose team is not the app's.
	slackAskStranger
)

// slackAskClassEntry is one cached classification with its expiry.
type slackAskClassEntry struct {
	class   slackAskClass
	expires time.Time
}

// SlackSigninFlow is one "Sign in with Slack" flow: the connection that
// started it, the PKCE verifier this service holds, and whether the state
// has been consumed. The state is single use and expires after
// SlackSigninTTL; the token is returned in the exchange response and never
// stored.
type SlackSigninFlow struct {
	Connection string
	Verifier   string
	Expires    time.Time
	Used       bool
}

type slackRoute struct {
	user    string
	expires time.Time
}

// slackUserBinding is when a Slack user was last seen and when a connection
// was last bound for them. In memory only; a restart forgets it, and the
// startup grace covers the gap.
type slackUserBinding struct {
	lastBoundAt time.Time
	lastSeenAt  time.Time
}

// slackLease is one session's owner of record, admitted by POST /v1/subscribe
// with the capability the wake carried. It is bound to the connection that
// admitted it: closing the stream forgets it.
type slackLease struct {
	user    string
	conn    string
	expires time.Time
}

// slackPending is the message.channels half of a possible tagged reply that
// did not itself tag the bot, held for the mention grace so a same-key
// app_mention can supersede it.
type slackPending struct {
	ev    slackRouted
	timer *time.Timer
}

// Slack is the team app's service-side state and handlers.
type Slack struct {
	Registry *Registry
	// SigningSecret signs deliveries; SigningSecretFile, when set, is read
	// on every use instead (a mounted Secret, so a rotation needs no
	// restart). Empty disables the adapter.
	SigningSecret     []byte
	SigningSecretFile string
	// BotToken posts as the app. BotTokenFile is read on every use.
	BotToken     []byte
	BotTokenFile string
	// ClientID and ClientSecret are the app's OAuth client id and secret.
	// The secret is read from ClientSecretFile on every use when set.
	ClientID         string
	ClientSecret     []byte
	ClientSecretFile string
	// RedirectURL is the registered OAuth redirect URI. It is the
	// plugin's callback on the developer's own server, behind tsjwt, so the
	// code reaches the server of whoever completed sign-in and only that
	// server can exchange it. It has no built-in default: the deployment
	// sets -slack-redirect-url.
	RedirectURL string
	// PublicBaseURL is the public base URL of a developer's bb server, the
	// host a Slack user visits to create one. It is used only in the set-up
	// replies (noServerText/noServerBlocks, notConnectedBlocks) and has no
	// built-in default: the deployment sets -public-base-url. A trailing
	// slash is ignored.
	PublicBaseURL string
	// TeamID and AppID gate events: only deliveries for this workspace and
	// app are accepted. When empty they are discovered once from the bot
	// token (auth.test and bots.info) and cached, so the operator need not
	// paste them.
	TeamID string
	AppID  string
	// BotUserID is the app's own bot user id (U…). resolveSlackText uses it
	// to recognize the app's own mention in a message's text. It is
	// discovered from the bot token's auth.test like TeamID and AppID, and
	// never pasted by the operator.
	BotUserID string
	// API is the Slack Web API root; SlackAPI when empty.
	API string
	// AuthorizeURL and TokenURL default to Slack's endpoints; overridable
	// for tests.
	AuthorizeURL string
	TokenURL     string
	HTTP         *http.Client
	Logger       *slog.Logger
	Now          func() time.Time

	mu     sync.Mutex
	seen   map[string]time.Time
	routed map[string]slackRoute
	// messages remembers a routed message by channel:ts so the two
	// deliveries of one tagged reply (app_mention and message.channels) yield
	// one wake. In memory only.
	messages map[string]time.Time
	// pending holds the message.channels half of a possible tagged reply for
	// the mention grace, so an app_mention with the same channel:ts
	// supersedes it. In memory only.
	pending map[string]*slackPending
	// leases is the session lease table: a session's owner of record,
	// established by POST /v1/subscribe with the capability the wake
	// carried. It is checked before the routed bootstrap table. In memory
	// only, like every lease.
	leases map[string]slackLease
	// opened records the conversations bb opened with POST
	// /v1/slack/conversations, keyed by session, so a reply can be routed to
	// it and its wake marked opened. openedByChannel indexes the live ones per
	// channel for the top-level im/mpim rule (sessions.go). In memory only.
	opened          map[string]slackOpened
	openedByChannel map[string]map[string]time.Time
	// members is the workspace user list read with users.list, cached for
	// slackUserListTTL, for resolving a conversation opener's names. In memory
	// only; it holds names only.
	members        []slackUserEntry
	membersExpires time.Time
	flows          map[string]*SlackSigninFlow
	resolving      bool
	// ephemeralChannels remembers, per connection, the channels a wake was
	// delivered to it for, so the ephemeral endpoint can post only where
	// this service already spoke. In memory only.
	ephemeralChannels map[string]map[string]time.Time
	// fileRefs remembers, per session, the file ids a routed wake carried and
	// the url_private to fetch each with, so the file endpoint refuses any id
	// not seen on a wake routed to that session. In memory only; it holds no
	// bytes and is never logged.
	fileRefs map[string]map[string]slackFileRef
	// channels is the bot's channel-membership list, cached for
	// slackChannelsTTL so the picker's flag lookup is cheap.
	channels        []string
	channelsExpires time.Time
	// names is the per-user display-name cache, keyed by Slack user id and
	// held for slackNameTTL. In memory only; it holds names only.
	names map[string]slackNameCacheEntry
	// askClasses caches each Slack user's classification for
	// slackAskClassTTL, so a burst of messages from one person makes one
	// users.info call. In memory only.
	askClasses map[string]slackAskClassEntry
	// mentionGrace is how long an untagged channel message waits for the
	// app_mention half of the same message before it is routed as an untagged
	// follow-up; slackMentionGrace when zero.
	mentionGrace time.Duration
	// historyTimeout overrides slackHistoryTimeout in tests; zero uses the
	// default.
	historyTimeout time.Duration
	// window, grace and dedupe override the not-connected reply's defaults:
	// how long after a user was last bound to keep saying "not connected",
	// the grace after start during which everyone gets it, and how long one
	// session's notice is deduped. Zero uses the defaults; tests shorten
	// them.
	window time.Duration
	grace  time.Duration
	dedupe time.Duration
	// bindings remembers, per Slack user id, when a connection was last
	// bound for them and when they were last seen, so a server that later
	// drops is told it is not connected rather than not set up. In memory
	// only.
	bindings map[string]slackUserBinding
	// notices remembers when a session was last sent the not-connected
	// notice, so a person retrying at once gets one reply. In memory only.
	notices map[string]time.Time
	// startedAt is when the service started; the startup grace runs from it.
	startedAt time.Time
	// droppedChannelMessages and droppedDuplicates are aggregate counters
	// only: a dropped message's text and user id are never logged or kept.
	// A duplicate's channel id is logged, never its text or user id.
	droppedChannelMessages atomic.Uint64
	droppedDuplicates      atomic.Uint64
}

func (s *Slack) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Slack) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func (s *Slack) httpClient() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return http.DefaultClient
}

func (s *Slack) api() string {
	if s.API != "" {
		return s.API
	}
	return SlackAPI
}

func (s *Slack) authorizeURL() string {
	if s.AuthorizeURL != "" {
		return s.AuthorizeURL
	}
	return SlackAuthorizeURL
}

func (s *Slack) tokenURL() string {
	if s.TokenURL != "" {
		return s.TokenURL
	}
	return SlackTokenURL
}

func readSecret(inline []byte, file string) []byte {
	if file == "" {
		return inline
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	return bytes.TrimSpace(b)
}

func (s *Slack) signingSecret() []byte {
	return readSecret(s.SigningSecret, s.SigningSecretFile)
}

func (s *Slack) botToken() []byte {
	return readSecret(s.BotToken, s.BotTokenFile)
}

func (s *Slack) clientSecret() string {
	return strings.TrimSpace(string(readSecret(s.ClientSecret, s.ClientSecretFile)))
}

// Enabled is false until the signing secret is configured.
func (s *Slack) Enabled() bool { return s != nil && len(s.signingSecret()) > 0 }

// signinEnabled is false until the OAuth client credentials are configured.
func (s *Slack) signinEnabled() bool {
	return s != nil && s.Enabled() && s.ClientID != "" && s.clientSecret() != ""
}

// Sign computes the Slack request signature for a timestamp and body:
// "v0=" plus the hex HMAC-SHA256 of "v0:<timestamp>:<body>". Exported for
// tests and tooling.
func (s *Slack) Sign(ts string, body []byte) string {
	return "v0=" + hex.EncodeToString(s.signSum(ts, body))
}

// signSum is the raw HMAC, so a verification compares bytes directly rather
// than decoding its own hex back.
func (s *Slack) signSum(ts string, body []byte) []byte {
	m := hmac.New(sha256.New, s.signingSecret())
	m.Write([]byte("v0:" + ts + ":"))
	m.Write(body)
	return m.Sum(nil)
}

// verify checks the signing secret, the timestamp window and the
// constant-time signature compare. Any failure is ErrUnauthorized.
func (s *Slack) verify(r *http.Request, body []byte) error {
	ts := strings.TrimSpace(r.Header.Get("X-Slack-Request-Timestamp"))
	sig := strings.TrimSpace(r.Header.Get("X-Slack-Signature"))
	if ts == "" || sig == "" {
		return ErrUnauthorized
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ErrUnauthorized
	}
	if d := s.now().Sub(time.Unix(sec, 0)); d > SlackSkew || d < -SlackSkew {
		return ErrUnauthorized
	}
	got, err := hex.DecodeString(strings.TrimPrefix(sig, "v0="))
	if err != nil || len(got) == 0 {
		return ErrUnauthorized
	}
	if !hmac.Equal(got, s.signSum(ts, body)) {
		return ErrUnauthorized
	}
	return nil
}

// slackEnvelope is the outer shape of every Events API delivery.
type slackEnvelope struct {
	Type      string          `json:"type"`
	Challenge string          `json:"challenge"`
	TeamID    string          `json:"team_id"`
	AppID     string          `json:"api_app_id"`
	EventID   string          `json:"event_id"`
	EventTime int64           `json:"event_time"`
	Event     json.RawMessage `json:"event"`
}

// slackFile is one attachment on a Slack message. Only its metadata is read;
// the bytes are never fetched. A snippet carries Title where a plain upload
// carries Name.
type slackFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Mimetype string `json:"mimetype"`
	Size     int64  `json:"size"`
	// Filetype is Slack's short type label ("png", "python", …). Preview
	// and PlainText carry a snippet's short and full text; URLPrivate is the
	// authenticated URL the file endpoint fetches with the bot token. None
	// of these is fetched while parsing a wake.
	Filetype   string `json:"filetype"`
	Preview    string `json:"preview"`
	PlainText  string `json:"plain_text"`
	URLPrivate string `json:"url_private"`
}

// slackEventMessage is the inner message object Slack sends on a
// message_changed or message_deleted subtype. Only the fields the adapter
// reads are named: the message's own ts, its text, the author, the bot or app
// that posted it, the thread root a threaded message carries, and the
// attachments compared to tell a metadata-only edit from a real one.
type slackEventMessage struct {
	User     string `json:"user"`
	BotID    string `json:"bot_id"`
	AppID    string `json:"app_id"`
	TS       string `json:"ts"`
	ThreadTS string `json:"thread_ts"`
	Text     string `json:"text"`
	// Files are the message's attachments, read for metadata only. They are
	// compared between a message_changed's message and previous_message so a
	// reply-count update with the same text and files is not routed as an edit.
	Files []slackFile `json:"files"`
}

// slackEvent is the inner event the adapter reads.
type slackEvent struct {
	Type        string `json:"type"`
	Subtype     string `json:"subtype"`
	User        string `json:"user"`
	BotID       string `json:"bot_id"`
	AppID       string `json:"app_id"`
	Channel     string `json:"channel"`
	ChannelType string `json:"channel_type"`
	TS          string `json:"ts"`
	ThreadTS    string `json:"thread_ts"`
	Text        string `json:"text"`
	// Files are the message's attachments, read for metadata only. Slack sends
	// a name or a title, plus the mime type and size; nothing is fetched.
	Files []slackFile `json:"files"`
	// Message and PreviousMessage are the inner message objects on a
	// message_changed or message_deleted subtype: the new (or previous)
	// message's own fields. Slack puts the edited message and its ts under
	// Message, and the pre-edit or deleted message under PreviousMessage.
	Message         *slackEventMessage `json:"message"`
	PreviousMessage *slackEventMessage `json:"previous_message"`
	// DeletedTS is the ts of the message a message_deleted subtype removed;
	// Slack sends it at the top level, not on the inner message.
	DeletedTS string `json:"deleted_ts"`

	AssistantThread *struct {
		UserID    string `json:"user_id"`
		ChannelID string `json:"channel_id"`
		ThreadTS  string `json:"thread_ts"`
		Context   *struct {
			ChannelID string `json:"channel_id"`
		} `json:"context"`
	} `json:"assistant_thread"`
}

// slackRouted is the normalized event routed to a pod.
type slackRouted struct {
	Session string
	Action  string
	Mention bool
	// Tagged is true when the message addressed bb directly (a DM, an
	// app_mention or a channel message that tags the bot) and false for an
	// untagged channel/group follow-up.
	Tagged bool
	// Key is channel:ts for a message delivery: the key the two halves of a
	// tagged reply share. It is empty on events that cannot be duplicated.
	Key     string
	Channel string
	// ContextChannel is the channel the user was viewing on an assistant
	// context change; empty on every other event.
	ContextChannel string
	Thread         string
	User           string
	Text           string
	// TS is the message's own Slack ts, the key the plugin matches an edit or
	// deletion to the wake it delivered. Empty on events that are not a
	// message.
	TS string
	// Files names the message's attachments for the wake. Metadata only.
	Files []SlackFile
	At    time.Time
	// ActionID, Value and ResponseURL carry the clicked Block Kit action and
	// Slack's response_url on a block_action wake.
	ActionID    string
	Value       string
	ResponseURL string
	// Silent drops the wake without posting the no-server or not-reading
	// reply. block_action uses it: there is no conversation to post a reply
	// into.
	Silent bool
}

// HandleWebhook is POST /slack on the public listener. It verifies the
// delivery, answers url_verification, acks every accepted event, and only
// then routes it: the 200 never waits for a pod or a Slack API call.
func (s *Slack) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.verify(r, body); err != nil {
		s.logger().Warn("slack webhook refused", "status", 401, "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var env slackEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch env.Type {
	case "url_verification":
		if env.Challenge == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, env.Challenge)
		return
	case "event_callback":
		if env.EventID == "" || env.TeamID == "" || env.AppID == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		team, app := s.resolved()
		if team == "" || app == "" {
			// The bot token is not sealed yet, or Slack is unreachable, so
			// the workspace cannot be checked. Resolve in the background and
			// answer 503 at once: the ack must not wait on discovery, and
			// Slack retries.
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := s.Resolve(ctx); err != nil {
					s.logger().Warn("slack workspace not resolved", "err", err)
				}
			}()
			s.logger().Warn("slack event dropped: workspace not configured")
			http.Error(w, "not configured", http.StatusServiceUnavailable)
			return
		}
		if env.TeamID != team || env.AppID != app {
			s.logger().Warn("slack event dropped: wrong workspace or app", "team", env.TeamID, "app", env.AppID)
			w.WriteHeader(http.StatusOK)
			return
		}
		if !s.accept(env.EventID) {
			// A Slack retry, or a duplicate delivery.
			typ, subtype, channelType, channel := slackEventFields(&env)
			n := s.droppedDuplicates.Add(1)
			s.logger().Info("slack event dropped: duplicate",
				"eventId", env.EventID, "type", typ, "subtype", subtype,
				"channelType", channelType, "channel", channel, "dropped", n)
			w.WriteHeader(http.StatusOK)
			return
		}
		if ev, ok := s.parseSlackEvent(&env, s.now(), s.sessionLive, s.resolvedBot()); ok {
			s.deliver(ev)
		} else {
			s.countDropped(&env)
		}
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusOK)
	}
}

// accept records an event id and reports whether it is new. In memory only,
// so a restart forgets and a Slack retry after one is processed again; the
// wake is idempotent at the plugin.
func (s *Slack) accept(id string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		s.seen = map[string]time.Time{}
	}
	if exp, ok := s.seen[id]; ok && exp.After(now) {
		return false
	}
	if len(s.seen) > maxSlackDedupe {
		for k, exp := range s.seen {
			if !exp.After(now) {
				delete(s.seen, k)
			}
		}
	}
	s.seen[id] = now.Add(slackDedupeTTL)
	return true
}

// countDropped records an accepted delivery that was not routed, as an
// aggregate count only: the message's text, user and channel are never logged
// or kept. It is how the new message.channels/message.groups traffic, most of
// which is not for bb, stays observable without retaining anything.
func (s *Slack) countDropped(env *slackEnvelope) {
	var ev slackEvent
	if err := json.Unmarshal(env.Event, &ev); err != nil {
		return
	}
	if ev.Type == "message" && (ev.ChannelType == "channel" || ev.ChannelType == "group") {
		n := s.droppedChannelMessages.Add(1)
		s.logger().Debug("slack channel message dropped", "dropped", n)
	}
}

// slackEventFields reads the type, subtype, channel type and channel id from
// an envelope's event for a drop log line. It returns empty strings when the
// event cannot be read, so a malformed delivery is still logged.
func slackEventFields(env *slackEnvelope) (typ, subtype, channelType, channel string) {
	var ev slackEvent
	if err := json.Unmarshal(env.Event, &ev); err != nil {
		return "", "", "", ""
	}
	return ev.Type, ev.Subtype, ev.ChannelType, ev.Channel
}

// deliver routes a parsed event after deduplicating the two deliveries of one
// tagged reply. Slack sends a channel reply that tags bb twice, once as an
// app_mention and once as a message.channels (or message.groups), with
// different event ids but the same channel and message ts. A tagged delivery
// routes at once and remembers the key, so the other half is dropped as a
// duplicate; an untagged message with a key is held for the mention grace so a
// same-key mention can still supersede it (the message half arrived before the
// bot user id was resolved, or tagged the bot in a form the parser does not
// recognize), and a mention cancels a held message and wins. A second delivery
// of a key already routed is dropped. Every other event routes at once.
func (s *Slack) deliver(ev slackRouted) {
	if ev.Key == "" {
		go s.route(ev)
		return
	}
	now := s.now()
	if ev.Tagged {
		s.mu.Lock()
		if exp, ok := s.messages[ev.Key]; ok && exp.After(now) {
			s.mu.Unlock()
			s.logSlackDuplicate(ev)
			return
		}
		if p := s.pending[ev.Key]; p != nil {
			p.timer.Stop()
			delete(s.pending, ev.Key)
		}
		s.rememberMessageLocked(ev.Key, now)
		s.mu.Unlock()
		go s.route(ev)
		return
	}
	s.mu.Lock()
	if exp, ok := s.messages[ev.Key]; ok && exp.After(now) {
		s.mu.Unlock()
		s.logSlackDuplicate(ev)
		return
	}
	if _, ok := s.pending[ev.Key]; ok {
		// A second untagged delivery of a message already held: keep the
		// first and drop this one.
		s.mu.Unlock()
		s.logSlackDuplicate(ev)
		return
	}
	if len(s.pending) >= maxSlackPending {
		// Too many messages in flight to hold this one: route it now as the
		// untagged fallback rather than growing the table. It is not recorded
		// in messages, so only accept's event-id dedupe guards a Slack retry
		// of it, which is enough because a retry reuses the event id.
		s.mu.Unlock()
		go s.route(ev)
		return
	}
	if s.pending == nil {
		s.pending = map[string]*slackPending{}
	}
	p := &slackPending{ev: ev}
	p.timer = time.AfterFunc(s.mentionGraceWindow(), func() { s.flushPending(ev.Key, p) })
	s.pending[ev.Key] = p
	s.mu.Unlock()
}

// logSlackDuplicate records one dropped duplicate delivery with the running
// count. It names the session, action and channel id, never the text or the
// user id. It is safe to call without s.mu: the counter is atomic.
func (s *Slack) logSlackDuplicate(ev slackRouted) {
	n := s.droppedDuplicates.Add(1)
	s.logger().Info("slack event dropped: duplicate",
		"session", ev.Session, "action", ev.Action, "channel", ev.Channel, "dropped", n)
}

// flushPending routes a held untagged message once the mention grace has
// passed without an app_mention for the same message. It is a no-op when the
// pending entry was superseded or is gone.
func (s *Slack) flushPending(key string, p *slackPending) {
	now := s.now()
	s.mu.Lock()
	if s.pending[key] != p {
		s.mu.Unlock()
		return
	}
	delete(s.pending, key)
	s.rememberMessageLocked(key, now)
	s.mu.Unlock()
	s.route(p.ev)
}

// rememberMessageLocked records a routed message key with its TTL, sweeping
// lapsed entries when the table is full. Caller holds s.mu.
func (s *Slack) rememberMessageLocked(key string, now time.Time) {
	if s.messages == nil {
		s.messages = map[string]time.Time{}
	}
	if len(s.messages) > maxSlackDedupe {
		for k, exp := range s.messages {
			if !exp.After(now) {
				delete(s.messages, k)
			}
		}
	}
	s.messages[key] = now.Add(slackDedupeTTL)
}

// mentionGraceWindow is the configured mention grace, or the default.
func (s *Slack) mentionGraceWindow() time.Duration {
	if s.mentionGrace > 0 {
		return s.mentionGrace
	}
	return slackMentionGrace
}

// historyWindow is the configured first-wake history lookup bound, or the
// default.
func (s *Slack) historyWindow() time.Duration {
	if s.historyTimeout > 0 {
		return s.historyTimeout
	}
	return slackHistoryTimeout
}

// sessionLive reports whether session has a live lease or a live route entry:
// bb is part of that thread, so an untagged reply in it is delivered. The
// lease table is the owner of record; the route table is the bootstrap
// fallback for a session the plugin has not leased yet.
func (s *Slack) sessionLive(session string) bool {
	if _, ok := s.leaseOwner(session); ok {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.routed[session]
	return ok && r.expires.After(s.now())
}

// logSlackDropped records one rejected delivery at info with the reason it
// was dropped. It names only the event's type, subtype and channel type:
// never the message text or the user id.
func (s *Slack) logSlackDropped(ev *slackEvent, reason string) {
	typ, subtype, channelType := "", "", ""
	if ev != nil {
		typ, subtype, channelType = ev.Type, ev.Subtype, ev.ChannelType
	}
	s.logger().Info("slack event dropped",
		"type", typ, "subtype", subtype, "channelType", channelType, "reason", reason)
}

// parseSlackEvent normalizes the events the adapter routes: a DM message, a
// channel app_mention, a channel message that tags the bot, an untagged reply
// inside a channel thread bb is already part of, and the assistant-thread
// events. Bots, the app's own messages, edits and every other subtype are
// dropped; a file_share message (a pasted screenshot or an upload, with or
// without text) is kept, because it is the one carrying the files Step 1
// names. live reports whether a session has a live lease or route: an
// untagged channel/group message is kept only when its thread is one bb is
// part of. botUser is the app's own bot user id, used to recognize a channel
// message that tags bb; empty never matches. Every rejected delivery is
// logged at info with the reason, never the text or the user id.
func (s *Slack) parseSlackEvent(env *slackEnvelope, now time.Time, live func(string) bool, botUser string) (slackRouted, bool) {
	var ev slackEvent
	if err := json.Unmarshal(env.Event, &ev); err != nil {
		s.logSlackDropped(nil, "missing-fields")
		return slackRouted{}, false
	}
	at := now
	if env.EventTime > 0 {
		at = time.Unix(env.EventTime, 0)
	}
	switch ev.Type {
	case "message":
		if ev.Subtype == "message_changed" || ev.Subtype == "message_deleted" {
			// An edit or deletion of a DM or group DM. A channel-thread
			// correction is still dropped.
			if ev.ChannelType != "im" && ev.ChannelType != "mpim" {
				s.logSlackDropped(&ev, "dropped-subtype")
				return slackRouted{}, false
			}
			return s.parseSlackMessageCorrection(ev, at)
		}
		if ev.BotID != "" || ev.AppID != "" {
			s.logSlackDropped(&ev, "bot-author")
			return slackRouted{}, false
		}
		if !slackKeptSubtype(ev.Subtype) {
			s.logSlackDropped(&ev, "dropped-subtype")
			return slackRouted{}, false
		}
		if ev.User == "" || ev.Channel == "" {
			s.logSlackDropped(&ev, "missing-fields")
			return slackRouted{}, false
		}
		switch ev.ChannelType {
		case "im", "mpim":
			return s.parseSlackDirectMessage(ev, at)
		case "channel", "group":
			// A message that visibly tags the bot routes as a mention even
			// when its thread has no live lease or route: Slack may deliver
			// only the message.channels (or message.groups) half and never
			// the app_mention, so dropping it would lose the mention
			// (BB-157). It uses the same session and channel:ts key as the
			// app_mention half, so whichever delivery arrives first routes
			// and the other is deduplicated. A top-level message that tags
			// the bot gets the same treatment.
			if ev.TS != "" && slackTagsBot(ev.Text, botUser) {
				thread := ev.ThreadTS
				if thread == "" {
					thread = ev.TS
				}
				return slackRouted{Session: slackSession(ev.Channel, thread), Action: "message", Mention: true, Tagged: true, Key: ev.Channel + ":" + ev.TS, Channel: ev.Channel, Thread: thread, User: ev.User, Text: ev.Text, TS: ev.TS, Files: slackFiles(ev.Files), At: at}, true
			}
			// An untagged reply inside a thread bb is already part of. A
			// top-level message, or one in a thread with no live lease or
			// route, is dropped: the app is in every channel it was added to,
			// and this is most of what arrives. The message's own ts keys the
			// dedupe of the two deliveries of a tagged reply.
			if ev.ThreadTS == "" || ev.TS == "" {
				s.logSlackDropped(&ev, "missing-fields")
				return slackRouted{}, false
			}
			session := slackSession(ev.Channel, ev.ThreadTS)
			if live == nil || !live(session) {
				s.logSlackDropped(&ev, "not-live-session")
				return slackRouted{}, false
			}
			return slackRouted{Session: session, Action: "message", Key: ev.Channel + ":" + ev.TS, Channel: ev.Channel, Thread: ev.ThreadTS, User: ev.User, Text: ev.Text, TS: ev.TS, Files: slackFiles(ev.Files), At: at}, true
		default:
			s.logSlackDropped(&ev, "unhandled-type")
			return slackRouted{}, false
		}
	case "app_mention":
		// A mention in a channel. It routes to the asker's server exactly as
		// a DM does; Mention tells the plugin this is a channel conversation
		// (its channel id is a C/G id, not a D id) so it can consult its
		// channel map and treat the text as public.
		if ev.BotID != "" || ev.AppID != "" {
			s.logSlackDropped(&ev, "bot-author")
			return slackRouted{}, false
		}
		if !slackKeptSubtype(ev.Subtype) {
			s.logSlackDropped(&ev, "dropped-subtype")
			return slackRouted{}, false
		}
		if ev.User == "" || ev.Channel == "" || ev.TS == "" {
			s.logSlackDropped(&ev, "missing-fields")
			return slackRouted{}, false
		}
		thread := ev.ThreadTS
		if thread == "" {
			thread = ev.TS
		}
		return slackRouted{Session: slackSession(ev.Channel, thread), Action: "message", Mention: true, Tagged: true, Key: ev.Channel + ":" + ev.TS, Channel: ev.Channel, Thread: thread, User: ev.User, Text: ev.Text, TS: ev.TS, Files: slackFiles(ev.Files), At: at}, true
	case "assistant_thread_started", "assistant_thread_context_changed":
		t := ev.AssistantThread
		if t == nil || t.UserID == "" || t.ChannelID == "" || t.ThreadTS == "" {
			s.logSlackDropped(&ev, "missing-fields")
			return slackRouted{}, false
		}
		context := ""
		if t.Context != nil {
			context = t.Context.ChannelID
		}
		return slackRouted{Session: slackSession(t.ChannelID, t.ThreadTS), Action: ev.Type, Tagged: true, Channel: t.ChannelID, ContextChannel: context, Thread: t.ThreadTS, User: t.UserID, At: at}, true
	default:
		s.logSlackDropped(&ev, "unhandled-type")
		return slackRouted{}, false
	}
}

// parseSlackDirectMessage normalizes a message in a 1:1 DM (im) or a group
// DM (mpim). It routes to the opened conversation when the channel has one,
// and otherwise to today's session for the message. A message in a bb-opened
// session is untagged: it continues a conversation bb started and owes no
// reply.
func (s *Slack) parseSlackDirectMessage(ev slackEvent, at time.Time) (slackRouted, bool) {
	if ev.TS == "" {
		s.logSlackDropped(&ev, "missing-fields")
		return slackRouted{}, false
	}
	session, thread := s.directSession(ev.Channel, ev.ChannelType, ev.User, ev.ThreadTS, ev.TS)
	return slackRouted{Session: session, Action: "message", Tagged: !s.isOpened(session), Channel: ev.Channel, Thread: thread, User: ev.User, Text: ev.Text, TS: ev.TS, Files: slackFiles(ev.Files), At: at}, true
}

// directSession resolves the session key and thread root for a message in a
// 1:1 DM (im) or a group DM (mpim). A threaded message continues the thread
// it names, so a reply in the opener's thread of a conversation bb opened
// routes to that session. A top-level message in a channel with exactly one
// live bb-opened lease continues that conversation too; for im only when the
// sender has no bb connection of their own, because a connected person's own
// DM must reach their own server. Otherwise today's routing applies: the
// message is its own session, keyed by its ts.
func (s *Slack) directSession(channel, channelType, user, threadTS, ts string) (session, thread string) {
	if threadTS != "" {
		return slackSession(channel, threadTS), threadTS
	}
	if opened, ok := s.openedLeaseForChannel(channel); ok {
		var own *Conn
		if s.Registry != nil {
			own, _ = s.Registry.ByUser("slack", user)
		}
		if channelType != "im" || own == nil {
			if _, t, ok := splitSlackSession(opened); ok {
				return opened, t
			}
		}
	}
	return slackSession(channel, ts), ts
}

// parseSlackMessageCorrection normalizes a message_changed or message_deleted
// event: an edit or deletion of a DM the adapter may have woken the session
// for. It routes to the same session as the original message, keyed on the
// original message's ts (the inner message's own ts for an edit, deleted_ts
// for a deletion) and carrying the new text on an edit. An edit by a bot or
// this app is dropped, as is a deletion of a bot message: neither produced a
// wake to correct. A message_changed whose previous_message is present with
// the same text and files is a metadata-only update — Slack bumps a parent
// message's reply count when a reply lands — and is dropped as metadata-only;
// one with no previous_message has nothing to compare and still routes as an
// edit. Channel threads are out of scope (BB-130), so the caller admits only
// DMs.
func (s *Slack) parseSlackMessageCorrection(ev slackEvent, at time.Time) (slackRouted, bool) {
	if ev.Channel == "" {
		s.logSlackDropped(&ev, "missing-fields")
		return slackRouted{}, false
	}
	switch ev.Subtype {
	case "message_changed":
		m := ev.Message
		if m == nil || m.TS == "" || m.User == "" {
			s.logSlackDropped(&ev, "missing-fields")
			return slackRouted{}, false
		}
		if m.BotID != "" || m.AppID != "" {
			s.logSlackDropped(&ev, "bot-author")
			return slackRouted{}, false
		}
		if ev.PreviousMessage != nil && ev.PreviousMessage.Text == m.Text &&
			slackFilesEqual(ev.PreviousMessage.Files, m.Files) {
			s.logSlackDropped(&ev, "metadata-only")
			return slackRouted{}, false
		}
		session, thread := s.directSession(ev.Channel, ev.ChannelType, m.User, m.ThreadTS, m.TS)
		return slackRouted{Session: session, Action: "edited", Tagged: !s.isOpened(session), Channel: ev.Channel, Thread: thread, User: m.User, Text: m.Text, TS: m.TS, At: at}, true
	case "message_deleted":
		prev := ev.PreviousMessage
		ts := ev.DeletedTS
		if ts == "" && prev != nil {
			ts = prev.TS
		}
		if ts == "" || prev == nil || prev.User == "" {
			s.logSlackDropped(&ev, "missing-fields")
			return slackRouted{}, false
		}
		if prev.BotID != "" || prev.AppID != "" {
			s.logSlackDropped(&ev, "bot-author")
			return slackRouted{}, false
		}
		session, thread := s.directSession(ev.Channel, ev.ChannelType, prev.User, prev.ThreadTS, ts)
		return slackRouted{Session: session, Action: "deleted", Tagged: !s.isOpened(session), Channel: ev.Channel, Thread: thread, User: prev.User, TS: ts, At: at}, true
	default:
		s.logSlackDropped(&ev, "unhandled-type")
		return slackRouted{}, false
	}
}

// slackTagsBot reports whether a channel message's text addresses the app's
// own bot user: Slack renders that as "<@U…>". An empty botUser never
// matches, because the id is not known yet.
func slackTagsBot(text, botUser string) bool {
	return botUser != "" && strings.Contains(text, "<@"+botUser+">")
}

// slackKeptSubtype reports whether a message subtype is one the adapter routes
// as a plain message: the empty subtype (a plain message) or file_share, the
// subtype Slack puts on a message created by sharing a file — a pasted
// screenshot or an upload, with or without accompanying text. Every other
// subtype (a join, a bot message, …) is dropped; message_changed and
// message_deleted are handled before this and never reach it.
func slackKeptSubtype(subtype string) bool {
	return subtype == "" || subtype == "file_share"
}

// slackFilesEqual reports whether two attachment lists are the same list:
// the same length and, in order, the same file. Files compare by id, falling
// back to name and size when either id is empty (a file Slack sent without
// an id). It tells a metadata-only message_changed, whose files are
// unchanged, from a real edit that added or removed an attachment.
func slackFilesEqual(a, b []slackFile) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != "" && b[i].ID != "" {
			if a[i].ID != b[i].ID {
				return false
			}
			continue
		}
		if a[i].Name != b[i].Name || a[i].Size != b[i].Size {
			return false
		}
	}
	return true
}

// slackFiles normalizes a message's attachments for the wake: the display
// name is the file's name, falling back to its title, and the type and size
// cross as Slack sent them. Nothing is fetched. A nil result leaves the wake's
// files field omitted.
func slackFiles(files []slackFile) []SlackFile {
	if len(files) == 0 {
		return nil
	}
	out := make([]SlackFile, 0, len(files))
	for _, f := range files {
		name := f.Name
		if name == "" {
			name = f.Title
		}
		preview := f.Preview
		if preview == "" {
			preview = f.PlainText
		}
		out = append(out, SlackFile{
			ID:         f.ID,
			Name:       name,
			MimeType:   f.Mimetype,
			Size:       f.Size,
			Filetype:   f.Filetype,
			Preview:    clipSlackPreview(preview),
			urlPrivate: f.URLPrivate,
		})
	}
	return out
}

// clipSlackPreview bounds a snippet preview carried on a wake. Slack's
// preview is short, but plain_text can be the whole snippet, and the wake
// must stay small. It truncates on a rune boundary and appends an ellipsis.
func clipSlackPreview(s string) string {
	if len(s) <= maxSlackFilePreview {
		return s
	}
	trimmed := s[:maxSlackFilePreview]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed + "…"
}

// slackSession names a Slack conversation: its channel and the root ts of
// the thread. The reply endpoints take the same string.
func slackSession(channel, thread string) string { return channel + ":" + thread }

func splitSlackSession(session string) (channel, thread string, ok bool) {
	channel, thread, ok = strings.Cut(session, ":")
	if !ok || channel == "" || thread == "" {
		return "", "", false
	}
	return channel, thread, true
}

// slackAngleRE matches one Slack control sequence: everything between an
// opening and closing angle bracket, with no nested brackets. Slack escapes
// a literal < or > in message text, so an angle-bracketed run is a token.
var slackAngleRE = regexp.MustCompile(`<([^<>]*)>`)

// slackUserTokenRE, slackChannelTokenRE and slackLinkTokenRE match the inner
// text of the three resolvable token kinds, each with an optional |label.
// Anything that matches none of them is left exactly as it was.
var (
	slackUserTokenRE    = regexp.MustCompile(`^@([A-Za-z0-9_-]+)(?:\|(.*))?$`)
	slackChannelTokenRE = regexp.MustCompile(`^#([A-Za-z0-9_-]+)(?:\|(.*))?$`)
	slackLinkTokenRE    = regexp.MustCompile(`^(https?://[^|]*|mailto:[^|]*|tel:[^|]*)(?:\|(.*))?$`)
)

// resolveSlackText rewrites Slack's control sequences in text into readable
// form and returns the user mentions it saw, in order of appearance and
// deduplicated. It makes at most one users.info (and one conversations.info)
// call per token, all bounded by ctx; a lookup that fails or times out leaves
// the id in place. It is applied in memory, after the webhook has been
// acknowledged, and nothing is persisted or logged.
func (s *Slack) resolveSlackText(ctx context.Context, text, botUser string) (string, []SlackMention) {
	if text == "" || !strings.ContainsRune(text, '<') {
		return text, nil
	}
	locs := slackAngleRE.FindAllStringSubmatchIndex(text, -1)
	if len(locs) == 0 {
		return text, nil
	}
	var b strings.Builder
	b.Grow(len(text))
	var mentions []SlackMention
	seen := map[string]bool{}
	last := 0
	for _, loc := range locs {
		b.WriteString(text[last:loc[0]])
		repl, mention, ok := s.resolveSlackToken(ctx, text[loc[2]:loc[3]], botUser)
		if !ok {
			b.WriteString(text[loc[0]:loc[1]])
		} else {
			b.WriteString(repl)
			if mention != nil && !seen[mention.ID] {
				seen[mention.ID] = true
				mentions = append(mentions, *mention)
			}
		}
		last = loc[1]
	}
	b.WriteString(text[last:])
	return b.String(), mentions
}

// resolveSlackToken resolves one token's inner text (the part between the
// angle brackets). ok is false when inner is not a token this understands, so
// the caller keeps the original text. mention is non-nil only for a user
// mention, the kind a reply writes back as <@id>.
func (s *Slack) resolveSlackToken(ctx context.Context, inner, botUser string) (string, *SlackMention, bool) {
	switch inner {
	case "!here":
		return "@here", nil, true
	case "!channel":
		return "@channel", nil, true
	case "!everyone":
		return "@everyone", nil, true
	}
	if strings.HasPrefix(inner, "!subteam^") {
		// <!subteam^S…|@team> → @team; with no label, the id is all there is.
		if i := strings.IndexByte(inner, '|'); i >= 0 {
			return inner[i+1:], nil, true
		}
		return "@" + strings.TrimPrefix(inner, "!subteam^"), nil, true
	}
	if strings.HasPrefix(inner, "!date") {
		// <!date^…|fallback> → fallback. With no fallback there is nothing
		// readable to render, so the token is left alone.
		if i := strings.IndexByte(inner, '|'); i >= 0 {
			return inner[i+1:], nil, true
		}
		return "", nil, false
	}
	if m := slackUserTokenRE.FindStringSubmatch(inner); m != nil {
		id := m[1]
		if botUser != "" && id == botUser {
			return "@bb", &SlackMention{ID: id, Name: "bb"}, true
		}
		name, ok := s.userDisplayName(ctx, id)
		if !ok {
			// The lookup failed or timed out: keep the id, and still tell the
			// plugin the id so a reply can mention the person.
			return "@" + id, &SlackMention{ID: id, Name: id}, true
		}
		return "@" + name, &SlackMention{ID: id, Name: name}, true
	}
	if m := slackChannelTokenRE.FindStringSubmatch(inner); m != nil {
		id, label := m[1], m[2]
		if label != "" {
			return "#" + label, nil, true
		}
		name, ok := s.channelName(ctx, id)
		if !ok {
			// No channels:read/groups:read scope, or the channel is gone:
			// fall back to the id rather than guessing a name.
			return "#" + id, nil, true
		}
		return "#" + name, nil, true
	}
	if m := slackLinkTokenRE.FindStringSubmatch(inner); m != nil {
		url, label := m[1], m[2]
		if label != "" {
			return label + " (" + url + ")", nil, true
		}
		return url, nil, true
	}
	return "", nil, false
}

// userDisplayName returns the display name for a Slack user id, preferring the
// profile's display name, then the real name, then the handle. The name is
// cached for slackNameTTL, so a repeated mention makes no second call.
func (s *Slack) userDisplayName(ctx context.Context, id string) (string, bool) {
	now := s.now()
	s.mu.Lock()
	if e, ok := s.names[id]; ok && e.expires.After(now) {
		s.mu.Unlock()
		return e.name, true
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, slackLookupTimeout)
	defer cancel()
	var out struct {
		User struct {
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				RealName    string `json:"real_name"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := s.callForm(ctx, "users.info", string(s.botToken()), url.Values{"user": {id}}, &out); err != nil {
		return "", false
	}
	name := out.User.Profile.DisplayName
	if name == "" {
		name = out.User.Profile.RealName
	}
	if name == "" {
		name = out.User.RealName
	}
	if name == "" {
		name = out.User.Name
	}
	if name == "" {
		return "", false
	}
	s.mu.Lock()
	if s.names == nil {
		s.names = map[string]slackNameCacheEntry{}
	}
	if len(s.names) >= maxSlackNameCache {
		for k, e := range s.names {
			if !e.expires.After(now) {
				delete(s.names, k)
			}
		}
	}
	s.names[id] = slackNameCacheEntry{name: name, expires: now.Add(slackNameTTL)}
	s.mu.Unlock()
	return name, true
}

// channelName reads a channel's name with conversations.info, the only source
// for a <#C…> with no label. It needs channels:read/groups:read, which the app
// does not assume; a refusal is reported as not found and the caller keeps the
// id.
func (s *Slack) channelName(ctx context.Context, id string) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, slackLookupTimeout)
	defer cancel()
	var out struct {
		Channel struct {
			Name string `json:"name"`
		} `json:"channel"`
	}
	if err := s.callForm(ctx, "conversations.info", string(s.botToken()), url.Values{"channel": {id}}, &out); err != nil {
		return "", false
	}
	if out.Channel.Name == "" {
		return "", false
	}
	return out.Channel.Name, true
}

// slackRepliesPage is the part of conversations.replies this service reads:
// one page of the thread's messages, oldest first, and the cursor for the
// next page.
type slackRepliesPage struct {
	Messages []slackThreadMessage `json:"messages"`
	HasMore  bool                 `json:"has_more"`
	Metadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

// slackThreadMessage is one message from conversations.replies. Only the
// fields a history entry needs are named; nothing is fetched while parsing.
type slackThreadMessage struct {
	TS    string      `json:"ts"`
	User  string      `json:"user"`
	BotID string      `json:"bot_id"`
	AppID string      `json:"app_id"`
	Text  string      `json:"text"`
	Files []slackFile `json:"files"`
}

// fetchSlackHistory reads the messages before beforeTS in a thread with
// conversations.replies and the bot token, following the cursor to the end
// of the thread so the newest messages are the ones kept, resolves their
// control sequences like comment.text, and clips the oldest to
// maxSlackHistoryMessages and slackHistoryTextBudget. Any error or timeout
// returns nil, so the caller sends the wake without history rather than
// holding or dropping it. The fetched text is held in memory only and is
// never logged or stored; the file ids it names are metadata only and are
// never remembered for the file endpoint.
func (s *Slack) fetchSlackHistory(ctx context.Context, channel, thread, beforeTS string) []SlackHistoryMessage {
	if channel == "" || thread == "" || beforeTS == "" {
		return nil
	}
	var raw []slackThreadMessage
	cursor := ""
	more := false
	for page := 0; page < maxSlackHistoryPages; page++ {
		params := url.Values{
			"channel":   {channel},
			"ts":        {thread},
			"latest":    {beforeTS},
			"inclusive": {"false"},
			"limit":     {strconv.Itoa(slackHistoryFetchLimit)},
		}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		callCtx, cancel := context.WithTimeout(ctx, slackLookupTimeout)
		var out slackRepliesPage
		err := s.callForm(callCtx, "conversations.replies", string(s.botToken()), params, &out)
		cancel()
		if err != nil {
			s.logger().Warn("slack history lookup failed", "channel", channel, "err", err)
			return nil
		}
		// Slack does not apply latest/inclusive once a cursor is passed, so
		// filter each page rather than only the collected set: the waking
		// message and anything after it must never be carried.
		for _, m := range out.Messages {
			if m.TS == "" || m.TS >= beforeTS {
				continue
			}
			raw = append(raw, m)
		}
		more = out.HasMore && out.Metadata.NextCursor != ""
		if !more {
			break
		}
		cursor = out.Metadata.NextCursor
	}
	// Keep only the newest by count before resolving, so name lookups stay
	// bounded; the text budget is applied to the resolved text below.
	truncated := more
	if len(raw) > maxSlackHistoryMessages {
		raw = raw[len(raw)-maxSlackHistoryMessages:]
		truncated = true
	}
	bot := s.resolvedBot()
	msgs := make([]SlackHistoryMessage, 0, len(raw))
	for _, m := range raw {
		if m.TS == "" || m.TS >= beforeTS {
			continue
		}
		text, _ := s.resolveSlackText(ctx, m.Text, bot)
		user := SlackHistoryUser{ID: m.User}
		switch {
		case m.BotID != "" || m.AppID != "" || (bot != "" && m.User == bot):
			user = SlackHistoryUser{ID: bot, Name: "bb"}
		case m.User != "":
			if name, ok := s.userDisplayName(ctx, m.User); ok {
				user.Name = name
			} else {
				user.Name = m.User
			}
		}
		msgs = append(msgs, SlackHistoryMessage{
			TS:    m.TS,
			User:  user,
			Text:  text,
			Files: slackFiles(m.Files),
		})
	}
	return clipSlackHistory(msgs, truncated)
}

// clipSlackHistory bounds history to maxSlackHistoryMessages messages and
// slackHistoryTextBudget bytes of text, dropping whole messages from the
// oldest end. When anything was dropped — including messages the lookup
// could not reach — it prepends a marker entry, so the reader knows the
// transcript is incomplete. The newest message is always kept; if it alone
// is over the text budget its text is clipped.
func clipSlackHistory(msgs []SlackHistoryMessage, truncated bool) []SlackHistoryMessage {
	if len(msgs) == 0 {
		if truncated {
			return []SlackHistoryMessage{{Text: slackHistoryClipMarker}}
		}
		return nil
	}
	total := 0
	for _, m := range msgs {
		total += len(m.Text)
	}
	start := 0
	for start < len(msgs)-1 && (len(msgs)-start > maxSlackHistoryMessages || total > slackHistoryTextBudget) {
		total -= len(msgs[start].Text)
		start++
	}
	kept := append([]SlackHistoryMessage(nil), msgs[start:]...)
	if total > slackHistoryTextBudget && len(kept) > 0 {
		// Only one message can be left when the loop stopped with the
		// budget still over: clip its text so the budget is a hard bound.
		kept[0].Text = clipSlackHistoryText(kept[0].Text, slackHistoryTextBudget)
	}
	if start > 0 || truncated {
		kept = append([]SlackHistoryMessage{{Text: slackHistoryClipMarker}}, kept...)
	}
	return kept
}

// clipSlackHistoryText truncates s to at most max bytes on a rune boundary
// and appends an ellipsis, counting the ellipsis inside the cap.
func clipSlackHistoryText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	ellipsis := "…"
	limit := max - len(ellipsis)
	if limit < 0 {
		limit = 0
	}
	trimmed := s[:limit]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed + ellipsis
}

// route delivers the event to the server that owns the session, or posts
// the no-server reply. It runs after the webhook's 200. A silent event
// (block_action) is dropped without a reply when there is no server or the
// server is not reading.
//
// A session's owner is set by the first routed wake and kept for the keep
// window. A later wake in a live session from a different Slack user is
// routed to the owner's server, marked untrusted, and never to the second
// person's server.
func (s *Slack) route(ev slackRouted) {
	// firstWake is whether this is the session's first routed wake: no live
	// lease and no live route entry yet (the same check BB-130 uses for an
	// untagged follow-up). Only the first wake carries the thread's earlier
	// messages (BB-162); a follow-up in a live session does not.
	firstWake := ev.Session != "" && !s.sessionLive(ev.Session)
	conn, id := s.Registry.ByUser("slack", ev.User)
	// Remember the asker's binding so a server that later drops is told it
	// is not connected rather than not set up. In memory only.
	s.rememberBinding(ev.User, conn != nil)
	// asker is the identity bound to the asker, when there is one; it names
	// the second person in a wake routed to the session's owner.
	asker := id
	if ev.Session != "" {
		// The lease table is the owner of record; the route table is the
		// bootstrap fallback for the first mention, which always arrives
		// before the plugin has leased the session.
		owner, leased := s.leaseOwner(ev.Session)
		if !leased {
			owner = s.remember(ev.Session, ev.User, conn != nil)
		}
		if owner == "" {
			// No live owner and the asker's server is not routable.
			s.logger().Info("slack session not routed",
				"session", ev.Session, "action", ev.Action, "channel", ev.Channel, "reason", "no-connection")
			if !ev.Silent {
				s.postNoConnectionNotice(ev)
			}
			return
		}
		if owner != ev.User {
			// The session belongs to someone else: route to the owner's
			// server, never to the second person's.
			conn, id = s.Registry.ByUser("slack", owner)
		}
	}
	if conn == nil {
		// The owner's server is gone (or a sessionless wake's asker has
		// none). Drop the wake; it never falls through to a second
		// person's server. The notice names no server or identity.
		s.logger().Info("slack session not routed",
			"session", ev.Session, "action", ev.Action, "channel", ev.Channel, "reason", "no-connection")
		if !ev.Silent {
			s.postNotice(ev, notReadingText, nil)
		}
		return
	}
	fromOwner := id.User == ev.User
	capability := ""
	if ev.Session != "" {
		capability = s.leaseCapability(ev.Session, id.User)
	}
	// Remember the file ids this wake carried, so the file endpoint can
	// refuse an id that was never seen on a wake routed to this session. The
	// url_private stays here; it is never put on the wake.
	if ev.Session != "" && len(ev.Files) > 0 {
		s.rememberFiles(ev.Session, ev.Files)
	}
	// Resolve Slack control sequences (<@U…>, <#C…>, <!here>, links) to
	// readable text in memory, with a short bound. A failed lookup falls
	// back to the id and never drops or delays the wake past the bound.
	var mentions []SlackMention
	if (ev.Action == "message" || ev.Action == "edited") && ev.Text != "" {
		ctx, cancel := context.WithTimeout(context.Background(), slackResolveTimeout)
		ev.Text, mentions = s.resolveSlackText(ctx, ev.Text, s.resolvedBot())
		cancel()
	}
	// On the first wake of a session whose waking message is a reply in an
	// existing thread, carry the thread's earlier messages. A thread bb
	// started — a DM root or a top-level mention, where the waking message
	// is its own thread root — has no earlier messages and no fetch. The
	// lookup is bounded and degrades to no history on any error or timeout,
	// so the wake is never held or dropped for it. It runs after routing and
	// the no-connection returns above, so a dropped or refused message never
	// reaches Slack.
	var history []SlackHistoryMessage
	if firstWake && ev.Action == "message" && ev.TS != "" && ev.Thread != "" && ev.Thread != ev.TS {
		ctx, cancel := context.WithTimeout(context.Background(), s.historyWindow())
		history = s.fetchSlackHistory(ctx, ev.Channel, ev.Thread, ev.TS)
		cancel()
	}
	wake := SlackWake{
		Source:         "slack",
		Session:        ev.Session,
		Action:         ev.Action,
		Mention:        ev.Mention,
		Tagged:         ev.Tagged,
		Opened:         s.isOpened(ev.Session),
		Channel:        ev.Channel,
		ContextChannel: ev.ContextChannel,
		Thread:         ev.Thread,
		Asker:          Person{ID: ev.User, Name: asker.Name},
		Owner:          Person{ID: id.User, Name: id.Name},
		FromOwner:      fromOwner,
		RoutedAs:       "owner",
		Comment:        WakeComment{Text: ev.Text, Untrusted: !fromOwner},
		TS:             ev.TS,
		Mentions:       mentions,
		Files:          ev.Files,
		History:        history,
		At:             ev.At,
		ActionID:       ev.ActionID,
		Value:          ev.Value,
		ResponseURL:    ev.ResponseURL,
		Capability:     capability,
	}
	select {
	case conn.SlackWakes <- wake:
		s.logger().Info("slack session routed",
			"session", ev.Session, "action", ev.Action, "channel", ev.Channel,
			"connection", conn.ID, "user", id.User, "fromOwner", fromOwner, "textLen", len(ev.Text))
	default:
		s.logger().Warn("slack wake dropped: stream not reading",
			"session", ev.Session, "action", ev.Action, "channel", ev.Channel, "connection", conn.ID)
		if !ev.Silent {
			s.postNotice(ev, notReadingText, nil)
		}
	}
}

// guestText is the one-line reply to a guest with no bound server. A guest
// cannot bind one, so the service says so instead of the set-up reply. It
// carries no blocks or button.
const guestText = "bb is for members of this workspace"

// publicBaseURL is the developer-facing bb server base used in the set-up
// replies, trimmed of any trailing slash. It is deployment configuration
// with no built-in default, so an unconfigured service produces no link.
func (s *Slack) publicBaseURL() string {
	return strings.TrimRight(strings.TrimSpace(s.PublicBaseURL), "/")
}

// noServerText is the plain-text fallback and notification body for the
// reply when nobody's bb covers the Slack user. The same content is sent as
// Block Kit blocks (noServerBlocks); clients that do not render blocks show
// this text instead.
func (s *Slack) noServerText() string {
	base := s.publicBaseURL()
	if base == "" {
		// No public base URL configured: keep the instructions but leave
		// out the link, rather than render a broken one.
		return "Your bb server is not set up yet. Finish the Team setup checklist on the home page (model sign-in, GitHub), then open Settings \u2192 Plugins \u2192 Slack and choose Sign in with Slack; then message me again."
	}
	return "Your bb server is not set up yet. Visit " + base + "/ to create it (the first visit takes a minute or two), then finish the Team setup checklist on the home page (model sign-in, GitHub). After that open Settings \u2192 Plugins \u2192 Slack and choose Sign in with Slack; then message me again."
}

// noServerBlocks is the Block Kit body of the no-server reply: a section
// saying the server is not set up yet and what to do next, and one url
// button to start. A url button never posts back to Slack, so no
// interactivity endpoint is needed.
func (s *Slack) noServerBlocks() json.RawMessage {
	base := s.publicBaseURL()
	section := "Your bb server is not set up yet."
	if base != "" {
		section = "Your bb server is not set up yet. Visiting " + base + "/ creates it on the first visit, which takes a minute or two."
	}
	section += "\n\nNext, finish the Team setup checklist on the home page (model sign-in, GitHub), then open *Settings \u2192 Plugins \u2192 Slack* and choose *Sign in with Slack*. Then message me again."
	blocks := []map[string]any{
		{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": section},
		},
	}
	// Slack refuses a url button whose URL is not absolute, so a button is
	// only added when there is a base URL to point it at.
	if base != "" {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{
				{
					"type": "button",
					"text": map[string]any{"type": "plain_text", "text": "Set up your bb"},
					"url":  base + "/",
				},
			},
		})
	}
	b, _ := json.Marshal(blocks)
	return b
}

// notReadingText is the DM reply when the bound server is not draining its
// event stream. It is not a sign-in problem, so it says so.
const notReadingText = "Your bb server is connected but not reading its events right now. Try again in a minute."

// notConnectedText is the plain-text fallback and notification body for the
// reply when the Slack user was bound recently but has no connection right
// now: the server is restarting or the plugin is not signed in, not that the
// server was never set up.
const notConnectedText = "Your bb server is not connected right now. This usually means the server is restarting, or you are not signed in to hooks-service. Open bb and check Settings \u2192 Plugins \u2192 Slack, then message me again in a minute."

// notConnectedBlocks is the Block Kit body of the not-connected reply: a
// section naming the likely causes and where to check, and one url button to
// bb. A url button never posts back to Slack, so no interactivity endpoint
// is needed.
func (s *Slack) notConnectedBlocks() json.RawMessage {
	base := s.publicBaseURL()
	blocks := []map[string]any{
		{
			"type": "section",
			"text": map[string]any{
				"type": "mrkdwn",
				"text": "Your bb server is not connected right now. This usually means the server is restarting, or you are not signed in to hooks-service.\n\nOpen bb and check *Settings \u2192 Plugins \u2192 Slack*. If bb is running, wait a minute and message me again.",
			},
		},
	}
	// A url button with no absolute URL is refused by Slack, so it is only
	// added when there is a base URL to point it at.
	if base != "" {
		blocks = append(blocks, map[string]any{
			"type": "actions",
			"elements": []map[string]any{
				{
					"type": "button",
					"text": map[string]any{"type": "plain_text", "text": "Open bb"},
					"url":  base + "/",
				},
			},
		})
	}
	b, _ := json.Marshal(blocks)
	return b
}

// postNoConnectionNotice posts the reply for a wake whose asker has no bound
// connection. The asker is classified first: a Slack Connect stranger (or a
// bot, or a user from another team) is dropped without a reply, and a guest
// gets one line saying bb is for members, because neither can ever bind a
// server. A member, or an asker Slack could not be read for, gets the
// not-connected reply when they were bound recently (or during the startup
// grace), else the set-up reply. The not-connected reply is deduped per
// session so a person retrying at once gets one notice; the set-up and guest
// replies are not.
func (s *Slack) postNoConnectionNotice(ev slackRouted) {
	class, err := s.askerClass(ev.User)
	if err != nil {
		// Slack was unreachable or refused the user: fall back to the
		// member reply so a transient error never silences a teammate.
		s.logger().Warn("slack no-server classification failed", "user", ev.User, "err", err)
	} else {
		switch class {
		case slackAskStranger:
			s.logger().Info("slack no-server notice dropped", "reason", "stranger", "user", ev.User, "channel", ev.Channel)
			return
		case slackAskGuest:
			s.postNotice(ev, guestText, nil)
			return
		}
	}
	if s.notConnected(ev.User) {
		if s.claimNotice(ev.Session) {
			s.postNotice(ev, notConnectedText, s.notConnectedBlocks())
		}
		return
	}
	s.postNotice(ev, s.noServerText(), s.noServerBlocks())
}

// askerClass returns the cached classification for a Slack user, reading
// users.info once per slackAskClassTTL. The class is cached; an error is
// returned and never cached, so the next event tries again.
func (s *Slack) askerClass(userID string) (slackAskClass, error) {
	if userID == "" {
		return slackAskMember, nil
	}
	now := s.now()
	s.mu.Lock()
	if e, ok := s.askClasses[userID]; ok && e.expires.After(now) {
		s.mu.Unlock()
		return e.class, nil
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), verifyTimeout)
	defer cancel()
	class, err := s.classifyAsk(ctx, userID)
	if err != nil {
		return slackAskMember, err
	}
	s.mu.Lock()
	if s.askClasses == nil {
		s.askClasses = map[string]slackAskClassEntry{}
	}
	if len(s.askClasses) >= maxSlackAskClasses {
		for k, e := range s.askClasses {
			if !e.expires.After(now) {
				delete(s.askClasses, k)
			}
		}
	}
	if len(s.askClasses) >= maxSlackAskClasses {
		var oldest string
		var at time.Time
		for k, e := range s.askClasses {
			if oldest == "" || e.expires.Before(at) {
				oldest, at = k, e.expires
			}
		}
		delete(s.askClasses, oldest)
	}
	s.askClasses[userID] = slackAskClassEntry{class: class, expires: now.Add(slackAskClassTTL)}
	s.mu.Unlock()
	return class, nil
}

// notConnected reports whether the reply for a user with no bound connection
// should be the not-connected variant: during the startup grace, or when a
// connection was bound for the user within the window. The table is in
// memory only.
func (s *Slack) notConnected(user string) bool {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.startedAt.IsZero() && now.Sub(s.startedAt) < s.graceWindow() {
		return true
	}
	b, ok := s.bindings[user]
	return ok && !b.lastBoundAt.IsZero() && now.Sub(b.lastBoundAt) < s.bindWindow()
}

// rememberBinding records that a Slack user was seen, and that a connection
// was bound for them when bound is true. The table is bounded: at the cap,
// entries older than the window are pruned, then the least recently seen.
func (s *Slack) rememberBinding(user string, bound bool) {
	if user == "" {
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bindings == nil {
		s.bindings = map[string]slackUserBinding{}
	}
	b := s.bindings[user]
	b.lastSeenAt = now
	if bound {
		b.lastBoundAt = now
	}
	if len(s.bindings) >= maxSlackUserBindings {
		for u, o := range s.bindings {
			if now.Sub(o.lastSeenAt) > s.bindWindow() {
				delete(s.bindings, u)
			}
		}
	}
	if len(s.bindings) >= maxSlackUserBindings {
		var oldest string
		var at time.Time
		for u, o := range s.bindings {
			if oldest == "" || o.lastSeenAt.Before(at) {
				oldest, at = u, o.lastSeenAt
			}
		}
		delete(s.bindings, oldest)
	}
	s.bindings[user] = b
}

// claimNotice reports whether this session may post the not-connected notice
// now, and records the claim when it may. A claim within the dedupe window
// suppresses the notice.
func (s *Slack) claimNotice(session string) bool {
	if session == "" {
		return true
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.notices == nil {
		s.notices = map[string]time.Time{}
	}
	if exp, ok := s.notices[session]; ok && exp.After(now) {
		return false
	}
	if len(s.notices) >= maxSlackNotices {
		for k, exp := range s.notices {
			if !exp.After(now) {
				delete(s.notices, k)
			}
		}
	}
	if len(s.notices) >= maxSlackNotices {
		var oldest string
		var at time.Time
		for k, exp := range s.notices {
			if oldest == "" || exp.Before(at) {
				oldest, at = k, exp
			}
		}
		delete(s.notices, oldest)
	}
	s.notices[session] = now.Add(s.dedupeWindow())
	return true
}

// bindWindow is the configured window, or the default.
func (s *Slack) bindWindow() time.Duration {
	if s.window > 0 {
		return s.window
	}
	return slackBindWindow
}

// graceWindow is the configured startup grace, or the default.
func (s *Slack) graceWindow() time.Duration {
	if s.grace > 0 {
		return s.grace
	}
	return slackStartupGrace
}

// dedupeWindow is the configured dedupe, or the default.
func (s *Slack) dedupeWindow() time.Duration {
	if s.dedupe > 0 {
		return s.dedupe
	}
	return slackNoticeDedupe
}

// markStarted records the service start for the startup grace. It is called
// once at boot and is idempotent.
func (s *Slack) markStarted() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.startedAt.IsZero() {
		s.startedAt = s.now()
	}
}

// slackChannelRestrictedNote is the line appended when a post falls back to
// an ephemeral message because the channel does not let the app post. The
// caller posts it as text, not as a block, so the note is always visible.
const slackChannelRestrictedNote = "_This channel doesn't let bb post, so only you see this._"

func (s *Slack) postNotice(ev slackRouted, text string, blocks json.RawMessage) {
	err := s.postMessage(context.Background(), ev.Channel, ev.Thread, text, blocks)
	if err == nil {
		return
	}
	if errors.Is(err, errSlackChannelRestricted) {
		// The channel does not let the app post. Show the notice to the
		// asker alone, with a line saying why. The blocks are dropped: a
		// block body would hide the note, and the text fallback already
		// carries what to do. A failed fallback is still only a warning.
		if ferr := s.postEphemeral(context.Background(), ev.Channel, ev.User, text+"\n"+slackChannelRestrictedNote, nil); ferr != nil {
			s.logger().Warn("slack: notice not posted and the ephemeral fallback failed", "err", ferr)
		}
		return
	}
	s.logger().Warn("slack: notice not posted", "err", err)
}

// remember returns the owner a wake in session must be routed to, and
// records user as the owner when the session has none. The owner is set
// once while the route is live: a live session keeps its owner, and only
// the owner's own wake renews the expiry. A lapsed or unseen session is
// owned by user, but only when routable is true (the asker's server is
// connected); otherwise it stays unowned and remember returns "".
//
// The check and the store share one critical section, so two concurrent
// first mentions in one session settle on a single owner. When the table
// is full it first drops the lapsed routes, then the one closest to
// expiring, so the cap is a hard bound even with live sessions.
func (s *Slack) remember(session, user string, routable bool) string {
	keep := DefaultSessionKeep
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.routed == nil {
		s.routed = map[string]slackRoute{}
	}
	if r, ok := s.routed[session]; ok && r.expires.After(now) {
		if r.user == user {
			r.expires = now.Add(keep)
			s.routed[session] = r
		}
		return r.user
	}
	if !routable {
		return ""
	}
	if len(s.routed) >= maxSlackSessions {
		for id, r := range s.routed {
			if !r.expires.After(now) {
				delete(s.routed, id)
			}
		}
	}
	if len(s.routed) >= maxSlackSessions {
		var oldest string
		var at time.Time
		for id, r := range s.routed {
			if oldest == "" || r.expires.Before(at) {
				oldest, at = id, r.expires
			}
		}
		delete(s.routed, oldest)
	}
	s.routed[session] = slackRoute{user: user, expires: now.Add(keep)}
	return user
}

// capabilityKey derives the session-capability key from the signing secret
// under its own label. The label keeps the capability HMAC from being the
// request-signature HMAC, and the secret survives a restart, so a capability
// minted before one verifies after it.
func (s *Slack) capabilityKey() []byte {
	mac := hmac.New(sha256.New, s.signingSecret())
	mac.Write([]byte(slackCapabilityLabel))
	return mac.Sum(nil)
}

// leaseCapability is the opaque capability for a session and its owner: an
// HMAC over "session|user" keyed by capabilityKey. The wake carries it to the
// owner's server and the server echoes it on subscribe; it is never logged.
func (s *Slack) leaseCapability(session, user string) string {
	if session == "" || user == "" {
		return ""
	}
	mac := hmac.New(sha256.New, s.capabilityKey())
	mac.Write([]byte(session + "|" + user))
	return hex.EncodeToString(mac.Sum(nil))
}

// capabilityValid reports whether capability is the one for session and user,
// comparing in constant time.
func (s *Slack) capabilityValid(session, user, capability string) bool {
	want := s.leaseCapability(session, user)
	if want == "" || capability == "" {
		return false
	}
	return hmac.Equal([]byte(capability), []byte(want))
}

// leaseOwner returns the session's live lessee, when there is one. A lease
// whose connection is gone is not live, so a closed stream releases the
// session before its expiry.
func (s *Slack) leaseOwner(session string) (string, bool) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leases[session]
	if !ok {
		return "", false
	}
	if !l.expires.After(now) {
		delete(s.leases, session)
		return "", false
	}
	if s.Registry == nil || s.Registry.Get(l.conn) == nil {
		delete(s.leases, session)
		return "", false
	}
	return l.user, true
}

// admitSession admits or renews a session lease on connection c. The watch
// names a session and carries the capability from a wake routed to c's bound
// Slack user; the capability must verify for that user, so ownership is
// proved with no Slack call and no token read. A session already leased by
// another user is ErrOwned: the first admitted user wins, and the same user's
// renewal moves the expiry forward.
func (s *Slack) admitSession(c *Conn, w Watch) (Lease, error) {
	if w.Kind != slackSessionKind || w.ID == "" || w.Capability == "" {
		return Lease{}, ErrForbidden
	}
	if _, _, ok := splitSlackSession(w.ID); !ok {
		return Lease{}, ErrForbidden
	}
	if s.Registry == nil {
		return Lease{}, ErrForbidden
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		return Lease{}, ErrForbidden
	}
	if !s.capabilityValid(w.ID, id.User, w.Capability) {
		return Lease{}, ErrForbidden
	}
	// A lease on a conversation bb opened is accepted only from the
	// connection that opened it, so a capability that leaked to another pod's
	// stream cannot take the session.
	if conn, ok := s.openedConn(w.ID); ok && conn != c.ID {
		return Lease{}, ErrForbidden
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.leases == nil {
		s.leases = map[string]slackLease{}
	}
	if l, ok := s.leases[w.ID]; ok && l.expires.After(now) && l.user != id.User && s.Registry.Get(l.conn) != nil {
		return Lease{}, ErrOwned
	}
	if len(s.leases) >= maxSlackLeases {
		for k, l := range s.leases {
			if !l.expires.After(now) {
				delete(s.leases, k)
			}
		}
	}
	if len(s.leases) >= maxSlackLeases {
		var oldest string
		var at time.Time
		for k, l := range s.leases {
			if oldest == "" || l.expires.Before(at) {
				oldest, at = k, l.expires
			}
		}
		delete(s.leases, oldest)
	}
	exp := now.Add(s.Registry.Lease)
	s.leases[w.ID] = slackLease{user: id.User, conn: c.ID, expires: exp}
	return Lease{Kind: w.Kind, ID: w.ID, ExpiresAt: exp}, nil
}

// forgetConnection drops every session lease bound to a closed connection.
func (s *Slack) forgetConnection(conn string) {
	if conn == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, l := range s.leases {
		if l.conn == conn {
			delete(s.leases, k)
		}
	}
}

// allowed reports whether session is held by user: a live session lease (the
// owner of record) or, as the bootstrap fallback, a live route entry.
func (s *Slack) allowed(session, user string) bool {
	if owner, ok := s.leaseOwner(session); ok && owner == user {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.routed[session]
	return ok && r.user == user && r.expires.After(s.now())
}

// rememberChannel records that a wake for channel was delivered to conn, so
// that connection may post an ephemeral message there. It is the capability
// half of the ephemeral endpoint: a connection may post only to a channel
// this service already delivered to it. No wake calls it today — the invite
// prompt that did is gone, and the mention-time prompt that will is not
// written yet — so the endpoint refuses every channel until one does.
func (s *Slack) rememberChannel(conn, channel string) {
	if conn == "" || channel == "" {
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ephemeralChannels == nil {
		s.ephemeralChannels = map[string]map[string]time.Time{}
	}
	m := s.ephemeralChannels[conn]
	if m == nil {
		m = map[string]time.Time{}
		s.ephemeralChannels[conn] = m
	}
	if len(m) >= maxSlackEphemeralChannels {
		for ch, exp := range m {
			if !exp.After(now) {
				delete(m, ch)
			}
		}
	}
	if len(m) >= maxSlackEphemeralChannels {
		var oldest string
		var at time.Time
		for ch, exp := range m {
			if oldest == "" || exp.Before(at) {
				oldest, at = ch, exp
			}
		}
		delete(m, oldest)
	}
	m[channel] = now.Add(DefaultSessionKeep)
}

// allowedChannel reports whether a wake for channel was delivered to conn
// and has not lapsed.
func (s *Slack) allowedChannel(conn, channel string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.ephemeralChannels[conn]
	if m == nil {
		return false
	}
	exp, ok := m[channel]
	if !ok {
		return false
	}
	if !exp.After(s.now()) {
		delete(m, channel)
		return false
	}
	return true
}

// rememberFiles records the file ids a wake carried for a session and the
// url_private to fetch each with, so the file endpoint can serve only ids
// seen on a wake routed to that session. In memory only, for the same
// 24-hour window as a routed session; it holds no bytes and never logs a
// name or URL. A file with no url_private is not remembered: the endpoint
// could not fetch it anyway.
func (s *Slack) rememberFiles(session string, files []SlackFile) {
	if session == "" || len(files) == 0 {
		return
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fileRefs == nil {
		s.fileRefs = map[string]map[string]slackFileRef{}
	}
	if _, ok := s.fileRefs[session]; !ok && len(s.fileRefs) >= maxSlackFileSessions {
		for k, m := range s.fileRefs {
			lapsed := true
			for _, ref := range m {
				if ref.expires.After(now) {
					lapsed = false
					break
				}
			}
			if lapsed {
				delete(s.fileRefs, k)
			}
		}
	}
	m := s.fileRefs[session]
	if m == nil {
		if len(s.fileRefs) >= maxSlackFileSessions {
			// Still full of live sessions: drop the one that expires soonest
			// rather than grow without bound.
			var oldest string
			var at time.Time
			for k, mm := range s.fileRefs {
				for _, ref := range mm {
					if oldest == "" || ref.expires.Before(at) {
						oldest, at = k, ref.expires
					}
				}
			}
			if oldest != "" {
				delete(s.fileRefs, oldest)
			}
		}
		m = map[string]slackFileRef{}
		s.fileRefs[session] = m
	}
	for _, f := range files {
		if f.ID == "" || f.urlPrivate == "" {
			continue
		}
		if _, exists := m[f.ID]; !exists && len(m) >= maxSlackFilesPerSession {
			// The per-session cap is a hard bound: drop the oldest entry. An id
			// already remembered is refreshed in place, so re-delivering one
			// message's files cannot churn out a neighbour.
			var oldest string
			var at time.Time
			for k, ref := range m {
				if oldest == "" || ref.expires.Before(at) {
					oldest, at = k, ref.expires
				}
			}
			if oldest != "" {
				delete(m, oldest)
			}
		}
		m[f.ID] = slackFileRef{
			url:      f.urlPrivate,
			mimeType: f.MimeType,
			filetype: f.Filetype,
			size:     f.Size,
			expires:  now.Add(DefaultSessionKeep),
		}
	}
}

// fileRef returns the remembered file for a session, when it has not
// lapsed. A lapsed entry is dropped on the way out.
func (s *Slack) fileRef(session, id string) (slackFileRef, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.fileRefs[session]
	if m == nil {
		return slackFileRef{}, false
	}
	ref, ok := m[id]
	if !ok {
		return slackFileRef{}, false
	}
	if !ref.expires.After(s.now()) {
		delete(m, id)
		return slackFileRef{}, false
	}
	return ref, true
}

// slackImageMimes and slackTextMimes are the mime types the file endpoint
// forwards: an image up to 10 MiB, a text-like file up to 1 MiB. Everything
// else is refused 415. Slack often labels a snippet application/octet-stream
// or gives it no mime type at all, so a code filetype in slackTextFiletypes
// counts as text too.
var (
	slackImageMimes = map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
	}
	slackTextMimes = map[string]bool{
		"application/json": true, "application/ld+json": true,
		"application/xml": true, "application/x-yaml": true, "application/yaml": true,
		"application/javascript": true, "application/x-javascript": true,
		"application/x-sh": true, "application/x-httpd-php": true,
		"application/x-python": true, "application/x-ruby": true,
		"application/x-perl": true, "application/x-tex": true,
		"application/sql": true, "application/graphql": true,
		"application/csv": true, "application/toml": true,
	}
	slackTextFiletypes = map[string]bool{
		"text": true, "csv": true, "json": true, "markdown": true, "md": true,
		"javascript": true, "typescript": true, "python": true, "ruby": true,
		"go": true, "golang": true, "java": true, "c": true, "cpp": true,
		"csharp": true, "shell": true, "bash": true, "sh": true, "yaml": true,
		"yml": true, "xml": true, "html": true, "css": true, "sql": true,
		"rust": true, "kotlin": true, "swift": true, "php": true, "perl": true,
		"r": true, "scala": true, "diff": true, "patch": true, "dockerfile": true,
		"makefile": true, "toml": true, "ini": true, "cfg": true, "log": true,
		"tsv": true, "textile": true, "latex": true, "objectivec": true, "dart": true,
	}
)

// slackFileLimit returns the byte cap for a file, and whether the endpoint
// forwards its kind at all. The mime type is matched first (ignoring a
// parameter such as charset), then a code snippet's filetype.
func slackFileLimit(mimeType, filetype string) (int64, bool) {
	m := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if slackImageMimes[m] {
		return slackImageMaxBytes, true
	}
	if strings.HasPrefix(m, "text/") || slackTextMimes[m] {
		return slackTextMaxBytes, true
	}
	if slackTextFiletypes[strings.ToLower(strings.TrimSpace(filetype))] {
		return slackTextMaxBytes, true
	}
	return 0, false
}

// Start resolves the workspace and app id from the bot token so the first
// event does not pay for it, and reports whether it could. Failure is not
// fatal: a background retry or the first event tries again.
func (s *Slack) Start(ctx context.Context) error {
	s.markStarted()
	if err := s.Resolve(ctx); err != nil {
		return err
	}
	team, app := s.resolved()
	s.logger().Info("slack workspace resolved", "team", team, "app", app)
	return nil
}

// resolved returns the cached workspace and app id without network I/O.
func (s *Slack) resolved() (team, app string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.TeamID, s.AppID
}

// resolvedBot returns the cached bot user id without network I/O.
func (s *Slack) resolvedBot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.BotUserID
}

// Resolve discovers the workspace and app id from the bot token and caches
// them. Configured values win. It is safe to call concurrently: a caller
// while one is in flight returns ErrDisabled at once rather than adding
// another Slack round trip.
func (s *Slack) Resolve(ctx context.Context) error {
	s.mu.Lock()
	if s.TeamID != "" && s.AppID != "" && s.BotUserID != "" {
		s.mu.Unlock()
		return nil
	}
	if s.resolving {
		s.mu.Unlock()
		return ErrDisabled
	}
	s.resolving = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.resolving = false
		s.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	team, app, botUser, err := s.discover(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.TeamID == "" {
		s.TeamID = team
	}
	if s.AppID == "" {
		s.AppID = app
	}
	if s.BotUserID == "" {
		s.BotUserID = botUser
	}
	s.mu.Unlock()
	return nil
}

// discover reads the workspace, app id and bot user id from the bot token:
// auth.test names the workspace and the bot, bots.info names the bot's app.
// The read methods take their arguments form-encoded: Slack ignores a JSON
// body on them and answers ok with no bot, which is how the app id went
// missing in production. When bots.info still names no app, the bot user's
// own profile (users.info, profile.api_app_id) is the fallback.
func (s *Slack) discover(ctx context.Context) (team, app, botUser string, err error) {
	var auth struct {
		OK     bool   `json:"ok"`
		TeamID string `json:"team_id"`
		BotID  string `json:"bot_id"`
		UserID string `json:"user_id"`
	}
	if err := s.call(ctx, "auth.test", string(s.botToken()), nil, &auth); err != nil {
		return "", "", "", err
	}
	botUser = auth.UserID
	bot := auth.BotID
	if bot == "" {
		bot = auth.UserID
	}
	if auth.TeamID == "" || bot == "" {
		return "", "", "", fmt.Errorf("slack auth.test: incomplete answer")
	}
	var info struct {
		OK  bool `json:"ok"`
		Bot struct {
			AppID string `json:"app_id"`
		} `json:"bot"`
	}
	if err := s.callForm(ctx, "bots.info", string(s.botToken()), url.Values{"bot": {bot}}, &info); err != nil {
		return "", "", "", err
	}
	if info.Bot.AppID != "" {
		return auth.TeamID, info.Bot.AppID, botUser, nil
	}
	if auth.UserID == "" {
		return "", "", "", fmt.Errorf("slack bots.info: no app id")
	}
	var user struct {
		OK   bool `json:"ok"`
		User struct {
			Profile struct {
				AppID string `json:"api_app_id"`
			} `json:"profile"`
		} `json:"user"`
	}
	if err := s.callForm(ctx, "users.info", string(s.botToken()), url.Values{"user": {auth.UserID}}, &user); err != nil {
		return "", "", "", err
	}
	if user.User.Profile.AppID == "" {
		return "", "", "", fmt.Errorf("slack bots.info and users.info: no app id")
	}
	return auth.TeamID, user.User.Profile.AppID, botUser, nil
}

// call runs one Slack Web API method with token and a JSON payload and
// decodes the JSON answer. It never logs the token or the body. Write
// methods (chat.postMessage) take JSON; read methods take their arguments
// form-encoded, see callForm.
func (s *Slack) call(ctx context.Context, method, token string, payload map[string]any, out any) error {
	var body io.Reader
	if payload != nil {
		b, _ := json.Marshal(payload)
		body = bytes.NewReader(b)
	}
	return s.do(ctx, method, token, "application/json; charset=utf-8", body, out)
}

// callForm runs one Slack Web API read method (bots.info, users.info) with
// its arguments form-encoded, the one encoding every method accepts.
func (s *Slack) callForm(ctx context.Context, method, token string, params url.Values, out any) error {
	return s.do(ctx, method, token, "application/x-www-form-urlencoded", strings.NewReader(params.Encode()), out)
}

func (s *Slack) do(ctx context.Context, method, token, contentType string, body io.Reader, out any) error {
	if token == "" {
		return ErrDisabled
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.api()+"/"+method, body)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	var env struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(raw, &env)
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode == http.StatusUnauthorized:
		return ErrBadToken
	case !env.OK:
		if env.Error == "invalid_auth" || env.Error == "not_authed" || env.Error == "token_revoked" || env.Error == "account_inactive" {
			return ErrBadToken
		}
		return &slackAPIError{Code: env.Error}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("%w: %v", ErrUnverifiable, err)
		}
	}
	return nil
}

// slackAPIError is a Slack method that answered ok:false with an error
// code. It is ErrForbidden to errors.Is, as it always was; errors.As gives
// a handler the code when one code means something different from another
// (conversations.join refusing a private channel, say).
type slackAPIError struct {
	Code string
}

func (e *slackAPIError) Error() string { return "forbidden: slack " + e.Code }

func (e *slackAPIError) Is(target error) bool { return target == ErrForbidden }

// slackErrorCode is the Slack error code behind err, or "" when it is not
// a Slack method's own refusal. A channel-restricted post carries its code
// in a typed error, so it is read here too.
func slackErrorCode(err error) string {
	var api *slackAPIError
	if errors.As(err, &api) {
		return api.Code
	}
	var restricted *slackChannelRestrictedError
	if errors.As(err, &restricted) {
		return restricted.Code
	}
	return ""
}

// slackChannelRestrictedCodes are the Slack error codes that mean the
// channel does not let the app post. Slack answers these to
// chat.postMessage in a read-only or posting-restricted channel, and can
// answer them to conversations.join as well.
var slackChannelRestrictedCodes = map[string]bool{
	"restricted_action_read_only_channel": true,
	"restricted_action":                   true,
	"not_in_channel":                      true,
}

// slackChannelRestricted reports whether a Slack error code means the
// channel does not let the app post.
func slackChannelRestricted(code string) bool {
	return slackChannelRestrictedCodes[code]
}

// errSlackChannelRestricted marks a post the channel refused because it
// does not let the app post. errors.Is finds it through a
// slackChannelRestrictedError.
var errSlackChannelRestricted = errors.New("slack channel does not allow posting")

// slackChannelRestrictedError is a Slack post refused because the channel
// does not let the app post. postMessage returns it so a caller can tell
// this refusal from any other and fall back to an ephemeral message to the
// asker. It is still ErrForbidden to errors.Is, as every Slack refusal
// always was.
type slackChannelRestrictedError struct {
	Code string
}

func (e *slackChannelRestrictedError) Error() string { return "forbidden: slack " + e.Code }

func (e *slackChannelRestrictedError) Is(target error) bool {
	return target == ErrForbidden || target == errSlackChannelRestricted
}

// asSlackChannelRestricted returns the typed error when err is a Slack
// refusal that means the channel does not let the app post, or nil.
func asSlackChannelRestricted(err error) error {
	if !slackChannelRestricted(slackErrorCode(err)) {
		return nil
	}
	return &slackChannelRestrictedError{Code: slackErrorCode(err)}
}

// postMessage posts as the app, with optional Block Kit blocks. Neither text
// nor blocks is ever logged.
func (s *Slack) postMessage(ctx context.Context, channel, thread, text string, blocks json.RawMessage) error {
	_, err := s.postMessageTS(ctx, channel, thread, text, blocks)
	return err
}

// postMessageTS posts as the app and returns the posted message's Slack ts,
// which the conversation opener needs as the session's thread root. Neither
// text nor blocks is ever logged.
func (s *Slack) postMessageTS(ctx context.Context, channel, thread, text string, blocks json.RawMessage) (string, error) {
	payload := map[string]any{"channel": channel, "text": text}
	if thread != "" {
		payload["thread_ts"] = thread
	}
	if len(blocks) > 0 {
		payload["blocks"] = blocks
	}
	var out struct {
		TS string `json:"ts"`
	}
	err := s.call(ctx, "chat.postMessage", string(s.botToken()), payload, &out)
	if restricted := asSlackChannelRestricted(err); restricted != nil {
		return "", restricted
	}
	if err != nil {
		return "", err
	}
	return out.TS, nil
}

// postEphemeral posts as the app an ephemeral message visible only to user
// in channel, with text and optional Block Kit blocks. Neither text nor
// blocks is ever logged.
func (s *Slack) postEphemeral(ctx context.Context, channel, user, text string, blocks json.RawMessage) error {
	payload := map[string]any{"channel": channel, "user": user}
	if strings.TrimSpace(text) != "" {
		payload["text"] = text
	}
	if len(blocks) > 0 {
		payload["blocks"] = blocks
	}
	return s.call(ctx, "chat.postEphemeral", string(s.botToken()), payload, nil)
}

// Identify proves which Slack user a stream's server acts for, with that
// user's own token. A user token from the OAuth v2 sign-in (xoxp-, scope
// channels:read,groups:read) is read with auth.test; a still-valid OpenID
// Connect token from a sign-in before that change is read with
// openid.connect.userInfo, so identify accepts both and nobody is forced to
// sign out. Either way the user's name is read with the bot token's
// users:read. The token is used here and forgotten. A bad token, another
// workspace, a guest, an external user, or a user already bound to another
// live connection is refused.
func (s *Slack) identify(w http.ResponseWriter, r *http.Request, req IdentifyRequest, token string) {
	if token == "" || req.Connection == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()

	userID, team, err := s.userIdentity(ctx, token)
	switch {
	case err == nil:
	case errors.Is(err, ErrBadToken):
		http.Error(w, "token refused", http.StatusUnauthorized)
		return
	case errors.Is(err, ErrForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	default:
		http.Error(w, "unverifiable", http.StatusServiceUnavailable)
		return
	}
	// The workspace check is the workspace the app is installed in.
	wt, _ := s.resolved()
	if wt == "" {
		if err := s.Resolve(ctx); err != nil {
			http.Error(w, "unverifiable", http.StatusServiceUnavailable)
			return
		}
		wt, _ = s.resolved()
	}
	if wt == "" {
		http.Error(w, "unverifiable", http.StatusServiceUnavailable)
		return
	}
	if team == "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if team != wt {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// Guests and external (Slack Connect) users never route. users.info is
	// read with the bot token, which holds users:read; no email is read.
	// The name comes from here too, so identify needs no openid.connect
	// call for a user token.
	var info struct {
		User struct {
			Name              string `json:"name"`
			RealName          string `json:"real_name"`
			IsBot             bool   `json:"is_bot"`
			IsAppUser         bool   `json:"is_app_user"`
			IsRestricted      bool   `json:"is_restricted"`
			IsUltraRestricted bool   `json:"is_ultra_restricted"`
			IsStranger        bool   `json:"is_stranger"`
			TeamID            string `json:"team_id"`
		} `json:"user"`
	}
	if err := s.callForm(ctx, "users.info", string(s.botToken()), url.Values{"user": {userID}}, &info); err != nil {
		// The bot token cannot read the user, or Slack is unreachable:
		// treat as unverifiable, never as proof.
		http.Error(w, "unverifiable", http.StatusServiceUnavailable)
		return
	}
	if info.User.IsBot || info.User.IsAppUser || info.User.IsRestricted || info.User.IsUltraRestricted || info.User.IsStranger ||
		info.User.TeamID == "" || info.User.TeamID != wt {
		s.logger().Warn("slack identify refused", "connection", c.ID, "reason", "guest-external-or-wrong-team")
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if other, _ := s.Registry.ByUser("slack", userID); other != nil && other.ID != c.ID {
		s.logger().Warn("slack identify refused", "connection", c.ID, "reason", "already-bound")
		jsonError(w, http.StatusConflict, "already-bound")
		return
	}
	name := info.User.RealName
	if name == "" {
		name = info.User.Name
	}
	exp := s.Registry.Identify(c, "slack", userID, name, nil)
	s.logger().Info("slack identify", "connection", c.ID, "user", userID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(IdentifyResponse{
		User:      Person{ID: userID, Name: name},
		Teams:     []string{},
		Rejected:  []Rejected{},
		ExpiresAt: exp,
	})
}

// userIdentity reads the user and workspace a token proves. A user token
// (xoxp-, from the OAuth v2 sign-in) is read with auth.test. A still-valid
// OpenID Connect token from a sign-in before the change is read with
// openid.connect.userInfo, so identify accepts both. Any refusal from
// auth.test falls through to the OpenID path, whatever error Slack names;
// only a Slack that cannot be reached is returned as such, since the
// OpenID path would fail the same way. The user's name is read by the
// caller with the bot token's users:read.
func (s *Slack) userIdentity(ctx context.Context, token string) (userID, team string, err error) {
	var auth struct {
		OK     bool   `json:"ok"`
		UserID string `json:"user_id"`
		TeamID string `json:"team_id"`
	}
	err = s.call(ctx, "auth.test", token, nil, &auth)
	if err == nil && auth.UserID != "" && auth.TeamID != "" {
		return auth.UserID, auth.TeamID, nil
	}
	if errors.Is(err, ErrUnverifiable) {
		return "", "", err
	}
	return s.userInfo(ctx, token)
}

// userInfo reads an OpenID Connect token's own user with
// openid.connect.userInfo. Slack puts the workspace in
// https://slack.com/team_id, with a top-level team_id on some answers; an
// empty workspace is refused by the caller.
func (s *Slack) userInfo(ctx context.Context, token string) (userID, team string, err error) {
	var out struct {
		Sub    string `json:"sub"`
		UserID string `json:"https://slack.com/user_id"`
		TeamID string `json:"https://slack.com/team_id"`
		Team   string `json:"team_id"`
	}
	if err := s.call(ctx, "openid.connect.userInfo", token, nil, &out); err != nil {
		return "", "", err
	}
	userID = out.Sub
	if userID == "" {
		userID = out.UserID
	}
	if userID == "" {
		return "", "", ErrForbidden
	}
	team = out.TeamID
	if team == "" {
		team = out.Team
	}
	return userID, team, nil
}

// SlackBotChannelsResponse is the answer to GET /v1/slack/bot/channels:
// the ids of the channels the bot user is a member of, and nothing else.
// The picker uses it to flag channels bb still needs an invite to.
type SlackBotChannelsResponse struct {
	Channels []string `json:"channels"`
}

// handleBotChannels is GET /v1/slack/bot/channels on the cluster-only
// listener, beside the other subscriber calls. It answers the ids of the
// channels the bot is in, read with the bot token's users.conversations and
// cached for slackChannelsTTL.
func (s *Slack) handleBotChannels(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() || len(s.botToken()) == 0 {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	ids, err := s.botChannels(r.Context())
	if err != nil {
		s.slackFailed(w, "channels", "", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(SlackBotChannelsResponse{Channels: ids})
}

// botChannels lists the ids of the channels the bot user is a member of,
// paginating users.conversations with the bot token and caching the result
// for slackChannelsTTL. It returns ids only; no channel name or other
// detail is read. Public and private channels only: a DM is not a channel
// the picker maps.
func (s *Slack) botChannels(ctx context.Context) ([]string, error) {
	now := s.now()
	s.mu.Lock()
	if s.channels != nil && s.channelsExpires.After(now) {
		ids := append([]string(nil), s.channels...)
		s.mu.Unlock()
		return ids, nil
	}
	s.mu.Unlock()

	var ids []string
	cursor := ""
	for pages := 0; ; pages++ {
		if pages >= maxSlackChannelPages {
			s.logger().Warn("slack users.conversations: page cap reached", "pages", pages)
			break
		}
		params := url.Values{
			"types":            {"public_channel,private_channel"},
			"exclude_archived": {"true"},
			"limit":            {"200"},
		}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		var out struct {
			Channels []struct {
				ID string `json:"id"`
			} `json:"channels"`
			ResponseMetadata struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := s.callForm(ctx, "users.conversations", string(s.botToken()), params, &out); err != nil {
			return nil, err
		}
		for _, c := range out.Channels {
			if c.ID != "" {
				ids = append(ids, c.ID)
			}
		}
		cursor = out.ResponseMetadata.NextCursor
		if cursor == "" {
			break
		}
	}
	if ids == nil {
		ids = []string{}
	}
	s.mu.Lock()
	s.channels = ids
	s.channelsExpires = now.Add(slackChannelsTTL)
	s.mu.Unlock()
	return ids, nil
}

// SlackJoinRequest is the body of POST /v1/slack/bot/join: a pod asking
// the app's bot to join one channel, so the developer need not type
// /invite in Slack. The pod names its connection; the service checks the
// connection is live and identified, and joins with the bot token, which
// never leaves here.
type SlackJoinRequest struct {
	Connection string `json:"connection"`
	Channel    string `json:"channel"`
}

// slackChannelID is a public (C…) or private (G…) channel id. A name is
// refused: the picker stores ids, and conversations.join takes an id.
var slackChannelID = regexp.MustCompile(`^[CG][A-Z0-9]{1,40}$`)

// logJoinAttempt records one POST /v1/slack/bot/join attempt: the
// connection, the owner it proved (the Slack user id and display name),
// the channel id and the outcome. The whole line is run through RedactLine
// so a credential-shaped value could not survive in it; the bot token is
// never part of the line. It is called on every path, including refusals
// before any Slack call.
func (s *Slack) logJoinAttempt(connection, owner, ownerName, channel, outcome string) {
	s.logger().Info(sentryx.RedactLine(fmt.Sprintf(
		"slack join connection=%s owner=%s ownerName=%s channel=%s outcome=%s", connection, owner, ownerName, channel, outcome), 0))
}

// handleJoin is POST /v1/slack/bot/join on the cluster-only listener. It
// makes the bot join a public channel with conversations.join (bot scope
// channels:join). A private channel cannot be joined this way: Slack lets
// only a member invite a bot into one, so that answers 409
// {"error":"private-channel"} and the plugin tells the developer to
// /invite the app from Slack. A channel the bot is already in is a
// success. The bot's own self-join raises member_joined_channel, which the
// webhook drops, so no pod hears about a channel the settings page is
// already mapping.
func (s *Slack) handleJoin(w http.ResponseWriter, r *http.Request) {
	var req SlackJoinRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		s.logJoinAttempt("", "", "", "", "bad-request")
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Connection == "" || !slackChannelID.MatchString(req.Channel) {
		s.logJoinAttempt(req.Connection, "", "", req.Channel, "bad-request")
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.Enabled() || len(s.botToken()) == 0 {
		s.logJoinAttempt(req.Connection, "", "", req.Channel, "not-configured")
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		s.logJoinAttempt(req.Connection, "", "", req.Channel, "unknown-connection")
		unknownConnection(w)
		return
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		s.logJoinAttempt(c.ID, "", "", req.Channel, "not-identified")
		jsonError(w, http.StatusForbidden, "not-identified")
		return
	}
	owner, ownerName := id.User, id.Name
	// A hung Slack call must not hold the request open; identify bounds its
	// own Slack calls the same way.
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()
	var out struct {
		Warning string `json:"warning"`
	}
	err := s.callForm(ctx, "conversations.join", string(s.botToken()), url.Values{"channel": {req.Channel}}, &out)
	if err != nil {
		switch code := slackErrorCode(err); {
		case code == "method_not_supported_for_channel_type":
			// A private channel: only a member can invite the bot. It is
			// never retried another way.
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, "private-channel")
			jsonError(w, http.StatusConflict, "private-channel")
		case code == "channel_not_found":
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, "channel-not-found")
			jsonError(w, http.StatusNotFound, "channel-not-found")
		case code == "is_archived":
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, "archived")
			jsonError(w, http.StatusConflict, "archived")
		case slackChannelRestricted(code):
			// The channel does not let the app post, so a mention there
			// could never be answered. Refuse the join and name it, so the
			// settings page can warn instead of mapping a dead channel.
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, "channel-restricted")
			jsonError(w, http.StatusConflict, "channel-restricted")
		case code == "missing_scope":
			// The app was installed without channels:join; the README's
			// by-hand setup names it, and a reinstall grants it.
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, "missing-scope")
			jsonError(w, http.StatusServiceUnavailable, "missing-scope")
		default:
			outcome := "slack-refused"
			if errors.Is(err, ErrUnverifiable) || errors.Is(err, context.DeadlineExceeded) {
				outcome = "slack-unavailable"
			}
			s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, outcome)
			s.slackFailed(w, "join", c.ID, err)
		}
		return
	}
	outcome := "joined"
	if out.Warning == "already_in_channel" {
		outcome = "already-in"
	}
	s.logJoinAttempt(c.ID, owner, ownerName, req.Channel, outcome)
	// The cached membership list, if any, learns the channel at once, so
	// the picker's next read does not flag it for another few minutes. A
	// botChannels refresh that started before this join can still overwrite
	// it, but that self-heals within slackChannelsTTL and the plugin clears
	// its own flag on the success answer.
	s.mu.Lock()
	if s.channels != nil && !slices.Contains(s.channels, req.Channel) {
		s.channels = append(s.channels, req.Channel)
	}
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`+"\n")
}

// slackConversationsRequest is the body of POST /v1/slack/conversations: a
// connection, the opener text, and exactly one of users or channel.
type slackConversationsRequest struct {
	Connection string   `json:"connection"`
	Text       string   `json:"text"`
	Users      []string `json:"users,omitempty"`
	Channel    string   `json:"channel,omitempty"`
}

// slackConversationsResponse is the answer to an opened conversation: the
// session key and capability the plugin leases, the opener's permalink, the
// channel, and the resolved participants.
type slackConversationsResponse struct {
	Session      string               `json:"session"`
	Capability   string               `json:"capability"`
	Permalink    string               `json:"permalink"`
	Channel      string               `json:"channel"`
	Participants []slackUserCandidate `json:"participants"`
}

// slackUserCandidate is one resolved or candidate user in a conversation
// opener: the Slack id to act on, the name to show, and the Slack handle.
// It never carries an email. Handle is omitted when Slack sent none, so a
// candidate from before it existed is byte-identical.
type slackUserCandidate struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Handle string `json:"handle,omitempty"`
}

// slackUserEntry is one workspace user read from users.list: the fields the
// opener resolves names against and refuses guests, bots and strangers with.
// In memory only, cached for slackUserListTTL; it holds names only.
type slackUserEntry struct {
	ID                string
	Name              string // handle
	RealName          string
	DisplayName       string
	IsBot             bool
	IsAppUser         bool
	IsRestricted      bool
	IsUltraRestricted bool
	IsStranger        bool
	TeamID            string
}

// displayName is the name to show for a resolved user: the profile display
// name, then the real name, then the handle.
func (u slackUserEntry) displayName() string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	if u.RealName != "" {
		return u.RealName
	}
	return u.Name
}

// slackUserResolutionError is a refused users entry: unknown-user when
// nothing matched, ambiguous-user when several did, forbidden when the one
// match is a guest, a bot or a stranger. It carries the entry as given and
// the candidates for the reply body.
type slackUserResolutionError struct {
	Code       string
	Name       string
	Candidates []slackUserCandidate
}

func (e *slackUserResolutionError) Error() string { return e.Code }

// slackUsersListPage is the part of users.list this service reads.
type slackUsersListPage struct {
	Members []struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		RealName          string `json:"real_name"`
		Deleted           bool   `json:"deleted"`
		IsBot             bool   `json:"is_bot"`
		IsAppUser         bool   `json:"is_app_user"`
		IsRestricted      bool   `json:"is_restricted"`
		IsUltraRestricted bool   `json:"is_ultra_restricted"`
		IsStranger        bool   `json:"is_stranger"`
		TeamID            string `json:"team_id"`
		Profile           struct {
			DisplayName string `json:"display_name"`
			RealName    string `json:"real_name"`
		} `json:"profile"`
	} `json:"members"`
	ResponseMetadata struct {
		NextCursor string `json:"next_cursor"`
	} `json:"response_metadata"`
}

// handleConversations is POST /v1/slack/conversations on the cluster-only
// listener. A connection with a current Slack identity opens a 1:1 DM or a
// group DM with one or more users, or posts a new top-level message in a
// channel, as the app. It returns the session key and capability minted for
// the connection's owner, so the plugin leases the session exactly as after
// a wake. It authorizes its caller exactly as the reply endpoint does: a
// live connection that has identified, and nothing looser.
func (s *Slack) handleConversations(w http.ResponseWriter, r *http.Request) {
	var req slackConversationsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Connection == "" || strings.TrimSpace(req.Text) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Text) > slackReplyBody {
		http.Error(w, "body too long", http.StatusRequestEntityTooLarge)
		return
	}
	hasUsers, hasChannel := len(req.Users) > 0, req.Channel != ""
	if hasUsers == hasChannel {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if hasUsers && len(req.Users) > maxSlackConversationUsers {
		http.Error(w, "too many users", http.StatusRequestEntityTooLarge)
		return
	}
	if !s.Enabled() || len(s.botToken()) == 0 {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		jsonError(w, http.StatusForbidden, "not-identified")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), verifyTimeout)
	defer cancel()

	channel := req.Channel
	participants := []slackUserCandidate{}
	if hasChannel {
		if !slackChannelID.MatchString(channel) {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
	} else {
		resolved, err := s.resolveConversationUsers(ctx, req.Users)
		if err != nil {
			s.conversationResolveError(w, c.ID, err)
			return
		}
		channel, err = s.openConversation(ctx, resolved)
		if err != nil {
			s.conversationSlackError(w, c.ID, err)
			return
		}
		participants = resolved
	}
	ts, err := s.postMessageTS(ctx, channel, "", req.Text, nil)
	if err != nil {
		if slackErrorCode(err) == "not_in_channel" {
			jsonError(w, http.StatusConflict, "not-in-channel")
			return
		}
		s.conversationSlackError(w, c.ID, err)
		return
	}
	if ts == "" {
		s.slackFailed(w, "conversations", c.ID, fmt.Errorf("%w: chat.postMessage answered no ts", ErrUnverifiable))
		return
	}
	session := slackSession(channel, ts)
	s.rememberOpened(session, channel, id.User, c.ID)
	s.logger().Info("slack conversation opened", "connection", c.ID, "channel", channel, "session", session, "users", len(participants))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(slackConversationsResponse{
		Session:      session,
		Capability:   s.leaseCapability(session, id.User),
		Permalink:    s.messagePermalink(ctx, channel, ts),
		Channel:      channel,
		Participants: participants,
	})
}

// conversationResolveError answers a refused users list: 400 unknown-user or
// ambiguous-user with the entry and candidates, 403 forbidden for a guest, a
// bot or a stranger the way identify refuses one, and the usual Slack
// 502/503 for a failed users.list read.
func (s *Slack) conversationResolveError(w http.ResponseWriter, connection string, err error) {
	var ue *slackUserResolutionError
	if errors.As(err, &ue) {
		status := http.StatusBadRequest
		if ue.Code == "forbidden" {
			status = http.StatusForbidden
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": ue.Code, "name": ue.Name, "candidates": ue.Candidates,
		})
		return
	}
	s.conversationSlackError(w, connection, err)
}

// conversationSlackError answers a failed Slack call for an opener: 503
// missing-scope when the token lacks a needed scope, else the same 502/503
// as a reply.
func (s *Slack) conversationSlackError(w http.ResponseWriter, connection string, err error) {
	if errors.Is(err, errSlackMissingScope) || slackErrorCode(err) == "missing_scope" {
		jsonError(w, http.StatusServiceUnavailable, "missing-scope")
		return
	}
	s.slackFailed(w, "conversations", connection, err)
}

// workspaceUsers reads the workspace user list with users.list, cached for
// slackUserListTTL, for resolving a conversation opener's names. It follows
// the cursor in pages, bounded by maxSlackUserPages, and keeps the fields
// the opener classifies with. A deleted user is skipped. The bot token holds
// users:read; a token without it is errSlackMissingScope.
func (s *Slack) workspaceUsers(ctx context.Context) ([]slackUserEntry, error) {
	now := s.now()
	s.mu.Lock()
	if s.members != nil && s.membersExpires.After(now) {
		list := s.members
		s.mu.Unlock()
		return list, nil
	}
	s.mu.Unlock()
	var entries []slackUserEntry
	cursor := ""
	for page := 0; ; page++ {
		if page >= maxSlackUserPages {
			s.logger().Warn("slack users.list: page cap reached", "pages", page)
			break
		}
		params := url.Values{"limit": {"200"}}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		var out slackUsersListPage
		if err := s.callForm(ctx, "users.list", string(s.botToken()), params, &out); err != nil {
			if slackErrorCode(err) == "missing_scope" {
				return nil, errSlackMissingScope
			}
			return nil, err
		}
		for _, m := range out.Members {
			if m.ID == "" || m.Deleted {
				continue
			}
			realName := m.Profile.RealName
			if realName == "" {
				realName = m.RealName
			}
			entries = append(entries, slackUserEntry{
				ID: m.ID, Name: m.Name, RealName: realName,
				DisplayName: m.Profile.DisplayName,
				IsBot:       m.IsBot, IsAppUser: m.IsAppUser,
				IsRestricted: m.IsRestricted, IsUltraRestricted: m.IsUltraRestricted,
				IsStranger: m.IsStranger, TeamID: m.TeamID,
			})
		}
		cursor = out.ResponseMetadata.NextCursor
		if cursor == "" {
			break
		}
	}
	if entries == nil {
		entries = []slackUserEntry{}
	}
	s.mu.Lock()
	s.members = entries
	s.membersExpires = now.Add(slackUserListTTL)
	s.mu.Unlock()
	return entries, nil
}

// resolveConversationUsers resolves each entry of a conversation opener's
// users list to a workspace user. A Slack id, or a case-insensitive match on
// real name, display name or handle against users.list; an entry shaped like
// an email (it contains an "@" and a dot) is resolved with
// users.lookupByEmail instead, and the address is used for that one call and
// then forgotten: it is never cached, logged or carried on the answer. An
// entry that matches nothing is refused with up to maxSlackCandidates near
// matches (case-insensitive prefix or substring on the handle, real name or
// display name) as candidates; one that matches more than one user is refused
// with every match. A guest, a Slack Connect stranger or a bot is refused as
// identify refuses one.
func (s *Slack) resolveConversationUsers(ctx context.Context, entries []string) ([]slackUserCandidate, error) {
	team, _ := s.resolved()
	if team == "" {
		if err := s.Resolve(ctx); err != nil {
			return nil, err
		}
		team, _ = s.resolved()
	}
	if team == "" {
		return nil, ErrDisabled
	}
	// The member list is read once, and only when a name entry needs it: an
	// email resolves without it.
	var (
		list   []slackUserEntry
		loaded bool
	)
	workspace := func() ([]slackUserEntry, error) {
		if loaded {
			return list, nil
		}
		l, err := s.workspaceUsers(ctx)
		if err != nil {
			return nil, err
		}
		list, loaded = l, true
		return list, nil
	}
	seen := map[string]bool{}
	out := []slackUserCandidate{}
	for _, raw := range entries {
		name := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "@"))
		if name == "" {
			return nil, &slackUserResolutionError{Code: "unknown-user", Name: raw, Candidates: []slackUserCandidate{}}
		}
		var cand slackUserCandidate
		if slackEmailShape(name) {
			got, err := s.resolveEmailEntry(ctx, name, team)
			if err != nil {
				return nil, err
			}
			cand = got
		} else {
			members, err := workspace()
			if err != nil {
				return nil, err
			}
			u, err := resolveNameEntry(members, raw, name, team)
			if err != nil {
				return nil, err
			}
			cand = slackUserCandidate{ID: u.ID, Name: u.displayName(), Handle: u.Name}
		}
		if !seen[cand.ID] {
			seen[cand.ID] = true
			out = append(out, cand)
		}
	}
	return out, nil
}

// resolveEmailEntry resolves one email-shaped opener entry with
// users.lookupByEmail and applies the same guest/bot/stranger/foreign-team
// refusals as a name. The address is never echoed back on a refusal: it is
// used for the one Slack call and forgotten.
func (s *Slack) resolveEmailEntry(ctx context.Context, email, team string) (slackUserCandidate, error) {
	u, err := s.lookupUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, errSlackMissingScope) {
			return slackUserCandidate{}, errSlackMissingScope
		}
		if slackErrorCode(err) == "users_not_found" {
			return slackUserCandidate{}, &slackUserResolutionError{Code: "unknown-user", Candidates: []slackUserCandidate{}}
		}
		return slackUserCandidate{}, err
	}
	if slackUserRefused(u, team) {
		return slackUserCandidate{}, &slackUserResolutionError{Code: "forbidden", Candidates: []slackUserCandidate{}}
	}
	return slackUserCandidate{ID: u.ID, Name: u.displayName(), Handle: u.Name}, nil
}

// resolveNameEntry resolves one non-email opener entry against the cached
// member list: a Slack id, then an exact case-insensitive match on handle,
// real name or display name. Nothing matched is unknown-user with the near
// matches as candidates; several matches is ambiguous-user with every one.
// raw is the entry as given, echoed back on a refusal; name is the trimmed
// term the near matches search with.
func resolveNameEntry(list []slackUserEntry, raw, name, team string) (slackUserEntry, error) {
	var matches []slackUserEntry
	for _, u := range list {
		if u.ID == name {
			matches = append(matches, u)
			break
		}
	}
	if len(matches) == 0 {
		lower := strings.ToLower(name)
		for _, u := range list {
			if strings.ToLower(u.Name) == lower || strings.ToLower(u.RealName) == lower || strings.ToLower(u.DisplayName) == lower {
				matches = append(matches, u)
			}
		}
	}
	switch len(matches) {
	case 0:
		return slackUserEntry{}, &slackUserResolutionError{Code: "unknown-user", Name: raw, Candidates: slackNearMatches(list, name, team)}
	case 1:
	default:
		cands := make([]slackUserCandidate, 0, len(matches))
		for _, u := range matches {
			cands = append(cands, slackUserCandidate{ID: u.ID, Name: u.displayName(), Handle: u.Name})
		}
		return slackUserEntry{}, &slackUserResolutionError{Code: "ambiguous-user", Name: raw, Candidates: cands}
	}
	u := matches[0]
	if slackUserRefused(u, team) {
		return slackUserEntry{}, &slackUserResolutionError{Code: "forbidden", Name: raw, Candidates: []slackUserCandidate{}}
	}
	return u, nil
}

// slackEmailShape reports whether a conversation opener's user entry is
// shaped like an email address: it contains an "@" and a dot. The value is
// used for one users.lookupByEmail call and then forgotten; it is never
// cached or logged.
func slackEmailShape(s string) bool {
	return strings.Contains(s, "@") && strings.Contains(s, ".")
}

// slackUserRefused reports whether a resolved user can never be a
// conversation target: a bot, an app user, a guest, a Slack Connect stranger
// or a member of another workspace.
func slackUserRefused(u slackUserEntry, team string) bool {
	return u.IsBot || u.IsAppUser || u.IsRestricted || u.IsUltraRestricted || u.IsStranger || u.TeamID == "" || u.TeamID != team
}

// slackNearMatches returns up to maxSlackCandidates workspace users whose
// handle, real name or display name contains term, case-insensitively (a
// prefix is a substring). Users who can never be a conversation target are
// left out, and a candidate carries the name and handle only, never an
// email.
func slackNearMatches(list []slackUserEntry, term, team string) []slackUserCandidate {
	lower := strings.ToLower(term)
	out := []slackUserCandidate{}
	for _, u := range list {
		if slackUserRefused(u, team) {
			continue
		}
		if !strings.Contains(strings.ToLower(u.Name), lower) &&
			!strings.Contains(strings.ToLower(u.RealName), lower) &&
			!strings.Contains(strings.ToLower(u.DisplayName), lower) {
			continue
		}
		out = append(out, slackUserCandidate{ID: u.ID, Name: u.displayName(), Handle: u.Name})
		if len(out) >= maxSlackCandidates {
			break
		}
	}
	return out
}

// slackLookupByEmailUser is the part of users.lookupByEmail this service
// reads: the same user object users.list carries, so the opener classifies
// it identically.
type slackLookupByEmailUser struct {
	User struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		RealName          string `json:"real_name"`
		Deleted           bool   `json:"deleted"`
		IsBot             bool   `json:"is_bot"`
		IsAppUser         bool   `json:"is_app_user"`
		IsRestricted      bool   `json:"is_restricted"`
		IsUltraRestricted bool   `json:"is_ultra_restricted"`
		IsStranger        bool   `json:"is_stranger"`
		TeamID            string `json:"team_id"`
		Profile           struct {
			DisplayName string `json:"display_name"`
			RealName    string `json:"real_name"`
		} `json:"profile"`
	} `json:"user"`
}

// lookupUserByEmail resolves an email address to a workspace user with
// users.lookupByEmail, the bot scope users:read.email. The address is used
// for the one call and then forgotten: it is never cached, logged or stored.
// A token without the scope is errSlackMissingScope; an address Slack does
// not know is users_not_found.
func (s *Slack) lookupUserByEmail(ctx context.Context, email string) (slackUserEntry, error) {
	var out slackLookupByEmailUser
	if err := s.callForm(ctx, "users.lookupByEmail", string(s.botToken()), url.Values{"email": {email}}, &out); err != nil {
		if slackErrorCode(err) == "missing_scope" {
			return slackUserEntry{}, errSlackMissingScope
		}
		return slackUserEntry{}, err
	}
	m := out.User
	if m.ID == "" || m.Deleted {
		return slackUserEntry{}, &slackAPIError{Code: "users_not_found"}
	}
	realName := m.Profile.RealName
	if realName == "" {
		realName = m.RealName
	}
	return slackUserEntry{
		ID: m.ID, Name: m.Name, RealName: realName,
		DisplayName: m.Profile.DisplayName,
		IsBot:       m.IsBot, IsAppUser: m.IsAppUser,
		IsRestricted: m.IsRestricted, IsUltraRestricted: m.IsUltraRestricted,
		IsStranger: m.IsStranger, TeamID: m.TeamID,
	}, nil
}

// openConversation opens the DM (one user, im:write) or group DM (several,
// mpim:write) with conversations.open and returns its channel id. A missing
// scope is errSlackMissingScope, so the handler answers 503 missing-scope.
func (s *Slack) openConversation(ctx context.Context, users []slackUserCandidate) (string, error) {
	ids := make([]string, 0, len(users))
	for _, u := range users {
		ids = append(ids, u.ID)
	}
	var out struct {
		Channel struct {
			ID string `json:"id"`
		} `json:"channel"`
	}
	err := s.callForm(ctx, "conversations.open", string(s.botToken()), url.Values{"users": {strings.Join(ids, ",")}}, &out)
	if err != nil {
		if slackErrorCode(err) == "missing_scope" {
			return "", errSlackMissingScope
		}
		return "", err
	}
	if out.Channel.ID == "" {
		return "", fmt.Errorf("%w: conversations.open answered no channel", ErrUnverifiable)
	}
	return out.Channel.ID, nil
}

// messagePermalink reads a message's permalink with chat.getPermalink. A
// failure is logged and answers empty rather than failing the opener: the
// conversation is already open, and a retry would post the opener twice.
func (s *Slack) messagePermalink(ctx context.Context, channel, ts string) string {
	var out struct {
		Permalink string `json:"permalink"`
	}
	if err := s.callForm(ctx, "chat.getPermalink", string(s.botToken()), url.Values{"channel": {channel}, "message_ts": {ts}}, &out); err != nil {
		s.logger().Warn("slack permalink lookup failed", "channel", channel, "err", err)
		return ""
	}
	return out.Permalink
}

// errSlackMissingScope marks a Slack file fetch refused because the bot
// token lacks files:read. The handler answers 503 missing-scope, as the join
// endpoint does.
var errSlackMissingScope = errors.New("slack missing scope")

// handleFile is GET /v1/slack/sessions/{session}/files/{id} on the
// cluster-only listener. It is gated exactly like a reply: the connection must
// have a current Slack identity and the session must be held by that user. The
// file id must have been seen on a wake routed to that session; anything else
// is 404. The bytes are streamed from Slack's url_private with the bot token,
// never written to disk and never logged, and the size limits are enforced
// server-side: an image up to 10 MiB, a text-like file up to 1 MiB, else 413
// or 415. A token without files:read is 503 missing-scope.
func (s *Slack) handleFile(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	if _, _, ok := splitSlackSession(session); !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	fileID := r.PathValue("id")
	connection := r.URL.Query().Get("connection")
	if fileID == "" || connection == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.Enabled() || len(s.botToken()) == 0 {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		jsonError(w, http.StatusForbidden, "not-identified")
		return
	}
	if !s.allowed(session, id.User) {
		s.logger().Warn("slack file refused: session not routed here", "connection", c.ID)
		jsonError(w, http.StatusForbidden, "not-routed")
		return
	}
	ref, ok := s.fileRef(session, fileID)
	if !ok {
		s.logger().Warn("slack file refused: id not seen on a wake", "connection", c.ID)
		jsonError(w, http.StatusNotFound, "not-found")
		return
	}
	limit, ok := slackFileLimit(ref.mimeType, ref.filetype)
	if !ok {
		jsonError(w, http.StatusUnsupportedMediaType, "unsupported-type")
		return
	}
	if ref.size > limit {
		jsonError(w, http.StatusRequestEntityTooLarge, "too-large")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), slackFileFetchTimeout)
	defer cancel()
	body, err := s.fetchFile(ctx, fileID, ref.url)
	if err != nil {
		if errors.Is(err, errSlackMissingScope) {
			jsonError(w, http.StatusServiceUnavailable, "missing-scope")
			return
		}
		s.slackFailed(w, "file", c.ID, err)
		return
	}
	defer body.Close()
	// Read at most one byte past the cap, so a body larger than Slack declared
	// is refused rather than streamed past the limit. The cap is at most
	// 10 MiB, so the read is bounded in memory; nothing is written to disk.
	buf, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		s.slackFailed(w, "file", c.ID, err)
		return
	}
	if int64(len(buf)) > limit {
		jsonError(w, http.StatusRequestEntityTooLarge, "too-large")
		return
	}
	w.Header().Set("Content-Type", slackFileContentType(ref.mimeType))
	w.Header().Set("Content-Length", strconv.Itoa(len(buf)))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf)
	s.logger().Info("slack file served", "connection", c.ID, "size", len(buf))
}

// slackFileContentType is the Content-Type for a served file. A file admitted
// through the code-filetype fallback has no usable mime type, so it defaults
// to text/plain rather than an empty header that also suppresses sniffing.
func slackFileContentType(mimeType string) string {
	if strings.TrimSpace(mimeType) == "" {
		return "text/plain; charset=utf-8"
	}
	return mimeType
}

// fetchFile streams one file from its Slack url_private with the bot token.
// It returns the body for the caller to copy and close; neither the URL nor
// the bytes are logged. A refusal that names a missing files:read scope is
// errSlackMissingScope, so the handler can answer 503 missing-scope.
func (s *Slack) fetchFile(ctx context.Context, id, rawURL string) (io.ReadCloser, error) {
	if rawURL == "" {
		return nil, fmt.Errorf("%w: no url", ErrUnverifiable)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	req.Header.Set("Authorization", "Bearer "+string(s.botToken()))
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	if resp.StatusCode == http.StatusOK {
		return resp.Body, nil
	}
	defer resp.Body.Close()
	// A small slice of the refusal is enough to recognize a missing scope; it
	// is never logged.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	return nil, s.fileRefusal(ctx, id, resp.StatusCode, raw)
}

// fileRefusal classifies a non-200 answer from a file fetch. The file host
// answers missing_scope in its body when it does; when it answers an HTML
// 401/403 instead, files.info gives the same refusal as a Slack error code.
// Neither the body nor the URL is logged.
func (s *Slack) fileRefusal(ctx context.Context, id string, status int, raw []byte) error {
	if bytes.Contains(bytes.ToLower(raw), []byte("missing_scope")) {
		return errSlackMissingScope
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		var out struct{}
		err := s.callForm(ctx, "files.info", string(s.botToken()), url.Values{"file": {id}}, &out)
		switch code := slackErrorCode(err); {
		case code == "missing_scope":
			return errSlackMissingScope
		case code == "file_not_found" || code == "file_deleted":
			return fmt.Errorf("%w: %s", ErrForbidden, code)
		}
	}
	if status >= 500 || status == http.StatusTooManyRequests {
		return fmt.Errorf("%w: status %d", ErrUnverifiable, status)
	}
	return fmt.Errorf("%w: status %d", ErrForbidden, status)
}

// SigninStartRequest is the body of POST /v1/slack/signin/start.
type SigninStartRequest struct {
	Connection string `json:"connection"`
}

// SigninStartResponse answers a sign-in start.
type SigninStartResponse struct {
	AuthorizeURL string `json:"authorizeUrl"`
	State        string `json:"state"`
}

// SigninExchangeRequest is the body of POST /v1/slack/signin/exchange.
// The plugin on the pod receives code and state on its own callback URL
// (behind tsjwt, so only the server of whoever completed sign-in is hit)
// and passes them here with its connection.
type SigninExchangeRequest struct {
	Connection string `json:"connection"`
	State      string `json:"state"`
	Code       string `json:"code"`
}

// SigninExchangeResponse answers a successful exchange. The token is
// returned in this response only, and the service keeps nothing after it.
type SigninExchangeResponse struct {
	Token string `json:"token"`
}

func (s *Slack) handleSigninStart(w http.ResponseWriter, r *http.Request) {
	var req SigninStartRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Connection == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.signinEnabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	state, err := randomToken(32)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	verifier, err := randomToken(48)
	if err != nil {
		http.Error(w, "error", http.StatusInternalServerError)
		return
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	now := s.now()
	s.mu.Lock()
	if s.flows == nil {
		s.flows = map[string]*SlackSigninFlow{}
	}
	for k, f := range s.flows {
		if !f.Expires.After(now) || len(s.flows) > maxSlackSigninFlows {
			delete(s.flows, k)
		}
	}
	s.flows[state] = &SlackSigninFlow{Connection: req.Connection, Verifier: verifier, Expires: now.Add(SlackSigninTTL)}
	s.mu.Unlock()

	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {s.ClientID},
		"user_scope":            {slackUserScope},
		"redirect_uri":          {s.RedirectURL},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	s.logger().Info("slack signin started", "connection", c.ID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(SigninStartResponse{AuthorizeURL: s.authorizeURL() + "?" + q.Encode(), State: state})
}

// handleSigninExchange is POST /v1/slack/signin/exchange on the
// cluster-only listener. The state is consumed only when its connection is
// the caller's connection: a different connection is refused without
// consuming it, so the server that started the flow can still complete it.
// The code is exchanged with the client secret and the held PKCE verifier,
// and the token is returned in this response only. The service keeps
// nothing after it.
func (s *Slack) handleSigninExchange(w http.ResponseWriter, r *http.Request) {
	var req SigninExchangeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Connection == "" || req.State == "" || req.Code == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !s.signinEnabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	if s.Registry.Get(req.Connection) == nil {
		unknownConnection(w)
		return
	}
	now := s.now()
	s.mu.Lock()
	flow := s.flows[req.State]
	if flow == nil || !flow.Expires.After(now) {
		if flow != nil {
			delete(s.flows, req.State)
		}
		s.mu.Unlock()
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if flow.Connection != req.Connection {
		// Refuse without consuming: the flow belongs to another
		// connection, which must still be able to exchange it.
		s.mu.Unlock()
		jsonError(w, http.StatusForbidden, "not-yours")
		return
	}
	if flow.Used {
		s.mu.Unlock()
		jsonError(w, http.StatusConflict, "already-used")
		return
	}
	// Single use: consume the state before the exchange.
	flow.Used = true
	verifier := flow.Verifier
	s.mu.Unlock()

	token, err := s.exchange(r.Context(), req.Code, verifier)
	s.mu.Lock()
	delete(s.flows, req.State)
	s.mu.Unlock()
	if err != nil {
		s.logger().Warn("slack signin exchange failed", "connection", req.Connection, "err", err)
		s.slackFailed(w, "signin", req.Connection, err)
		return
	}
	s.logger().Info("slack signin exchanged", "connection", req.Connection)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(SigninExchangeResponse{Token: token})
}

// exchange swaps the authorization code for the user token at Slack's
// OpenID Connect token endpoint, with the client secret and the PKCE
// verifier. Neither the code, the verifier, the secret nor the token is
// logged.
func (s *Slack) exchange(ctx context.Context, code, verifier string) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {s.ClientID},
		"client_secret": {s.clientSecret()},
		"code":          {code},
		"redirect_uri":  {s.RedirectURL},
		"code_verifier": {verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURL(), strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := s.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnverifiable, transportCause(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrUnverifiable, err)
	}
	var out struct {
		OK          bool   `json:"ok"`
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		// AuthedUser is the developer's own token from an OAuth v2
		// exchange. The top-level access_token is the bot token and is
		// not requested here: the sign-in asks only for user_scope, so
		// the user token is what the plugin keeps.
		AuthedUser struct {
			ID          string `json:"id"`
			AccessToken string `json:"access_token"`
			Scope       string `json:"scope"`
		} `json:"authed_user"`
		Team struct {
			ID string `json:"id"`
		} `json:"team"`
	}
	_ = json.Unmarshal(raw, &out)
	switch {
	case resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests:
		return "", fmt.Errorf("%w: status %d", ErrUnverifiable, resp.StatusCode)
	case resp.StatusCode >= 400 || !out.OK:
		return "", fmt.Errorf("%w: slack oauth %s", ErrForbidden, out.Error)
	case out.AuthedUser.AccessToken == "":
		// A workspace that granted no user scope, or a bot-only answer:
		// there is no user token to keep.
		return "", fmt.Errorf("%w: slack oauth no user token", ErrForbidden)
	}
	return out.AuthedUser.AccessToken, nil
}

// slackReplyRequest is the body of the three session endpoints.
type slackReplyRequest struct {
	Connection string `json:"connection"`
	Text       string `json:"text,omitempty"`
	Status     string `json:"status,omitempty"`
	Title      string `json:"title,omitempty"`
}

// authorize checks that the connection may act on the session: it has a
// current Slack identity and the session was routed to it, and returns the
// decoded request.
func (s *Slack) authorize(w http.ResponseWriter, r *http.Request) (*Conn, string, string, slackReplyRequest, bool) {
	session := r.PathValue("session")
	channel, thread, ok := splitSlackSession(session)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return nil, "", "", slackReplyRequest{}, false
	}
	var req slackReplyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return nil, "", "", slackReplyRequest{}, false
	}
	if req.Connection == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return nil, "", "", slackReplyRequest{}, false
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return nil, "", "", slackReplyRequest{}, false
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		jsonError(w, http.StatusForbidden, "not-identified")
		return nil, "", "", slackReplyRequest{}, false
	}
	if !s.allowed(session, id.User) {
		s.logger().Warn("slack reply refused: session not routed here", "connection", c.ID, "session", session, "user", id.User)
		jsonError(w, http.StatusForbidden, "not-routed")
		return nil, "", "", slackReplyRequest{}, false
	}
	return c, channel, thread, req, true
}

// handleReply is POST /v1/slack/sessions/{session}/message: post the reply
// as the app. The request carries only the connection id and the text.
func (s *Slack) handleReply(w http.ResponseWriter, r *http.Request) {
	c, channel, thread, req, ok := s.authorize(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Text) > slackReplyBody {
		http.Error(w, "body too long", http.StatusRequestEntityTooLarge)
		return
	}
	if err := s.postMessage(r.Context(), channel, thread, req.Text, nil); err != nil {
		if errors.Is(err, errSlackChannelRestricted) {
			s.replyEphemeral(w, r, c, channel, req.Text)
			return
		}
		s.slackFailed(w, "reply", c.ID, err)
		return
	}
	s.logger().Info("slack reply", "connection", c.ID, "session", r.PathValue("session"), "textLen", len(req.Text))
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`+"\n")
}

// replyEphemeral is the fallback for a reply the channel refused because it
// does not let the app post. It posts the text as an ephemeral message to
// the connection's own bound user, after authorize has already checked that
// the session is held by that user, and answers the pod. The message goes
// only to the person the reply was for. A failed fallback answers the same
// 502 as any other Slack refusal, under the channel-restricted code.
func (s *Slack) replyEphemeral(w http.ResponseWriter, r *http.Request, c *Conn, channel, text string) {
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		// authorize proved the identity moments ago; a race here is a
		// connection that just went away, so refuse rather than guess.
		s.logger().Warn("slack: reply fallback not posted: connection is not identified", "connection", c.ID)
		jsonError(w, http.StatusBadGateway, "channel-restricted")
		return
	}
	if err := s.postEphemeral(r.Context(), channel, id.User, text+"\n"+slackChannelRestrictedNote, nil); err != nil {
		s.logger().Warn("slack: reply fallback not posted", "connection", c.ID, "err", err)
		jsonError(w, http.StatusBadGateway, "channel-restricted")
		return
	}
	s.logger().Info("slack reply", "connection", c.ID, "session", r.PathValue("session"), "textLen", len(text), "ephemeral", true)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true,"ephemeral":true,"reason":"channel-restricted"}`+"\n")
}

// handleStatus is POST /v1/slack/sessions/{session}/status: the thinking
// indicator (assistant.threads.setStatus).
func (s *Slack) handleStatus(w http.ResponseWriter, r *http.Request) {
	c, channel, thread, req, ok := s.authorize(w, r)
	if !ok {
		return
	}
	if len(req.Status) > 256 {
		http.Error(w, "status too long", http.StatusBadRequest)
		return
	}
	payload := map[string]any{"channel_id": channel, "thread_ts": thread, "status": req.Status}
	if err := s.call(r.Context(), "assistant.threads.setStatus", string(s.botToken()), payload, nil); err != nil {
		s.slackFailed(w, "status", c.ID, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`+"\n")
}

// handleTitle is POST /v1/slack/sessions/{session}/title: the conversation
// title (assistant.threads.setTitle).
func (s *Slack) handleTitle(w http.ResponseWriter, r *http.Request) {
	c, channel, thread, req, ok := s.authorize(w, r)
	if !ok {
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Title) > 256 {
		http.Error(w, "title too long", http.StatusBadRequest)
		return
	}
	payload := map[string]any{"channel_id": channel, "thread_ts": thread, "title": req.Title}
	if err := s.call(r.Context(), "assistant.threads.setTitle", string(s.botToken()), payload, nil); err != nil {
		s.slackFailed(w, "title", c.ID, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`+"\n")
}

// slackEphemeralRequest is the body of POST /v1/slack/ephemeral. The
// connection may post only to its own bound user and only in a channel a
// wake already delivered to it; both are checked, so this cannot be used as
// a general post-as-the-app endpoint.
type slackEphemeralRequest struct {
	Connection string          `json:"connection"`
	Channel    string          `json:"channel"`
	User       string          `json:"user"`
	Text       string          `json:"text,omitempty"`
	Blocks     json.RawMessage `json:"blocks,omitempty"`
}

// handleEphemeral is POST /v1/slack/ephemeral on the cluster-only listener:
// post an ephemeral message, visible only to the connection's own bound
// user, in a channel a wake delivered to that connection.
func (s *Slack) handleEphemeral(w http.ResponseWriter, r *http.Request) {
	var req slackEphemeralRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Connection == "" || req.Channel == "" || req.User == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Text) == "" && len(req.Blocks) == 0 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Text) > slackReplyBody || len(req.Blocks) > slackReplyBody {
		http.Error(w, "body too long", http.StatusRequestEntityTooLarge)
		return
	}
	if len(req.Blocks) > 0 && !json.Valid(req.Blocks) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	c := s.Registry.Get(req.Connection)
	if c == nil {
		unknownConnection(w)
		return
	}
	id, ok := s.Registry.IdentityOf(c, "slack")
	if !ok {
		jsonError(w, http.StatusForbidden, "not-identified")
		return
	}
	// The connection posts only to its own bound user: naming another user
	// is refused, so a pod cannot use this to message someone else.
	if req.User != id.User {
		s.logger().Warn("slack ephemeral refused: not the connection's user", "connection", c.ID)
		jsonError(w, http.StatusForbidden, "not-yours")
		return
	}
	// And only in a channel a wake delivered to this connection.
	if !s.allowedChannel(c.ID, req.Channel) {
		s.logger().Warn("slack ephemeral refused: channel not routed here", "connection", c.ID, "channel", req.Channel)
		jsonError(w, http.StatusForbidden, "not-routed")
		return
	}
	if err := s.postEphemeral(r.Context(), req.Channel, id.User, req.Text, req.Blocks); err != nil {
		s.slackFailed(w, "ephemeral", c.ID, err)
		return
	}
	s.logger().Info("slack ephemeral", "connection", c.ID, "channel", req.Channel, "textLen", len(req.Text))
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true}`+"\n")
}

// slackInteraction is the subset of a Block Kit interactivity payload this
// service reads. Slack POSTs it form-encoded as a `payload` field.
type slackInteraction struct {
	Type        string `json:"type"`
	ResponseURL string `json:"response_url"`
	User        struct {
		ID string `json:"id"`
	} `json:"user"`
	Channel struct {
		ID string `json:"id"`
	} `json:"channel"`
	Container struct {
		ChannelID string `json:"channel_id"`
	} `json:"container"`
	Actions []struct {
		ActionID string `json:"action_id"`
		Value    string `json:"value"`
		// A static_select carries its choice here and has no top-level
		// value; a button carries Value. SelectedOption is read only when
		// Value is empty.
		SelectedOption struct {
			Value string `json:"value"`
		} `json:"selected_option"`
	} `json:"actions"`
}

// HandleInteractivity is POST /slack/interactivity on the public listener.
// It verifies a Block Kit interactivity delivery with the same signing
// secret and timestamp window as /slack, and routes a block_actions payload
// to the clicking user's server as a session wake. The payload's user.id is
// the only identity it routes on; guests and external users are refused as
// they are at identify.
func (s *Slack) HandleInteractivity(w http.ResponseWriter, r *http.Request) {
	if !s.Enabled() {
		http.Error(w, "not configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.verify(r, body); err != nil {
		s.logger().Warn("slack interactivity refused", "status", 401, "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	raw := form.Get("payload")
	if raw == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var p slackInteraction
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if p.Type != "block_actions" || p.User.ID == "" {
		// Acknowledged and dropped: not an interaction this service routes.
		w.WriteHeader(http.StatusOK)
		return
	}
	channel := p.Channel.ID
	if channel == "" {
		channel = p.Container.ChannelID
	}
	if channel == "" || len(p.Actions) == 0 {
		w.WriteHeader(http.StatusOK)
		return
	}
	// Ack at once: Slack's interactivity budget is about three seconds, and
	// the membership check below is a Slack API call. The click is routed
	// after the 200, exactly as /slack routes after its own.
	w.WriteHeader(http.StatusOK)
	action := p.Actions[0]
	value := action.Value
	if value == "" {
		// A dropdown (static_select) interaction sends the choice as
		// actions[0].selected_option.value and no top-level value; a
		// button sends actions[0].value. Prefer the button's value and
		// fall back to the select's.
		value = action.SelectedOption.Value
	}
	go s.routeBlockAction(p.User.ID, channel, action.ActionID, value, p.ResponseURL)
}

// routeBlockAction refuses guests and external (Slack Connect) users with
// the same check identify applies, then routes the click to the clicking
// user's server. It runs after the interactivity 200; a refused or
// unverifiable click is dropped without a reply.
func (s *Slack) routeBlockAction(user, channel, actionID, value, responseURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), verifyTimeout)
	defer cancel()
	allowed, err := s.memberOfWorkspace(ctx, user)
	if err != nil {
		s.logger().Warn("slack interactivity dropped", "reason", "unverifiable", "err", err)
		return
	}
	if !allowed {
		s.logger().Warn("slack interactivity dropped", "reason", "guest-external-or-wrong-team")
		return
	}
	s.route(slackRouted{
		Action:      "block_action",
		Tagged:      true,
		Channel:     channel,
		User:        user,
		ActionID:    actionID,
		Value:       value,
		ResponseURL: responseURL,
		Silent:      true,
		At:          s.now(),
	})
}

// memberOfWorkspace reports whether userID is a non-guest member of the
// app's workspace, the same check identify applies, read with the bot
// token's users:read. It never trusts the payload's own claims about the
// user.
func (s *Slack) memberOfWorkspace(ctx context.Context, userID string) (bool, error) {
	class, err := s.classifyAsk(ctx, userID)
	if err != nil {
		return false, err
	}
	return class == slackAskMember, nil
}

// classifyAsk reads userID with the bot token's users:read and returns what
// the asker is: a member, a guest, or a stranger (a Slack Connect external
// user, a bot or app user, or a user from another workspace). It is the same
// users.info check identify and the block_action path apply. An error means
// Slack could not be read, and the caller falls back to the member reply so
// a transient failure never silences a teammate.
func (s *Slack) classifyAsk(ctx context.Context, userID string) (slackAskClass, error) {
	wt, _ := s.resolved()
	if wt == "" {
		if err := s.Resolve(ctx); err != nil {
			return slackAskMember, err
		}
		wt, _ = s.resolved()
	}
	if wt == "" {
		return slackAskMember, ErrDisabled
	}
	var info struct {
		User struct {
			IsBot             bool   `json:"is_bot"`
			IsAppUser         bool   `json:"is_app_user"`
			IsRestricted      bool   `json:"is_restricted"`
			IsUltraRestricted bool   `json:"is_ultra_restricted"`
			IsStranger        bool   `json:"is_stranger"`
			TeamID            string `json:"team_id"`
		} `json:"user"`
	}
	if err := s.callForm(ctx, "users.info", string(s.botToken()), url.Values{"user": {userID}}, &info); err != nil {
		return slackAskMember, err
	}
	switch {
	case info.User.IsBot || info.User.IsAppUser:
		return slackAskStranger, nil
	case info.User.IsRestricted || info.User.IsUltraRestricted:
		return slackAskGuest, nil
	case info.User.IsStranger || info.User.TeamID == "" || info.User.TeamID != wt:
		return slackAskStranger, nil
	}
	return slackAskMember, nil
}

// slackFailed answers a Slack post that failed without passing on what
// Slack said.
func (s *Slack) slackFailed(w http.ResponseWriter, op, connection string, err error) {
	s.logger().Warn("slack "+op+" failed", "connection", connection, "err", err)
	if errors.Is(err, ErrUnverifiable) || errors.Is(err, context.DeadlineExceeded) {
		jsonError(w, http.StatusServiceUnavailable, "slack-unavailable")
		return
	}
	jsonError(w, http.StatusBadGateway, "slack-refused")
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
