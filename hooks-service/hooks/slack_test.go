package hooks

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The Slack fixtures' credentials. None of these ever appears in a pod or a
// log; the tests assert that.
const (
	slackTeam       = "T-bb"
	slackApp        = "A-bb"
	slackBotID      = "B-bb"
	slackBotUser    = "U-bb"
	slackBotToken   = "xoxb-SEALED-bot"
	slackSigningKey = "sign-SEALED-secret"
	slackClientID   = "123.456"
	slackClientSec  = "client-SEALED-secret"
	slackRedirect   = "https://bb.example.com/api/v1/plugins/slack/http/signin/callback"
	slackPublicBase = "https://bb.example.com"
)

type fakeSlackUser struct {
	ID                string
	TeamID            string
	Name              string
	RealName          string
	DisplayName       string
	Email             string
	IsRestricted      bool
	IsUltraRestricted bool
	IsStranger        bool
	IsBot             bool
	IsAppUser         bool
}

type fakeSlackCode struct {
	challenge string
	access    string
	user      fakeSlackUser
}

type slackMessage struct {
	Channel  string `json:"channel"`
	ThreadTS string `json:"thread_ts"`
	Text     string `json:"text"`
	Blocks   any    `json:"blocks"`
}

// slackEphemeral records one chat.postEphemeral call.
type slackEphemeral struct {
	Channel string
	User    string
	Text    string
	Blocks  any
}

type slackStatus struct {
	ChannelID string `json:"channel_id"`
	ThreadTS  string `json:"thread_ts"`
	Status    string `json:"status"`
}

type slackTitle struct {
	ChannelID string `json:"channel_id"`
	ThreadTS  string `json:"thread_ts"`
	Title     string `json:"title"`
}

// fakeSlack stands in for slack.com: it issues OIDC codes bound to a PKCE
// challenge, exchanges them only with the right verifier, answers userInfo
// and users.info, and records every post. It records every credential it
// saw so a test can prove none reached the wrong side.
type fakeSlack struct {
	mu            sync.Mutex
	teamID        string
	appID         string
	botID         string
	botUserID     string
	botToken      string
	clientID      string
	clientSecret  string
	users         map[string]fakeSlackUser // user id -> user
	accessTokens  map[string]fakeSlackUser // OpenID Connect token -> user
	userTokens    map[string]fakeSlackUser // OAuth v2 user token -> user
	codes         map[string]fakeSlackCode
	nextUser      fakeSlackUser
	messages      []slackMessage
	ephemerals    []slackEphemeral
	statuses      []slackStatus
	titles        []slackTitle
	postDelay     time.Duration
	discoverDelay time.Duration
	// botChannels is what users.conversations answers, in pages of
	// channelPageSize; channelRequests counts the calls so a test can see
	// the cache. Only a bot token may read them.
	botChannels     []string
	channelPageSize int
	channelRequests int
	channelForms    []url.Values
	// channelNames is what conversations.info answers, keyed by channel id.
	// A channel absent here answers channel_not_found. Only a bot token may
	// read it.
	channelNames map[string]string
	// userInfoRequests counts users.info calls, so a test can see the
	// per-user name cache; userInfoIDs records the ids asked for.
	userInfoRequests int
	userInfoIDs      []string
	// replies is what conversations.replies answers, keyed by the thread
	// root ts; replyError, when set, is the Slack error code it answers, and
	// replyDelay sleeps before answering. replyRequests counts the calls so a
	// test can see that no fetch happened, and replyForms records each call's
	// arguments. replyPageSize, when > 0, splits a thread's messages into
	// pages of that size with a cursor, so pagination is exercised. Only a
	// bot token may read a thread.
	replies       map[string][]map[string]any
	replyError    string
	replyDelay    time.Duration
	replyPageSize int
	replyRequests int
	replyForms    []url.Values
	// joins records every conversations.join form; joinError is what the
	// next join answers (the Slack error code), "" for success. Only a bot
	// token may join.
	joins     []url.Values
	joinError string
	// postError is what the next chat.postMessage answers (a Slack error
	// code), "" for success; ephemeralError is the same for
	// chat.postEphemeral. A restricted code exercises the ephemeral
	// fallback.
	postError      string
	ephemeralError string
	// hideBotApp makes bots.info answer a bot with no app_id, so discovery
	// has to fall back to the bot user's profile.
	hideBotApp bool
	// usersListError is what users.list answers (a Slack error code), "" for
	// success; usersListRequests counts the calls so a test can see the cache.
	usersListError    string
	usersListRequests int
	// lookupError is what users.lookupByEmail answers (a Slack error code), ""
	// for success; lookupRequests and lookupEmails record the calls so a test
	// can see the address was used and not cached.
	lookupError    string
	lookupRequests int
	lookupEmails   []string
	// openError is what conversations.open answers (a Slack error code), ""
	// for success; openForms records each call's arguments.
	openError string
	openForms []url.Values
	// permalink is what chat.getPermalink answers; permalinkError, when set,
	// is the Slack error code it answers instead; permalinkForms records each
	// call.
	permalink      string
	permalinkError string
	permalinkForms []url.Values
	// messageTS is the counter chat.postMessage mints each ts from, so every
	// posted opener has a distinct session key.
	messageTS int
	// baseURL is the fake API server's URL, so a test can build a url_private
	// that points back at it.
	baseURL string
	// fileBodies is what the file host serves, keyed by file id; fileMimes is
	// the Content-Type. fileError, when set, is the Slack error code the file
	// host (and files.info) answer, e.g. "missing_scope". fileHTMLRefusal
	// makes the file host answer an HTML 403 instead, so the files.info
	// fallback is exercised. fileRequests counts the fetches and fileBearer
	// records the bearer each fetch presented.
	fileBodies      map[string][]byte
	fileMimes       map[string]string
	fileError       string
	fileHTMLRefusal bool
	fileRequests    int
	fileBearer      []string
	down            bool
	authRequests    int
	tokenRequests   []url.Values
	seenTokens      map[string]bool // every bearer seen by any endpoint
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{
		teamID: slackTeam, appID: slackApp, botID: slackBotID, botUserID: slackBotUser,
		botToken: slackBotToken, clientID: slackClientID, clientSecret: slackClientSec,
		users: map[string]fakeSlackUser{
			"U-alice": {ID: "U-alice", TeamID: slackTeam, Name: "Alice"},
			"U-bob":   {ID: "U-bob", TeamID: slackTeam, Name: "Bob"},
			"U-carol": {ID: "U-carol", TeamID: slackTeam, Name: "Carol"},
			"U-guest": {ID: "U-guest", TeamID: slackTeam, Name: "Guest", IsRestricted: true},
			"U-ext":   {ID: "U-ext", TeamID: "T-other", Name: "External", IsStranger: true},
			"U-other": {ID: "U-other", TeamID: "T-other", Name: "OtherTeam"},
		},
		accessTokens: map[string]fakeSlackUser{},
		userTokens:   map[string]fakeSlackUser{},
		codes:        map[string]fakeSlackCode{},
		seenTokens:   map[string]bool{},
		channelNames: map[string]string{},
		fileBodies:   map[string][]byte{},
		fileMimes:    map[string]string{},
		replies:      map[string][]map[string]any{},
	}
}

func (f *fakeSlack) setNextUser(u fakeSlackUser) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextUser = u
}

// setReplies sets what conversations.replies answers for a thread root, in
// the order Slack returns them (oldest first).
func (f *fakeSlack) setReplies(thread string, msgs ...map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies[thread] = msgs
}

func (f *fakeSlack) accessFor(u fakeSlackUser) string {
	tok := "xoxp-" + u.ID
	f.mu.Lock()
	f.accessTokens[tok] = u
	f.mu.Unlock()
	return tok
}

// userAccessFor mints an OAuth v2 user token (the new sign-in kind), which
// identify reads with auth.test.
func (f *fakeSlack) userAccessFor(u fakeSlackUser) string {
	tok := "xoxp-user-" + u.ID
	f.mu.Lock()
	f.userTokens[tok] = u
	f.mu.Unlock()
	return tok
}

func (f *fakeSlack) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := strings.TrimPrefix(r.URL.Path, "/")
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token != "" {
			f.mu.Lock()
			f.seenTokens[token] = true
			f.mu.Unlock()
		}
		switch path {
		case "oauth/v2/authorize":
			q := r.URL.Query()
			f.mu.Lock()
			f.authRequests++
			code := fmt.Sprintf("code-%d", f.authRequests)
			f.codes[code] = fakeSlackCode{challenge: q.Get("code_challenge"), access: "xoxp-code-" + code, user: f.nextUser}
			f.mu.Unlock()
			http.Redirect(w, r, q.Get("redirect_uri")+"?code="+code+"&state="+q.Get("state"), http.StatusFound)
		case "oauth.v2.access":
			_ = r.ParseForm()
			f.mu.Lock()
			f.tokenRequests = append(f.tokenRequests, r.PostForm)
			f.mu.Unlock()
			if r.PostForm.Get("client_id") != f.clientID || r.PostForm.Get("client_secret") != f.clientSecret {
				fmt.Fprint(w, `{"ok":false,"error":"invalid_client"}`)
				return
			}
			f.mu.Lock()
			c, ok := f.codes[r.PostForm.Get("code")]
			f.mu.Unlock()
			if !ok || c.challenge == "" || c.challenge != pkceChallenge(r.PostForm.Get("code_verifier")) {
				fmt.Fprint(w, `{"ok":false,"error":"invalid_grant"}`)
				return
			}
			f.mu.Lock()
			delete(f.codes, r.PostForm.Get("code"))
			f.userTokens[c.access] = c.user
			f.mu.Unlock()
			fmt.Fprintf(w, `{"ok":true,"authed_user":{"id":%q,"access_token":%q,"scope":%q},"team":{"id":%q}}`,
				c.user.ID, c.access, slackUserScope, c.user.TeamID)
		default:
			f.dispatch(w, r, path, token)
		}
	})
}

func (f *fakeSlack) dispatch(w http.ResponseWriter, r *http.Request, path, token string) {
	f.mu.Lock()
	down, delay := f.down, f.postDelay
	discoverDelay := f.discoverDelay
	f.mu.Unlock()
	if down {
		http.Error(w, `{"ok":false,"error":"service_unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if strings.HasPrefix(path, "files/") {
		f.serveFile(w, r, strings.TrimPrefix(path, "files/"), token)
		return
	}
	// Like Slack: a write method decodes a JSON body; a read method takes
	// form-encoded arguments and ignores a JSON body entirely.
	read := func() map[string]any {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		return m
	}
	readForm := func() map[string]any {
		m := map[string]any{}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-www-form-urlencoded") {
			return m
		}
		_ = r.ParseForm()
		for k := range r.PostForm {
			m[k] = r.PostForm.Get(k)
		}
		return m
	}
	str := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
	switch path {
	case "auth.test":
		if discoverDelay > 0 {
			time.Sleep(discoverDelay)
		}
		// A user token names its own user; the bot token names the app.
		f.mu.Lock()
		u, isUser := f.userTokens[token]
		f.mu.Unlock()
		if isUser {
			fmt.Fprintf(w, `{"ok":true,"team_id":%q,"user_id":%q,"user":%q}`, u.TeamID, u.ID, u.Name)
			return
		}
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		fmt.Fprintf(w, `{"ok":true,"team_id":%q,"bot_id":%q,"user_id":%q}`, f.teamID, f.botID, f.botUserID)
	case "bots.info":
		if discoverDelay > 0 {
			time.Sleep(discoverDelay)
		}
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		// Without the bot argument Slack answers ok and no bot object.
		if str(readForm(), "bot") != f.botID {
			fmt.Fprint(w, `{"ok":true}`)
			return
		}
		f.mu.Lock()
		hide := f.hideBotApp
		f.mu.Unlock()
		if hide {
			fmt.Fprint(w, `{"ok":true,"bot":{"id":"B-1","name":"bb"}}`)
			return
		}
		fmt.Fprintf(w, `{"ok":true,"bot":{"app_id":%q}}`, f.appID)
	case "users.info":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		id := str(readForm(), "user")
		f.mu.Lock()
		f.userInfoRequests++
		f.userInfoIDs = append(f.userInfoIDs, id)
		f.mu.Unlock()
		if id == f.botUserID {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": map[string]any{
				"id": id, "team_id": f.teamID, "name": "bb", "is_bot": true,
				"profile": map[string]any{"api_app_id": f.appID, "bot_id": f.botID},
			}})
			return
		}
		u, ok := f.users[id]
		if !ok {
			fmt.Fprint(w, `{"ok":false,"error":"user_not_found"}`)
			return
		}
		realName := u.RealName
		if realName == "" {
			realName = u.Name
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": map[string]any{
			"id": u.ID, "team_id": u.TeamID, "name": u.Name, "real_name": realName,
			"is_bot": u.IsBot, "is_app_user": u.IsAppUser,
			"is_restricted": u.IsRestricted, "is_ultra_restricted": u.IsUltraRestricted,
			"is_stranger": u.IsStranger,
		}})
	case "users.lookupByEmail":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		email := str(readForm(), "email")
		f.mu.Lock()
		f.lookupRequests++
		f.lookupEmails = append(f.lookupEmails, email)
		code := f.lookupError
		var found *fakeSlackUser
		for _, u := range f.users {
			if u.Email != "" && strings.EqualFold(u.Email, email) {
				uu := u
				found = &uu
				break
			}
		}
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		if found == nil {
			fmt.Fprint(w, `{"ok":false,"error":"users_not_found"}`)
			return
		}
		realName := found.RealName
		if realName == "" {
			realName = found.Name
		}
		display := found.DisplayName
		if display == "" {
			display = realName
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": map[string]any{
			"id": found.ID, "team_id": found.TeamID, "name": found.Name, "real_name": realName,
			"is_bot": found.IsBot, "is_app_user": found.IsAppUser,
			"is_restricted": found.IsRestricted, "is_ultra_restricted": found.IsUltraRestricted,
			"is_stranger": found.IsStranger,
			"profile":     map[string]any{"display_name": display, "real_name": realName},
		}})
	case "users.list":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		f.mu.Lock()
		f.usersListRequests++
		code := f.usersListError
		members := make([]map[string]any, 0, len(f.users))
		for _, u := range f.users {
			realName := u.RealName
			if realName == "" {
				realName = u.Name
			}
			display := u.DisplayName
			if display == "" {
				display = realName
			}
			members = append(members, map[string]any{
				"id": u.ID, "name": u.Name, "real_name": realName,
				"is_bot": u.IsBot, "is_app_user": u.IsAppUser,
				"is_restricted": u.IsRestricted, "is_ultra_restricted": u.IsUltraRestricted,
				"is_stranger": u.IsStranger, "team_id": u.TeamID,
				"profile": map[string]any{"display_name": display, "real_name": realName},
			})
		}
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		slices.SortFunc(members, func(a, b map[string]any) int {
			return strings.Compare(str(a, "id"), str(b, "id"))
		})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "members": members,
			"response_metadata": map[string]string{"next_cursor": ""},
		})
	case "conversations.open":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := readForm()
		f.mu.Lock()
		f.openForms = append(f.openForms, r.PostForm)
		code := f.openError
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		users := strings.Split(str(m, "users"), ",")
		ch := "D-" + users[0]
		if len(users) > 1 {
			ch = "G-" + strings.Join(users, "_")
		}
		fmt.Fprintf(w, `{"ok":true,"channel":{"id":%q}}`, ch)
	case "chat.getPermalink":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := readForm()
		f.mu.Lock()
		f.permalinkForms = append(f.permalinkForms, r.PostForm)
		code := f.permalinkError
		link := f.permalink
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		if link == "" {
			link = "https://example.slack.com/archives/" + str(m, "channel") + "/p" + strings.ReplaceAll(str(m, "message_ts"), ".", "")
		}
		fmt.Fprintf(w, `{"ok":true,"permalink":%q}`, link)
	case "conversations.info":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		id := str(readForm(), "channel")
		f.mu.Lock()
		name, ok := f.channelNames[id]
		f.mu.Unlock()
		if !ok {
			fmt.Fprint(w, `{"ok":false,"error":"channel_not_found"}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "channel": map[string]any{"id": id, "name": name}})
	case "conversations.replies":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := readForm()
		f.mu.Lock()
		f.replyRequests++
		f.replyForms = append(f.replyForms, r.PostForm)
		all := f.replies[str(m, "ts")]
		page := f.replyPageSize
		code := f.replyError
		delay := f.replyDelay
		f.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		start := 0
		if c := str(m, "cursor"); c != "" {
			if n, err := strconv.Atoi(c); err == nil {
				start = n
			}
		}
		if start > len(all) {
			start = len(all)
		}
		end := len(all)
		if page > 0 && start+page < end {
			end = start + page
		}
		next := ""
		if end < len(all) {
			next = strconv.Itoa(end)
		}
		msgs := all[start:end]
		if msgs == nil {
			msgs = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "messages": msgs, "has_more": next != "",
			"response_metadata": map[string]string{"next_cursor": next},
		})
	case "openid.connect.userInfo":
		f.mu.Lock()
		u, ok := f.accessTokens[token]
		f.mu.Unlock()
		if !ok {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		fmt.Fprintf(w, `{"ok":true,"sub":%q,"name":%q,"https://slack.com/user_id":%q,"https://slack.com/team_id":%q}`,
			u.ID, u.Name, u.ID, u.TeamID)
	case "conversations.join":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		_ = r.ParseForm()
		f.mu.Lock()
		f.joins = append(f.joins, r.PostForm)
		code := f.joinError
		channel := r.PostForm.Get("channel")
		already := slices.Contains(f.botChannels, channel)
		if code == "" && !already {
			f.botChannels = append(f.botChannels, channel)
		}
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		if already {
			fmt.Fprintf(w, `{"ok":true,"warning":"already_in_channel","channel":{"id":%q}}`, channel)
			return
		}
		fmt.Fprintf(w, `{"ok":true,"channel":{"id":%q}}`, channel)
	case "users.conversations":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := readForm()
		f.mu.Lock()
		f.channelRequests++
		f.channelForms = append(f.channelForms, r.PostForm)
		ids := append([]string(nil), f.botChannels...)
		page := f.channelPageSize
		f.mu.Unlock()
		if page <= 0 {
			page = len(ids)
		}
		start := 0
		if c := str(m, "cursor"); c != "" {
			if n, err := strconv.Atoi(c); err == nil {
				start = n
			}
		}
		end := start + page
		if end > len(ids) {
			end = len(ids)
		}
		next := ""
		if end < len(ids) {
			next = strconv.Itoa(end)
		}
		channels := make([]map[string]string, 0, end-start)
		for _, id := range ids[start:end] {
			channels = append(channels, map[string]string{"id": id})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "channels": channels,
			"response_metadata": map[string]string{"next_cursor": next},
		})
	case "files.info":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		f.mu.Lock()
		code := f.fileError
		_, known := f.fileBodies[str(readForm(), "file")]
		f.mu.Unlock()
		if code != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
			return
		}
		if !known {
			fmt.Fprint(w, `{"ok":false,"error":"file_not_found"}`)
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
	case "chat.postMessage":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		f.mu.Lock()
		postErr := f.postError
		f.mu.Unlock()
		if postErr != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, postErr)
			return
		}
		m := read()
		if delay > 0 {
			time.Sleep(delay)
		}
		f.mu.Lock()
		f.messageTS++
		ts := fmt.Sprintf("%d.000000", f.messageTS)
		f.messages = append(f.messages, slackMessage{Channel: str(m, "channel"), ThreadTS: str(m, "thread_ts"), Text: str(m, "text"), Blocks: m["blocks"]})
		f.mu.Unlock()
		fmt.Fprintf(w, `{"ok":true,"ts":%q}`, ts)
	case "chat.postEphemeral":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		f.mu.Lock()
		ephErr := f.ephemeralError
		f.mu.Unlock()
		if ephErr != "" {
			fmt.Fprintf(w, `{"ok":false,"error":%q}`, ephErr)
			return
		}
		m := read()
		f.mu.Lock()
		f.ephemerals = append(f.ephemerals, slackEphemeral{Channel: str(m, "channel"), User: str(m, "user"), Text: str(m, "text"), Blocks: m["blocks"]})
		f.mu.Unlock()
		fmt.Fprint(w, `{"ok":true,"message_ts":"1.2"}`)
	case "assistant.threads.setStatus":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := read()
		f.mu.Lock()
		f.statuses = append(f.statuses, slackStatus{ChannelID: str(m, "channel_id"), ThreadTS: str(m, "thread_ts"), Status: str(m, "status")})
		f.mu.Unlock()
		fmt.Fprint(w, `{"ok":true}`)
	case "assistant.threads.setTitle":
		if token != f.botToken {
			fmt.Fprint(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		m := read()
		f.mu.Lock()
		f.titles = append(f.titles, slackTitle{ChannelID: str(m, "channel_id"), ThreadTS: str(m, "thread_ts"), Title: str(m, "title")})
		f.mu.Unlock()
		fmt.Fprint(w, `{"ok":true}`)
	default:
		http.NotFound(w, r)
	}
}

// serveFile stands in for Slack's file host: url_private requires the bot
// token, and a refusal can be JSON (with a Slack error code) or an HTML 403.
func (f *fakeSlack) serveFile(w http.ResponseWriter, r *http.Request, id, token string) {
	f.mu.Lock()
	body, ok := f.fileBodies[id]
	mime := f.fileMimes[id]
	code := f.fileError
	html := f.fileHTMLRefusal
	f.fileRequests++
	f.fileBearer = append(f.fileBearer, token)
	f.mu.Unlock()
	if token != f.botToken {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if code != "" && !html {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprintf(w, `{"ok":false,"error":%q}`, code)
		return
	}
	if html {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, "<html><body>forbidden</body></html>")
		return
	}
	if !ok {
		http.NotFound(w, r)
		return
	}
	if mime != "" {
		w.Header().Set("Content-Type", mime)
	}
	_, _ = w.Write(body)
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

type slackFixture struct {
	t      *testing.T
	api    *fakeSlack
	slack  *Slack
	srv    *Server
	public *httptest.Server
	sub    *httptest.Server
	now    time.Time

	mu     sync.Mutex
	toPods bytes.Buffer
	logs   bytes.Buffer
}

type slackWriter struct{ f *slackFixture }

func (w *slackWriter) Write(b []byte) (int, error) {
	w.f.mu.Lock()
	defer w.f.mu.Unlock()
	return w.f.logs.Write(b)
}

func (f *slackFixture) record(b []byte) {
	f.mu.Lock()
	f.toPods.Write(b)
	f.mu.Unlock()
}

func (f *slackFixture) logged() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logs.String()
}

func (f *slackFixture) seen() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.toPods.String()
}

func newSlackFixture(t *testing.T) *slackFixture {
	t.Helper()
	f := &slackFixture{t: t, api: newFakeSlack(), now: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)}
	apiSrv := httptest.NewServer(f.api.handler())
	t.Cleanup(apiSrv.Close)
	f.api.baseURL = apiSrv.URL
	f.slack = &Slack{
		SigningSecret: []byte(slackSigningKey),
		BotToken:      []byte(slackBotToken),
		ClientID:      slackClientID,
		ClientSecret:  []byte(slackClientSec),
		RedirectURL:   slackRedirect,
		PublicBaseURL: slackPublicBase,
		TeamID:        slackTeam,
		AppID:         slackApp,
		BotUserID:     slackBotUser,
		API:           apiSrv.URL,
		AuthorizeURL:  apiSrv.URL + "/oauth/v2/authorize",
		TokenURL:      apiSrv.URL + "/oauth.v2.access",
		Now:           func() time.Time { return f.now },
	}
	f.srv = &Server{
		Registry: &Registry{Lease: time.Hour, Now: func() time.Time { return f.now }},
		CacheTTL: 5 * time.Minute,
		Logger:   slog.New(slog.NewJSONHandler(&slackWriter{f: f}, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Slack:    f.slack,
	}
	f.public = httptest.NewServer(f.srv.Public())
	t.Cleanup(f.public.Close)
	f.sub = httptest.NewServer(f.srv.Subscriber())
	t.Cleanup(f.sub.Close)
	t.Cleanup(f.srv.Close)
	return f
}

// stream opens a pod's event stream and returns its connection id and the
// Slack wakes it receives. Every byte is recorded. The stream closes at
// the end of the test.
func (f *slackFixture) stream() (string, <-chan SlackWake) {
	conn, wakes, closeFn := f.openStream()
	f.t.Cleanup(closeFn)
	return conn, wakes
}

// openStream is stream with an explicit close, for the rebind test.
func (f *slackFixture) openStream() (string, <-chan SlackWake, func()) {
	f.t.Helper()
	resp, err := http.Get(f.sub.URL + "/v1/events")
	if err != nil {
		f.t.Fatal(err)
	}
	wakes := make(chan SlackWake, 16)
	helloc := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		var event, data string
		for sc.Scan() {
			line := sc.Text()
			f.record([]byte(line + "\n"))
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
				case "session":
					var wk SlackWake
					_ = json.Unmarshal([]byte(data), &wk)
					if wk.Source == "slack" {
						wakes <- wk
					}
				}
				event, data = "", ""
			}
		}
	}()
	select {
	case id := <-helloc:
		return id, wakes, func() { resp.Body.Close() }
	case <-time.After(5 * time.Second):
		f.t.Fatal("no hello")
		return "", nil, nil
	}
}

func (f *slackFixture) post(path string, v any) (int, []byte) {
	f.t.Helper()
	body, _ := json.Marshal(v)
	resp, err := http.Post(f.sub.URL+path, "application/json", bytes.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	f.record(out)
	return resp.StatusCode, out
}

func (f *slackFixture) get(path string) (int, []byte) {
	f.t.Helper()
	resp, err := http.Get(f.sub.URL + path)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	f.record(out)
	return resp.StatusCode, out
}

// fileURL is the url_private a test puts on a wake so the file endpoint
// fetches from the fake host.
func (f *slackFixture) fileURL(id string) string {
	return f.api.baseURL + "/files/" + id
}

// getFile calls the file endpoint with a connection query parameter.
func (f *slackFixture) getFile(session, id, connection string) (int, []byte) {
	f.t.Helper()
	return f.get("/v1/slack/sessions/" + url.PathEscape(session) + "/files/" + url.PathEscape(id) + "?connection=" + url.QueryEscape(connection))
}

func (f *slackFixture) identify(conn, token string) (int, IdentifyResponse) {
	f.t.Helper()
	code, body := f.post("/v1/identify", IdentifyRequest{Connection: conn, Source: "slack", Token: token})
	var out IdentifyResponse
	if code == http.StatusOK {
		if err := json.Unmarshal(body, &out); err != nil {
			f.t.Fatal(err)
		}
	}
	return code, out
}

// subscribe posts to the shared subscribe endpoint and decodes the answer.
func (f *slackFixture) subscribe(source, conn string, watches []Watch) SubscribeResponse {
	f.t.Helper()
	code, body := f.post("/v1/subscribe", SubscribeRequest{Connection: conn, Source: source, Watches: watches})
	if code != http.StatusOK {
		f.t.Fatalf("subscribe: %d %s", code, body)
	}
	var out SubscribeResponse
	if err := json.Unmarshal(body, &out); err != nil {
		f.t.Fatal(err)
	}
	return out
}

// pod opens a stream and proves it is the user with token.
func (f *slackFixture) pod(token string) (string, <-chan SlackWake) {
	f.t.Helper()
	conn, wakes := f.stream()
	if code, _ := f.identify(conn, token); code != http.StatusOK {
		f.t.Fatalf("identify: %d", code)
	}
	return conn, wakes
}

// deliver posts a signed Events API delivery. retry, when > 0, adds the
// X-Slack-Retry-Num header Slack uses on a retry.
func (f *slackFixture) deliver(payload map[string]any, sign bool, retry int) (int, time.Duration) {
	f.t.Helper()
	body, _ := json.Marshal(payload)
	return f.deliverRaw(body, sign, retry)
}

func (f *slackFixture) deliverRaw(body []byte, sign bool, retry int) (int, time.Duration) {
	f.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/slack", bytes.NewReader(body))
	ts := fmt.Sprint(f.now.Unix())
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	if sign {
		req.Header.Set("X-Slack-Signature", f.slack.Sign(ts, body))
	}
	if retry > 0 {
		req.Header.Set("X-Slack-Retry-Num", fmt.Sprint(retry))
		req.Header.Set("X-Slack-Retry-Reason", "http_timeout")
	}
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	took := time.Since(start)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, took
}

// interact posts a Block Kit interactivity delivery as Slack sends it:
// form-encoded with a payload field, signed the same way as /slack. at is
// the timestamp the delivery claims.
func (f *slackFixture) interact(payload map[string]any, sign bool, at time.Time) int {
	f.t.Helper()
	raw, _ := json.Marshal(payload)
	body := []byte(url.Values{"payload": {string(raw)}}.Encode())
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/slack/interactivity", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	ts := fmt.Sprint(at.Unix())
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	if sign {
		req.Header.Set("X-Slack-Signature", f.slack.Sign(ts, body))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

// event builds an event_callback envelope.
func (f *slackFixture) event(id, team, app string, inner map[string]any) map[string]any {
	return map[string]any{
		"type": "event_callback", "team_id": team, "api_app_id": app,
		"event_id": id, "event_time": f.now.Unix(), "event": inner,
	}
}

func (f *slackFixture) message(id, team, app, user, channel, text string, extra map[string]any) map[string]any {
	inner := map[string]any{"type": "message", "channel_type": "im", "user": user, "channel": channel, "ts": "111.222", "text": text}
	for k, v := range extra {
		inner[k] = v
	}
	return f.event(id, team, app, inner)
}

func (f *slackFixture) start(conn string) (string, string) {
	f.t.Helper()
	code, body := f.post("/v1/slack/signin/start", SigninStartRequest{Connection: conn})
	if code != http.StatusOK {
		f.t.Fatalf("signin start: %d %s", code, body)
	}
	var out SigninStartResponse
	if err := json.Unmarshal(body, &out); err != nil {
		f.t.Fatal(err)
	}
	return out.AuthorizeURL, out.State
}

func (f *slackFixture) exchange(conn, state, code string) (int, []byte) {
	f.t.Helper()
	return f.post("/v1/slack/signin/exchange", SigninExchangeRequest{Connection: conn, State: state, Code: code})
}

func wakeSlack(t *testing.T, wakes <-chan SlackWake, session string) SlackWake {
	t.Helper()
	select {
	case wk := <-wakes:
		if wk.Session != session {
			t.Fatalf("wake for %s, want %s", wk.Session, session)
		}
		return wk
	case <-time.After(5 * time.Second):
		t.Fatalf("no wake for %s", session)
		return SlackWake{}
	}
}

func noSlackWake(t *testing.T, wakes <-chan SlackWake) {
	t.Helper()
	select {
	case wk := <-wakes:
		t.Fatalf("unexpected wake %+v", wk)
	case <-time.After(200 * time.Millisecond):
	}
}

// posted returns a snapshot of the posts the fake Slack API recorded.
func (f *slackFixture) posted() []slackMessage {
	f.api.mu.Lock()
	defer f.api.mu.Unlock()
	return append([]slackMessage(nil), f.api.messages...)
}

// waitMessages waits until at least n posts have been recorded and returns
// them.
func (f *slackFixture) waitMessages(n int) []slackMessage {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		msgs := f.posted()
		if len(msgs) >= n {
			return msgs
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("want %d messages, got %d", n, len(msgs))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitEphemerals waits until at least n ephemeral posts have been recorded
// and returns them.
func (f *slackFixture) waitEphemerals(n int) []slackEphemeral {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.api.mu.Lock()
		ephs := append([]slackEphemeral(nil), f.api.ephemerals...)
		f.api.mu.Unlock()
		if len(ephs) >= n {
			return ephs
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("want %d ephemerals, got %d", n, len(ephs))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitDeregistered waits for a closed stream to leave the registry.
func waitDeregistered(t *testing.T, f *slackFixture, conn string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.Registry.Get(conn) != nil {
		if time.Now().After(deadline) {
			t.Fatal("connection still registered after close")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSlackSignatureAndHandshake(t *testing.T) {
	f := newSlackFixture(t)

	// Unsigned, stale and wrong-secret deliveries are refused.
	if code, _ := f.deliverRaw([]byte(`{"type":"event_callback"}`), false, 0); code != http.StatusUnauthorized {
		t.Fatalf("unsigned: %d", code)
	}
	body := []byte(`{"type":"url_verification","challenge":"abc"}`)
	stale := fmt.Sprint(f.now.Add(-6 * time.Minute).Unix())
	req, _ := http.NewRequest(http.MethodPost, f.public.URL+"/slack", bytes.NewReader(body))
	req.Header.Set("X-Slack-Request-Timestamp", stale)
	req.Header.Set("X-Slack-Signature", f.slack.Sign(stale, body))
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale: %d", resp.StatusCode)
	}
	wrong := &Slack{SigningSecret: []byte("other")}
	ts := fmt.Sprint(f.now.Unix())
	req, _ = http.NewRequest(http.MethodPost, f.public.URL+"/slack", bytes.NewReader(body))
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", wrong.Sign(ts, body))
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong secret: %d", resp.StatusCode)
	}

	// url_verification answers the challenge.
	raw := []byte(`{"type":"url_verification","challenge":"challenge-xyz"}`)
	ts = fmt.Sprint(f.now.Unix())
	req, _ = http.NewRequest(http.MethodPost, f.public.URL+"/slack", bytes.NewReader(raw))
	req.Header.Set("X-Slack-Request-Timestamp", ts)
	req.Header.Set("X-Slack-Signature", f.slack.Sign(ts, raw))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(out) != "challenge-xyz" {
		t.Fatalf("handshake: %d %q", resp.StatusCode, out)
	}

	// A disabled adapter answers 503.
	f.slack.SigningSecret = nil
	if code, _ := f.deliverRaw([]byte(`{"type":"url_verification","challenge":"x"}`), false, 0); code != http.StatusServiceUnavailable {
		t.Fatalf("disabled: %d", code)
	}
}

func TestSlackAckBeforeWake(t *testing.T) {
	f := newSlackFixture(t)
	f.api.postDelay = 500 * time.Millisecond
	// No server bound: the no-server reply is a Slack API call, but the
	// webhook must answer before it.
	_, took := f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	if took >= 200*time.Millisecond {
		t.Fatalf("webhook took %v; it waited for the reply", took)
	}
	// The reply lands afterwards.
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.api.mu.Lock()
		n := len(f.api.messages)
		f.api.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no-server reply never posted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.api.mu.Lock()
	msg := f.api.messages[0]
	f.api.mu.Unlock()
	if msg.Channel != "D-1" {
		t.Fatalf("reply %+v", msg)
	}
	checkNoServerReply(t, msg)
}

func TestSlackDedupe(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	ev := f.message("Ev-dup", slackTeam, slackApp, "U-alice", "D-1", "hi", nil)
	if code, _ := f.deliver(ev, true, 0); code != http.StatusOK {
		t.Fatalf("first: %d", code)
	}
	wakeSlack(t, wakes, "D-1:111.222")
	// Slack's retry carries the same event_id.
	if code, _ := f.deliver(ev, true, 1); code != http.StatusOK {
		t.Fatalf("retry: %d", code)
	}
	noSlackWake(t, wakes)
	_ = conn
}

func TestSlackRouting(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A DM from the owner wakes the bound server, untrusted false.
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "build this", nil), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	if wk.Source != "slack" || wk.Owner.ID != "U-alice" || wk.Asker.ID != "U-alice" || !wk.FromOwner || wk.Comment.Untrusted ||
		wk.Comment.Text != "build this" || wk.Channel != "D-1" || wk.Thread != "111.222" || wk.Action != "message" || wk.TS != "111.222" {
		t.Fatalf("wake %+v", wk)
	}

	// A threaded follow-up uses the root ts.
	inner := map[string]any{"type": "message", "channel_type": "im", "user": "U-alice", "channel": "D-1", "ts": "333.444", "thread_ts": "111.222", "text": "more"}
	f.deliver(f.event("Ev-2", slackTeam, slackApp, inner), true, 0)
	if wk := wakeSlack(t, wakes, "D-1:111.222"); wk.Comment.Text != "more" || wk.Thread != "111.222" {
		t.Fatalf("thread wake %+v", wk)
	}

	// assistant_thread_started routes too.
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type":             "assistant_thread_started",
		"assistant_thread": map[string]any{"user_id": "U-alice", "channel_id": "D-1", "thread_ts": "555.666"},
	}), true, 0)
	if wk := wakeSlack(t, wakes, "D-1:555.666"); wk.Action != "assistant_thread_started" || wk.Comment.Text != "" {
		t.Fatalf("assistant wake %+v", wk)
	}

	// assistant_thread_context_changed carries the channel the user was viewing.
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "assistant_thread_context_changed",
		"assistant_thread": map[string]any{
			"user_id": "U-alice", "channel_id": "D-1", "thread_ts": "777.888",
			"context": map[string]any{"channel_id": "C-viewed"},
		},
	}), true, 0)
	if wk := wakeSlack(t, wakes, "D-1:777.888"); wk.Action != "assistant_thread_context_changed" || wk.ContextChannel != "C-viewed" {
		t.Fatalf("context wake %+v", wk)
	}

	// Ignored: the app's own bot message, a join, a channel message, a
	// wrong workspace and a wrong app.
	f.deliver(f.message("Ev-bot", slackTeam, slackApp, "U-alice", "D-1", "bot", map[string]any{"bot_id": "B-1"}), true, 0)
	f.deliver(f.message("Ev-join", slackTeam, slackApp, "U-alice", "D-1", "joined", map[string]any{"subtype": "channel_join"}), true, 0)
	f.deliver(f.message("Ev-chan", slackTeam, slackApp, "U-alice", "C-1", "channel", map[string]any{"channel_type": "channel"}), true, 0)
	f.deliver(f.message("Ev-team", "T-other", slackApp, "U-alice", "D-1", "other team", nil), true, 0)
	f.deliver(f.message("Ev-app", slackTeam, "A-other", "U-alice", "D-1", "other app", nil), true, 0)
	noSlackWake(t, wakes)
	_ = conn
}

// TestSlackDroppedEventLogged pins that every rejected delivery is logged at
// info with its type, subtype, channel type and the reason, and that the
// message text and user id never appear in the line.
func TestSlackDroppedEventLogged(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()

	// A bot author.
	f.deliver(f.message("Ev-bot", slackTeam, slackApp, "U-alice", "D-1", "SECRET-TEXT", map[string]any{"bot_id": "B-1"}), true, 0)
	// A subtype the adapter does not route.
	f.deliver(f.message("Ev-join", slackTeam, slackApp, "U-alice", "D-1", "SECRET-TEXT", map[string]any{"subtype": "channel_join"}), true, 0)
	// Missing fields: a mention with no user.
	f.deliver(f.event("Ev-nouser", slackTeam, slackApp, map[string]any{"type": "app_mention", "channel": "C-1", "ts": "1.2", "text": "SECRET-TEXT"}), true, 0)
	// An unhandled event type.
	f.deliver(f.event("Ev-react", slackTeam, slackApp, map[string]any{"type": "reaction_added"}), true, 0)
	// A channel reply in a thread bb is not part of.
	f.deliver(f.event("Ev-chan", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "2.2", "thread_ts": "1.2", "text": "SECRET-TEXT",
	}), true, 0)

	logs := f.logged()
	if !strings.Contains(logs, "slack event dropped") {
		t.Fatalf("no drop log:\n%s", logs)
	}
	for _, reason := range []string{"bot-author", "dropped-subtype", "missing-fields", "unhandled-type", "not-live-session"} {
		if !strings.Contains(logs, `"reason":"`+reason+`"`) {
			t.Errorf("no drop log for reason %q:\n%s", reason, logs)
		}
	}
	if strings.Contains(logs, "SECRET-TEXT") {
		t.Errorf("drop log leaked the text:\n%s", logs)
	}
	if strings.Contains(logs, "U-alice") {
		t.Errorf("drop log leaked the user id:\n%s", logs)
	}
}

// TestSlackRouteLogFields pins that the routing lines carry session, action
// and channel id, passed explicitly so they survive the real slog handler.
func TestSlackRouteLogFields(t *testing.T) {
	f := newSlackFixture(t)
	f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)

	deadline := time.Now().Add(5 * time.Second)
	for {
		logs := f.logged()
		if strings.Contains(logs, "slack session routed") {
			for _, want := range []string{`"session":"D-1:111.222"`, `"action":"message"`, `"channel":"D-1"`} {
				if !strings.Contains(logs, want) {
					t.Errorf("routed log missing %s:\n%s", want, logs)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no routed log:\n%s", f.logged())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSlackDuplicateLogged pins that both the event-id duplicate (a Slack
// retry) and the message-key duplicate (the two deliveries of one tagged
// reply) are logged with the fields and a running count.
func TestSlackDuplicateLogged(t *testing.T) {
	f := newSlackFixture(t)
	f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// The same event id twice: the second is a Slack retry dropped by accept.
	ev := f.message("Ev-dup", slackTeam, slackApp, "U-alice", "D-1", "hi", nil)
	f.deliver(ev, true, 0)
	f.deliver(ev, true, 1)

	// The second delivery of one tagged reply is dropped by deliver.
	dup := slackRouted{Session: "D-1:1.2", Action: "message", Tagged: true, Key: "D-1:1.2", Channel: "D-1", Thread: "1.2", User: "U-alice", Text: "hi", At: f.now}
	f.slack.deliver(dup)
	f.slack.deliver(dup)

	if got := f.slack.droppedDuplicates.Load(); got != 2 {
		t.Fatalf("dropped duplicates %d, want 2", got)
	}
	logs := f.logged()
	for _, want := range []string{
		`"eventId":"Ev-dup"`, `"type":"message"`, `"channelType":"im"`,
		`"session":"D-1:1.2"`, `"action":"message"`, `"channel":"D-1"`, `"dropped":2`,
	} {
		if !strings.Contains(logs, want) {
			t.Errorf("duplicate log missing %s:\n%s", want, logs)
		}
	}
}

// TestSlackMessageCorrections pins the edit and deletion routing: a DM
// message_changed and message_deleted route to the same session as the
// original, with action edited/deleted, the original message's ts, and the
// new text on an edit. A message wake carries its own ts. Bot edits, other
// subtypes and non-DM channels are dropped, and an edit by someone other than
// the owner follows the untrusted path.
func TestSlackMessageCorrections(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A plain DM wake carries the message's own ts.
	f.deliver(f.message("Ev-plain", slackTeam, slackApp, "U-alice", "D-1", "build this", nil), true, 0)
	plain := wakeSlack(t, wakes, "D-1:111.222")
	if plain.Action != "message" || plain.TS != "111.222" {
		t.Fatalf("plain wake %+v", plain)
	}

	// An edit of that message routes with action edited, the same session and
	// ts, and the new text.
	f.deliver(f.event("Ev-edit", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel":          "D-1",
		"message":          map[string]any{"user": "U-alice", "ts": "111.222", "text": "build that"},
		"previous_message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "build this"},
	}), true, 0)
	edit := wakeSlack(t, wakes, "D-1:111.222")
	if edit.Action != "edited" || edit.TS != "111.222" || edit.Comment.Text != "build that" || !edit.FromOwner || edit.Comment.Untrusted {
		t.Fatalf("edit wake %+v", edit)
	}

	// A reply-count update: Slack sends a message_changed for the parent with
	// the same text and files. It is metadata only and must not wake, and it
	// logs the metadata-only reason.
	f.deliver(f.event("Ev-replies", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel": "D-1",
		"message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "build this",
			"files": []map[string]any{{"id": "F-1", "name": "shot.png", "size": 1234}}},
		"previous_message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "build this",
			"files": []map[string]any{{"id": "F-1", "name": "shot.png", "size": 1234}}},
	}), true, 0)
	if logs := f.logged(); !strings.Contains(logs, `"reason":"metadata-only"`) {
		t.Fatalf("metadata-only edit was not dropped:\n%s", logs)
	}

	// A change that only adds a file still routes as an edit.
	f.deliver(f.event("Ev-addfile", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel": "D-1",
		"message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "build this",
			"files": []map[string]any{{"id": "F-1", "name": "shot.png", "size": 1234}}},
		"previous_message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "build this"},
	}), true, 0)
	addFile := wakeSlack(t, wakes, "D-1:111.222")
	if addFile.Action != "edited" || addFile.TS != "111.222" {
		t.Fatalf("files-only edit wake %+v", addFile)
	}

	// A deletion of a threaded reply routes to the thread's session on the
	// original ts, with no text.
	f.deliver(f.event("Ev-del", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_deleted", "channel_type": "im",
		"channel": "D-1", "deleted_ts": "333.444",
		"previous_message": map[string]any{"user": "U-alice", "ts": "333.444", "thread_ts": "111.222", "text": "more"},
	}), true, 0)
	del := wakeSlack(t, wakes, "D-1:111.222")
	if del.Action != "deleted" || del.TS != "333.444" || del.Thread != "111.222" || del.Comment.Text != "" {
		t.Fatalf("delete wake %+v", del)
	}

	// A deletion without deleted_ts falls back to previous_message.ts.
	f.deliver(f.event("Ev-del2", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_deleted", "channel_type": "im",
		"channel":          "D-1",
		"previous_message": map[string]any{"user": "U-alice", "ts": "555.666", "text": "bye"},
	}), true, 0)
	del2 := wakeSlack(t, wakes, "D-1:555.666")
	if del2.Action != "deleted" || del2.TS != "555.666" {
		t.Fatalf("delete fallback wake %+v", del2)
	}

	// An edit of someone else's message in a session Alice owns goes to
	// Alice's server, untrusted.
	f.deliver(f.event("Ev-bobedit", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel":          "D-1",
		"message":          map[string]any{"user": "U-bob", "ts": "111.222", "text": "bob edit"},
		"previous_message": map[string]any{"user": "U-bob", "ts": "111.222", "text": "bob text"},
	}), true, 0)
	second := wakeSlack(t, wakes, "D-1:111.222")
	if second.Action != "edited" || second.Asker.ID != "U-bob" || second.Owner.ID != "U-alice" || second.FromOwner || !second.Comment.Untrusted {
		t.Fatalf("second-person edit wake %+v", second)
	}

	// Dropped: an edit by a bot, an edit with no inner message, a deletion of
	// a bot message, another subtype, and an edit in a channel (channel
	// threads are BB-130).
	f.deliver(f.event("Ev-botedit", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel": "D-1",
		"message": map[string]any{"user": "U-alice", "bot_id": "B-1", "ts": "111.222", "text": "bot edit"},
	}), true, 0)
	f.deliver(f.event("Ev-nomsg", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "im",
		"channel": "D-1", "ts": "111.222", "text": "no inner message",
	}), true, 0)
	f.deliver(f.event("Ev-botdel", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_deleted", "channel_type": "im",
		"channel": "D-1", "deleted_ts": "111.222",
		"previous_message": map[string]any{"user": "U-alice", "bot_id": "B-1", "ts": "111.222"},
	}), true, 0)
	f.deliver(f.event("Ev-join", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "channel_join", "channel_type": "im",
		"channel": "D-1", "user": "U-alice", "ts": "111.222", "text": "joined",
	}), true, 0)
	f.deliver(f.event("Ev-chedit", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "channel",
		"channel": "C-1",
		"message": map[string]any{"user": "U-alice", "ts": "111.222", "text": "channel edit"},
	}), true, 0)
	noSlackWake(t, wakes)
}

// TestSlackWakeFiles pins the files field: a message's attachments cross the
// wake as metadata only (id, name, mimeType, size), a file-only message still
// routes, and a wake with no files carries no files key at all.
func TestSlackWakeFiles(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A DM whose text is empty but which carries two files: one with a name,
	// one a snippet with only a title. Slack sends a file message with
	// subtype file_share, so it must route, not be dropped as an edit.
	f.deliver(f.message("Ev-files", slackTeam, slackApp, "U-alice", "D-1", "", map[string]any{
		"subtype": "file_share",
		"files": []map[string]any{
			{"id": "F-1", "name": "shot.png", "mimetype": "image/png", "size": 1234},
			{"id": "F-2", "title": "snippet.go", "mimetype": "text/plain", "size": 99},
		},
	}), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	want := []SlackFile{
		{ID: "F-1", Name: "shot.png", MimeType: "image/png", Size: 1234},
		{ID: "F-2", Name: "snippet.go", MimeType: "text/plain", Size: 99},
	}
	if !reflect.DeepEqual(wk.Files, want) {
		t.Fatalf("files %+v, want %+v", wk.Files, want)
	}
	if wk.Comment.Text != "" {
		t.Fatalf("file-only message text %q, want empty", wk.Comment.Text)
	}
	data, _ := json.Marshal(wk)
	if !strings.Contains(string(data), `"files":[{"id":"F-1","name":"shot.png","mimeType":"image/png","size":1234}`) {
		t.Fatalf("wake JSON does not carry the files: %s", data)
	}

	// Text and files on one message: the text is kept and the files ride
	// along. A join subtype is still dropped.
	f.deliver(f.message("Ev-both", slackTeam, slackApp, "U-alice", "D-1", "what is this?", map[string]any{
		"ts":      "333.444",
		"subtype": "file_share",
		"files":   []map[string]any{{"id": "F-3", "name": "err.log", "mimetype": "text/plain", "size": 42}},
	}), true, 0)
	both := wakeSlack(t, wakes, "D-1:333.444")
	if both.Comment.Text != "what is this?" || !reflect.DeepEqual(both.Files, []SlackFile{{ID: "F-3", Name: "err.log", MimeType: "text/plain", Size: 42}}) {
		t.Fatalf("text+files wake %+v", both)
	}
	f.deliver(f.message("Ev-join2", slackTeam, slackApp, "U-alice", "D-1", "joined", map[string]any{"ts": "444.555", "subtype": "channel_join"}), true, 0)
	noSlackWake(t, wakes)

	// A message with no files carries no files key, so its wake is
	// byte-identical to before the field existed.
	f.deliver(f.message("Ev-plain", slackTeam, slackApp, "U-alice", "D-1", "plain", map[string]any{"ts": "222.333"}), true, 0)
	plain := wakeSlack(t, wakes, "D-1:222.333")
	if plain.Files != nil {
		t.Fatalf("no-files wake carries %+v", plain.Files)
	}
	data, _ = json.Marshal(plain)
	if strings.Contains(string(data), "files") {
		t.Fatalf("no-files wake JSON carries files: %s", data)
	}
}

// TestSlackWakeFileHints pins the additive wake hints: filetype and a
// snippet preview cross, and the url_private the endpoint fetches with never
// does.
func TestSlackWakeFileHints(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.deliver(f.message("Ev-hints", slackTeam, slackApp, "U-alice", "D-1", "", map[string]any{
		"subtype": "file_share",
		"files": []map[string]any{
			{"id": "F-1", "name": "shot.png", "mimetype": "image/png", "size": 5, "filetype": "png", "url_private": f.fileURL("F-1")},
			{"id": "F-2", "title": "snippet.py", "mimetype": "text/plain", "size": 9, "filetype": "python", "preview": "print(1)\n", "url_private": f.fileURL("F-2")},
		},
	}), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	if wk.Files[0].Filetype != "png" || wk.Files[0].Preview != "" {
		t.Fatalf("image hints %+v", wk.Files[0])
	}
	if wk.Files[1].Filetype != "python" || wk.Files[1].Preview != "print(1)\n" {
		t.Fatalf("snippet hints %+v", wk.Files[1])
	}
	data, _ := json.Marshal(wk)
	if strings.Contains(string(data), "url_private") || strings.Contains(string(data), f.api.baseURL) {
		t.Fatalf("wake leaked the url_private: %s", data)
	}
}

// TestSlackFileEndpoint pins the file endpoint: it serves a file id seen on a
// wake routed to the connection's session, refuses an id never seen and a
// session the connection does not own, fetches with the bot token, and never
// logs the content, the name or the URL.
func TestSlackFileEndpoint(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.fileBodies["F-img"] = []byte("PNGDATA")
	f.api.fileMimes["F-img"] = "image/png"
	f.api.fileBodies["F-txt"] = []byte("hello, world")
	f.api.fileMimes["F-txt"] = "text/plain"
	f.api.mu.Unlock()

	f.deliver(f.message("Ev-file", slackTeam, slackApp, "U-alice", "D-1", "look", map[string]any{
		"subtype": "file_share",
		"files": []map[string]any{
			{"id": "F-img", "name": "shot.png", "mimetype": "image/png", "size": 7, "url_private": f.fileURL("F-img"), "filetype": "png"},
			{"id": "F-txt", "name": "notes.txt", "mimetype": "text/plain", "size": 12, "url_private": f.fileURL("F-txt"), "filetype": "text"},
		},
	}), true, 0)
	_ = wakeSlack(t, wakes, "D-1:111.222")

	code, body := f.getFile("D-1:111.222", "F-img", conn)
	if code != http.StatusOK || string(body) != "PNGDATA" {
		t.Fatalf("image fetch: %d %q", code, body)
	}
	code, body = f.getFile("D-1:111.222", "F-txt", conn)
	if code != http.StatusOK || string(body) != "hello, world" {
		t.Fatalf("text fetch: %d %q", code, body)
	}

	// The file host saw the bot token, never the user's.
	f.api.mu.Lock()
	bearer := append([]string(nil), f.api.fileBearer...)
	f.api.mu.Unlock()
	if len(bearer) == 0 {
		t.Fatal("file host was never called")
	}
	for _, b := range bearer {
		if b != slackBotToken {
			t.Fatalf("file host saw bearer %q, want the bot token", b)
		}
	}

	// An id never seen on a wake is 404, even for the owning connection.
	if code, _ := f.getFile("D-1:111.222", "F-unknown", conn); code != http.StatusNotFound {
		t.Fatalf("unknown id: %d", code)
	}
	// A session the connection does not own is refused.
	if code, _ := f.getFile("D-2:999.999", "F-img", conn); code != http.StatusForbidden {
		t.Fatalf("foreign session: %d", code)
	}
	// An unknown connection is 404.
	if code, _ := f.getFile("D-1:111.222", "F-img", "c-nope"); code != http.StatusNotFound {
		t.Fatalf("unknown connection: %d", code)
	}

	// Nothing logged the content, the names or the URL.
	logs := f.logged()
	for _, secret := range []string{"PNGDATA", "hello, world", "shot.png", "notes.txt", f.api.baseURL} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs leaked %q: %s", secret, logs)
		}
	}
}

// TestSlackFileLimits pins the server-side limits: an image over 10 MiB, a
// text-like file over 1 MiB and an unsupported type are refused before any
// fetch, and a body larger than Slack declared is refused too.
func TestSlackFileLimits(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.deliver(f.message("Ev-limits", slackTeam, slackApp, "U-alice", "D-1", "", map[string]any{
		"subtype": "file_share",
		"files": []map[string]any{
			{"id": "F-bigimg", "name": "big.png", "mimetype": "image/png", "size": slackImageMaxBytes + 1, "url_private": f.fileURL("F-bigimg"), "filetype": "png"},
			{"id": "F-bigtext", "name": "big.txt", "mimetype": "text/plain", "size": slackTextMaxBytes + 1, "url_private": f.fileURL("F-bigtext"), "filetype": "text"},
			{"id": "F-bin", "name": "app.zip", "mimetype": "application/zip", "size": 10, "url_private": f.fileURL("F-bin"), "filetype": "zip"},
			{"id": "F-liar", "name": "liar.txt", "mimetype": "text/plain", "size": 4, "url_private": f.fileURL("F-liar"), "filetype": "text"},
		},
	}), true, 0)
	_ = wakeSlack(t, wakes, "D-1:111.222")

	if code, _ := f.getFile("D-1:111.222", "F-bigimg", conn); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize image: %d", code)
	}
	if code, _ := f.getFile("D-1:111.222", "F-bigtext", conn); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize text: %d", code)
	}
	if code, _ := f.getFile("D-1:111.222", "F-bin", conn); code != http.StatusUnsupportedMediaType {
		t.Fatalf("unsupported type: %d", code)
	}
	// None of the three was fetched: the limits are checked before the call.
	f.api.mu.Lock()
	fetches := f.api.fileRequests
	f.api.mu.Unlock()
	if fetches != 0 {
		t.Fatalf("refused files fetched %d times, want 0", fetches)
	}

	// A body larger than the declared size is refused rather than streamed
	// past the cap.
	f.api.mu.Lock()
	f.api.fileBodies["F-liar"] = bytes.Repeat([]byte("x"), int(slackTextMaxBytes)+64)
	f.api.fileMimes["F-liar"] = "text/plain"
	f.api.mu.Unlock()
	if code, _ := f.getFile("D-1:111.222", "F-liar", conn); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body over declared size: %d", code)
	}
}

// TestSlackFileCodeSnippet pins that a code snippet with no mime type is
// served as text/plain rather than an empty Content-Type.
func TestSlackFileCodeSnippet(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.fileBodies["F-code"] = []byte("print(1)\n")
	f.api.mu.Unlock()

	f.deliver(f.message("Ev-code", slackTeam, slackApp, "U-alice", "D-1", "", map[string]any{
		"subtype": "file_share",
		"files":   []map[string]any{{"id": "F-code", "title": "snippet.py", "mimetype": "", "size": 9, "filetype": "python", "url_private": f.fileURL("F-code")}},
	}), true, 0)
	_ = wakeSlack(t, wakes, "D-1:111.222")

	resp, err := http.Get(f.sub.URL + "/v1/slack/sessions/D-1:111.222/files/F-code?connection=" + conn)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "print(1)\n" {
		t.Fatalf("code snippet: %d %q", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("code snippet content type %q, want text/plain", ct)
	}
}

// TestSlackFileMissingScope pins the missing-scope degradation: the file host
// answers missing_scope, or an HTML 403 that files.info explains, and the
// endpoint answers 503 missing-scope either way.
func TestSlackFileMissingScope(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.fileBodies["F-1"] = []byte("data")
	f.api.fileMimes["F-1"] = "image/png"
	f.api.fileError = "missing_scope"
	f.api.mu.Unlock()

	f.deliver(f.message("Ev-scope", slackTeam, slackApp, "U-alice", "D-1", "", map[string]any{
		"subtype": "file_share",
		"files":   []map[string]any{{"id": "F-1", "name": "shot.png", "mimetype": "image/png", "size": 4, "url_private": f.fileURL("F-1"), "filetype": "png"}},
	}), true, 0)
	_ = wakeSlack(t, wakes, "D-1:111.222")

	code, body := f.getFile("D-1:111.222", "F-1", conn)
	if code != http.StatusServiceUnavailable || !strings.Contains(string(body), "missing-scope") {
		t.Fatalf("missing scope: %d %s", code, body)
	}

	// The file host answering an HTML 403 has no missing_scope in its body;
	// files.info names it instead.
	f.api.mu.Lock()
	f.api.fileHTMLRefusal = true
	f.api.mu.Unlock()
	code, body = f.getFile("D-1:111.222", "F-1", conn)
	if code != http.StatusServiceUnavailable || !strings.Contains(string(body), "missing-scope") {
		t.Fatalf("missing scope via files.info: %d %s", code, body)
	}
}

// checkNoServerReply asserts the shape of the no-server reply: a non-empty
// plain-text fallback, a section explaining the server is not set up and the
// next steps, and one url button to the bb site.
func checkNoServerReply(t *testing.T, msg slackMessage) {
	t.Helper()
	if strings.TrimSpace(msg.Text) == "" {
		t.Fatalf("no-server reply has an empty text fallback: %+v", msg)
	}
	if !strings.Contains(msg.Text, "not set up") || !strings.Contains(msg.Text, "https://bb.example.com/") {
		t.Fatalf("no-server fallback text %q", msg.Text)
	}
	blocks, ok := msg.Blocks.([]any)
	if !ok || len(blocks) == 0 {
		t.Fatalf("no-server reply has no blocks: %+v", msg.Blocks)
	}
	var section string
	var button map[string]any
	for _, raw := range blocks {
		b, _ := raw.(map[string]any)
		switch b["type"] {
		case "section":
			if txt, ok := b["text"].(map[string]any); ok {
				section, _ = txt["text"].(string)
			}
		case "actions":
			els, _ := b["elements"].([]any)
			for _, e := range els {
				el, _ := e.(map[string]any)
				if el["type"] == "button" {
					button = el
				}
			}
		}
	}
	if button == nil {
		t.Fatalf("no-server reply has no button element: %+v", msg.Blocks)
	}
	bt, _ := button["text"].(map[string]any)
	if button["type"] != "button" || button["url"] != "https://bb.example.com/" || bt["text"] != "Set up your bb" {
		t.Fatalf("no-server button %+v", button)
	}
	if !strings.Contains(section, "not set up") || !strings.Contains(section, "Team setup") ||
		!strings.Contains(section, "Settings \u2192 Plugins \u2192 Slack") || !strings.Contains(section, "Sign in with Slack") ||
		!strings.Contains(section, "message me again") {
		t.Fatalf("no-server section %q", section)
	}
}

// checkNotConnectedReply asserts the shape of the not-connected reply: a
// non-empty plain-text fallback, a section naming the likely causes and where
// to check, and one url button to bb.
func checkNotConnectedReply(t *testing.T, msg slackMessage) {
	t.Helper()
	if strings.TrimSpace(msg.Text) == "" {
		t.Fatalf("not-connected reply has an empty text fallback: %+v", msg)
	}
	if !strings.Contains(msg.Text, "not connected") || !strings.Contains(msg.Text, "Settings \u2192 Plugins \u2192 Slack") {
		t.Fatalf("not-connected fallback text %q", msg.Text)
	}
	blocks, ok := msg.Blocks.([]any)
	if !ok || len(blocks) == 0 {
		t.Fatalf("not-connected reply has no blocks: %+v", msg.Blocks)
	}
	var section string
	var button map[string]any
	for _, raw := range blocks {
		b, _ := raw.(map[string]any)
		switch b["type"] {
		case "section":
			if txt, ok := b["text"].(map[string]any); ok {
				section, _ = txt["text"].(string)
			}
		case "actions":
			els, _ := b["elements"].([]any)
			for _, e := range els {
				el, _ := e.(map[string]any)
				if el["type"] == "button" {
					button = el
				}
			}
		}
	}
	if button == nil {
		t.Fatalf("not-connected reply has no button element: %+v", msg.Blocks)
	}
	bt, _ := button["text"].(map[string]any)
	if button["type"] != "button" || button["url"] != "https://bb.example.com/" || bt["text"] != "Open bb" {
		t.Fatalf("not-connected button %+v", button)
	}
	if !strings.Contains(section, "not connected") || !strings.Contains(section, "Settings \u2192 Plugins \u2192 Slack") ||
		!strings.Contains(section, "restarting") || !strings.Contains(section, "hooks-service") {
		t.Fatalf("not-connected section %q", section)
	}
}

// blockKinds reports which block types a Block Kit body carries, and whether
// any actions block has a button.
func blockKinds(t *testing.T, raw json.RawMessage) (section, actions, button bool) {
	t.Helper()
	var blocks []map[string]any
	if err := json.Unmarshal(raw, &blocks); err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		switch b["type"] {
		case "section":
			section = true
		case "actions":
			actions = true
			els, _ := b["elements"].([]any)
			for _, e := range els {
				if el, ok := e.(map[string]any); ok && el["type"] == "button" {
					button = true
				}
			}
		}
	}
	return section, actions, button
}

// TestSlackSetupRepliesWithoutPublicBase pins the unset -public-base-url
// case: the set-up replies must not carry a relative url button (Slack
// refuses one) or a "Visit /" link, but the rest of the instructions stay.
func TestSlackSetupRepliesWithoutPublicBase(t *testing.T) {
	s := &Slack{}
	text := s.noServerText()
	if strings.Contains(text, "Visit") || strings.Contains(text, "http") {
		t.Fatalf("no-server text with no base URL %q", text)
	}
	if !strings.Contains(text, "Team setup") || !strings.Contains(text, "Sign in with Slack") {
		t.Fatalf("no-server text lost its instructions: %q", text)
	}
	if section, actions, button := blockKinds(t, s.noServerBlocks()); !section || actions || button {
		t.Fatalf("no-server blocks with no base URL: section=%v actions=%v button=%v", section, actions, button)
	}
	if _, actions, button := blockKinds(t, s.notConnectedBlocks()); actions || button {
		t.Fatalf("not-connected blocks with no base URL: actions=%v button=%v", actions, button)
	}
}

func TestSlackNoServer(t *testing.T) {
	f := newSlackFixture(t)
	// A connected stream, but never identified.
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-bob", "D-9", "hello", nil), true, 0)
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.api.mu.Lock()
		var msg *slackMessage
		if len(f.api.messages) > 0 {
			m := f.api.messages[0]
			msg = &m
		}
		f.api.mu.Unlock()
		if msg != nil {
			if msg.Channel != "D-9" {
				t.Fatalf("reply %+v", msg)
			}
			checkNoServerReply(t, *msg)
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no no-server reply")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSlackNoServerGuest pins that a guest with no bound server gets one
// line saying bb is for members, with no blocks or button, instead of the
// set-up reply.
func TestSlackNoServerGuest(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-guest", "D-9", "hello", nil), true, 0)
	msgs := f.waitMessages(1)
	if len(msgs) != 1 {
		t.Fatalf("posted %d messages, want 1", len(msgs))
	}
	if msgs[0].Channel != "D-9" || msgs[0].Text != "bb is for members of this workspace" || msgs[0].Blocks != nil {
		t.Fatalf("guest reply %+v", msgs[0])
	}
}

// TestSlackNoServerStranger pins that a Slack Connect stranger with no bound
// server is dropped without a reply, and that the drop is logged with the
// user id and channel and no text.
func TestSlackNoServerStranger(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-ext", "D-9", "hello", nil), true, 0)
	// Wait for the route goroutine's drop log rather than a fixed sleep, so
	// a loaded -race run does not race it.
	deadline := time.Now().Add(5 * time.Second)
	var logs string
	for {
		logs = f.logged()
		if strings.Contains(logs, "no-server notice dropped") && strings.Contains(logs, "U-ext") && strings.Contains(logs, "D-9") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stranger drop not logged with user and channel: %s", logs)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(f.posted()); got != 0 {
		t.Fatalf("stranger posted %d messages, want 0", got)
	}
}

// TestSlackAskClassCached pins that a member's classification is cached: a
// second event from the same user within the TTL makes no second users.info
// call.
func TestSlackAskClassCached(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-bob", "D-9", "one", nil), true, 0)
	f.waitMessages(1)
	f.api.mu.Lock()
	first := f.api.userInfoRequests
	f.api.mu.Unlock()
	if first != 1 {
		t.Fatalf("users.info calls after first event = %d, want 1", first)
	}
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-bob", "D-9", "two", map[string]any{"ts": "222.333"}), true, 0)
	f.waitMessages(2)
	f.api.mu.Lock()
	second := f.api.userInfoRequests
	f.api.mu.Unlock()
	if second != 1 {
		t.Fatalf("users.info calls after second event = %d, want 1 (cached)", second)
	}
}

// TestSlackNoServerLookupErrorNotCached pins that a users.info failure falls
// back to the set-up reply and is not cached, so the next event reads
// users.info again.
func TestSlackNoServerLookupErrorNotCached(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	// An unknown user makes users.info answer user_not_found: the reply
	// falls back to the set-up reply.
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-unknown", "D-9", "one", nil), true, 0)
	checkNoServerReply(t, f.waitMessages(1)[0])
	// The failure is not cached: the next event reads users.info again.
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-unknown", "D-9", "two", map[string]any{"ts": "222.333"}), true, 0)
	checkNoServerReply(t, f.waitMessages(2)[1])
	f.api.mu.Lock()
	calls := f.api.userInfoRequests
	f.api.mu.Unlock()
	if calls != 2 {
		t.Fatalf("users.info calls = %d, want 2 (error not cached)", calls)
	}
}

// TestSlackNotConnectedReply pins the reply for a user who was bound earlier
// and whose connection is now gone: not-connected, not "not set up".
func TestSlackNotConnectedReply(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes, closeAlice := f.openStream()
	if code, _ := f.identify(alice, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("identify: %d", code)
	}
	// A message while bound records the binding.
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	closeAlice()
	waitDeregistered(t, f, alice)

	// A new session after the connection dropped: not connected.
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "hello again", map[string]any{"ts": "222.333"}), true, 0)
	msgs := f.waitMessages(1)
	if msgs[0].Channel != "D-1" || msgs[0].ThreadTS != "222.333" {
		t.Fatalf("reply %+v", msgs[0])
	}
	checkNotConnectedReply(t, msgs[0])
}

// TestSlackNoServerForNeverBound pins that a user never bound, outside the
// startup grace, still gets the set-up reply.
func TestSlackNoServerForNeverBound(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-bob", "D-9", "hello", nil), true, 0)
	msgs := f.waitMessages(1)
	checkNoServerReply(t, msgs[0])
}

// TestSlackNotConnectedDuringStartupGrace pins that in the grace after the
// service starts, even a never-seen user is told not connected.
func TestSlackNotConnectedDuringStartupGrace(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.markStarted()
	f.stream()
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-bob", "D-9", "hello", nil), true, 0)
	msgs := f.waitMessages(1)
	checkNotConnectedReply(t, msgs[0])
}

// TestSlackNoServerAfterWindow pins that a user last bound longer than the
// window ago gets the set-up reply.
func TestSlackNoServerAfterWindow(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes, closeAlice := f.openStream()
	if code, _ := f.identify(alice, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("identify: %d", code)
	}
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	closeAlice()
	waitDeregistered(t, f, alice)

	f.now = f.now.Add(15 * 24 * time.Hour)
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "hello again", map[string]any{"ts": "222.333"}), true, 0)
	msgs := f.waitMessages(1)
	checkNoServerReply(t, msgs[0])
}

// TestSlackNotConnectedDedupe pins that one session gets one not-connected
// notice within the dedupe window, that a different session gets its own,
// and that the same session after the window posts again.
func TestSlackNotConnectedDedupe(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes, closeAlice := f.openStream()
	if code, _ := f.identify(alice, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("identify: %d", code)
	}
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	closeAlice()
	waitDeregistered(t, f, alice)

	// Two messages in one session inside the window post one notice.
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "one", map[string]any{"ts": "222.333"}), true, 0)
	f.deliver(f.message("Ev-3", slackTeam, slackApp, "U-alice", "D-1", "two", map[string]any{"ts": "222.333"}), true, 0)
	f.waitMessages(1)
	time.Sleep(200 * time.Millisecond)
	if got := len(f.posted()); got != 1 {
		t.Fatalf("same session posted %d notices, want 1", got)
	}

	// A different session posts again.
	f.deliver(f.message("Ev-4", slackTeam, slackApp, "U-alice", "D-1", "other", map[string]any{"ts": "333.444"}), true, 0)
	f.waitMessages(2)

	// After the window, the first session posts again.
	f.now = f.now.Add(6 * time.Minute)
	f.deliver(f.message("Ev-5", slackTeam, slackApp, "U-alice", "D-1", "again", map[string]any{"ts": "222.333"}), true, 0)
	msgs := f.waitMessages(3)
	for _, m := range msgs {
		checkNotConnectedReply(t, m)
	}
}

// TestSlackSilentNotConnected pins that a silent event with no connection
// posts nothing even for a recently bound user, and that the
// bound-but-not-draining case still posts the not-reading reply.
func TestSlackSilentNotConnected(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes, closeAlice := f.openStream()
	if code, _ := f.identify(alice, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("identify: %d", code)
	}
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	closeAlice()
	waitDeregistered(t, f, alice)

	// A silent wake for the same user posts nothing.
	f.slack.route(slackRouted{Action: "block_action", Tagged: true, Channel: "C-1", User: "U-alice", Silent: true, At: f.now})
	time.Sleep(200 * time.Millisecond)
	if got := len(f.posted()); got != 0 {
		t.Fatalf("silent wake posted %d notices", got)
	}

	// A bound server that is not draining still gets the not-reading reply.
	conn, err := f.srv.Registry.Open("10.0.0.9")
	if err != nil {
		t.Fatal(err)
	}
	f.srv.Registry.Identify(conn, "slack", "U-bob", "Bob", nil)
	for i := 0; i < cap(conn.SlackWakes); i++ {
		conn.SlackWakes <- SlackWake{}
	}
	f.slack.route(slackRouted{Session: "D-2:1.2", Action: "message", Channel: "D-2", Thread: "1.2", User: "U-bob", Text: "hi", At: f.now})
	msgs := f.waitMessages(1)
	if !strings.Contains(msgs[0].Text, "not reading") || msgs[0].Blocks != nil {
		t.Fatalf("not-reading reply %+v", msgs[0])
	}
}

// TestSlackChannelMention pins the phase-2 routing: an app_mention in a
// channel wakes the asker's server with the mention marker, the channel id
// and the asker's user id.
func TestSlackChannelMention(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> build this",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")
	if wk.Source != "slack" || !wk.Mention || wk.Action != "message" || wk.Channel != "C-1" ||
		wk.Asker.ID != "U-alice" || wk.Owner.ID != "U-alice" || !wk.FromOwner || wk.Comment.Untrusted ||
		wk.Comment.Text != "@bb build this" || wk.TS != "111.222" {
		t.Fatalf("wake %+v", wk)
	}

	// A threaded mention uses the root ts and the same channel.
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "more",
	}), true, 0)
	if wk := wakeSlack(t, wakes, "C-1:111.222"); wk.Comment.Text != "more" || wk.Thread != "111.222" || !wk.Mention {
		t.Fatalf("thread wake %+v", wk)
	}
	_ = conn
}

// TestSlackHistoryOnFirstWake pins BB-162: the first wake of a session whose
// waking message is a reply in an existing thread carries the thread's
// earlier messages, oldest first, with names resolved and the bot's own
// posts marked as bb.
func TestSlackHistoryOnFirstWake(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// The thread opened with someone else's message and bb was tagged later.
	f.api.setReplies("111.222",
		map[string]any{"ts": "111.222", "user": "U-bob", "text": "Hello. What is this and how do I use it"},
		map[string]any{"ts": "222.333", "user": slackBotUser, "bot_id": slackBotID, "text": "<@U-alice> earlier line"},
	)
	f.deliver(f.event("Ev-hist", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> give him the down low",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")

	want := []SlackHistoryMessage{
		{TS: "111.222", User: SlackHistoryUser{ID: "U-bob", Name: "Bob"}, Text: "Hello. What is this and how do I use it"},
		{TS: "222.333", User: SlackHistoryUser{ID: slackBotUser, Name: "bb"}, Text: "@Alice earlier line"},
	}
	if !reflect.DeepEqual(wk.History, want) {
		t.Fatalf("history %+v, want %+v", wk.History, want)
	}
	if wk.Comment.Text != "@bb give him the down low" {
		t.Fatalf("comment text %q", wk.Comment.Text)
	}

	// The lookup asked Slack for the thread up to the waking message, and
	// nothing after it.
	f.api.mu.Lock()
	forms := append([]url.Values(nil), f.api.replyForms...)
	f.api.mu.Unlock()
	if len(forms) != 1 {
		t.Fatalf("conversations.replies calls %d, want 1", len(forms))
	}
	if forms[0].Get("channel") != "C-1" || forms[0].Get("ts") != "111.222" ||
		forms[0].Get("latest") != "333.444" || forms[0].Get("inclusive") != "false" {
		t.Fatalf("replies form %v", forms[0])
	}
	data, _ := json.Marshal(wk)
	if !strings.Contains(string(data), `"history":[`) {
		t.Fatalf("wake JSON does not carry history: %s", data)
	}
}

// TestSlackHistoryPrivateAndDM pins that a private channel and a threaded DM
// behave the same as a public channel: the first wake carries the earlier
// messages.
func TestSlackHistoryPrivateAndDM(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.setReplies("111.222", map[string]any{"ts": "111.222", "user": "U-bob", "text": "private earlier"})
	f.deliver(f.event("Ev-group", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "G-1", "ts": "222.333", "thread_ts": "111.222", "text": "<@U-bb> private",
	}), true, 0)
	if g := wakeSlack(t, wakes, "G-1:111.222"); len(g.History) != 1 || g.History[0].Text != "private earlier" {
		t.Fatalf("private-channel history %+v", g.History)
	}

	f.api.setReplies("444.555", map[string]any{"ts": "444.555", "user": "U-bob", "text": "dm earlier"})
	f.deliver(f.event("Ev-dmhist", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "im", "user": "U-alice", "channel": "D-1", "ts": "555.666", "thread_ts": "444.555", "text": "dm reply",
	}), true, 0)
	if d := wakeSlack(t, wakes, "D-1:444.555"); len(d.History) != 1 || d.History[0].Text != "dm earlier" {
		t.Fatalf("dm history %+v", d.History)
	}
}

// TestSlackHistoryFiltersLaterPages pins the Slack quirk the reviewer noted:
// once a cursor is passed, latest/inclusive are not applied, so a later page
// can carry messages at or after the waking message. They are filtered per
// page before the newest-50 cap, so the cap keeps 50 earlier messages rather
// than losing some to messages that are then dropped.
func TestSlackHistoryFiltersLaterPages(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.replyPageSize = 10
	f.api.mu.Unlock()
	var msgs []map[string]any
	for i := 1; i <= 52; i++ {
		msgs = append(msgs, map[string]any{"ts": fmt.Sprintf("%03d.000", i), "user": "U-bob", "text": "m"})
	}
	for i := 200; i <= 204; i++ {
		msgs = append(msgs, map[string]any{"ts": fmt.Sprintf("%03d.000", i), "user": "U-bob", "text": "after"})
	}
	f.api.setReplies("000.000", msgs...)
	f.deliver(f.event("Ev-later", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "200.000", "thread_ts": "000.000", "text": "<@U-bb> hi",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:000.000")
	if len(wk.History) != maxSlackHistoryMessages+1 {
		t.Fatalf("history has %d entries, want %d", len(wk.History), maxSlackHistoryMessages+1)
	}
	if wk.History[0].Text != slackHistoryClipMarker || wk.History[1].TS != "003.000" || wk.History[len(wk.History)-1].TS != "052.000" {
		t.Fatalf("history kept %q..%q (first %+v), want 003.000..052.000", wk.History[1].TS, wk.History[len(wk.History)-1].TS, wk.History[0])
	}
	for _, m := range wk.History {
		if m.Text == "after" {
			t.Fatalf("a message at or after the waking message reached history: %+v", m)
		}
	}
}

// TestSlackHistoryAbsentOnFollowUp pins that a follow-up in a live session
// carries no history and makes no Slack call, so its wake is byte-identical
// to before the field existed.
func TestSlackHistoryAbsentOnFollowUp(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.mentionGrace = 30 * time.Millisecond
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	session := "C-1:111.222"
	f.deliver(f.event("Ev-start", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> start",
	}), true, 0)
	start := wakeSlack(t, wakes, session)
	if start.History != nil {
		t.Fatalf("thread-start wake carries history %+v", start.History)
	}
	if out := f.subscribe("slack", conn, []Watch{{Kind: "session", ID: session, Capability: start.Capability}}); len(out.Leases) != 1 {
		t.Fatalf("lease: %+v", out)
	}

	// The thread now has an earlier message, but the session is live, so the
	// follow-up carries none.
	f.api.setReplies("111.222", map[string]any{"ts": "111.222", "user": "U-alice", "text": "start"})
	f.deliver(f.event("Ev-follow", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "222.333", "thread_ts": "111.222", "text": "and another thing",
	}), true, 0)
	follow := wakeSlack(t, wakes, session)
	if follow.History != nil {
		t.Fatalf("follow-up wake carries history %+v", follow.History)
	}
	data, _ := json.Marshal(follow)
	if strings.Contains(string(data), "history") {
		t.Fatalf("follow-up wake JSON carries history: %s", data)
	}
	f.api.mu.Lock()
	n := f.api.replyRequests
	f.api.mu.Unlock()
	if n != 0 {
		t.Fatalf("conversations.replies called %d times, want 0", n)
	}
}

// TestSlackHistoryNoFetchOnThreadStart pins that a thread bb started — a DM
// root or a top-level mention, whose waking message is its own thread root —
// has no earlier messages and makes no fetch.
func TestSlackHistoryNoFetchOnThreadStart(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.setReplies("111.222", map[string]any{"ts": "111.222", "user": "U-alice", "text": "hello"})
	f.deliver(f.message("Ev-dm", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	if wk := wakeSlack(t, wakes, "D-1:111.222"); wk.History != nil {
		t.Fatalf("dm root carries history %+v", wk.History)
	}

	f.api.setReplies("222.333", map[string]any{"ts": "222.333", "user": "U-alice", "text": "hi"})
	f.deliver(f.event("Ev-top", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "222.333", "text": "<@U-bb> hi",
	}), true, 0)
	if wk := wakeSlack(t, wakes, "C-1:222.333"); wk.History != nil {
		t.Fatalf("top-level mention carries history %+v", wk.History)
	}

	f.api.mu.Lock()
	n := f.api.replyRequests
	f.api.mu.Unlock()
	if n != 0 {
		t.Fatalf("conversations.replies called %d times, want 0", n)
	}
}

// TestSlackHistoryNoFetchForDroppedOrRefused pins the approval limit: a
// message the adapter drops, and a mention from a Slack Connect stranger it
// refuses, never trigger conversations.replies.
func TestSlackHistoryNoFetchForDroppedOrRefused(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// An untagged reply in a thread with no live lease or route is dropped.
	f.deliver(f.event("Ev-drop", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "333.444", "thread_ts": "111.222", "text": "not for bb",
	}), true, 0)
	noSlackWake(t, wakes)

	// A mention from a Slack Connect stranger is refused at the no-server
	// reply, so it never fetches either.
	f.deliver(f.event("Ev-stranger", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-ext", "channel": "C-2", "ts": "444.555", "thread_ts": "111.222", "text": "<@U-bb> hello",
	}), true, 0)
	noSlackWake(t, wakes)

	f.api.mu.Lock()
	n := f.api.replyRequests
	f.api.mu.Unlock()
	if n != 0 {
		t.Fatalf("conversations.replies called %d times, want 0", n)
	}
}

// TestSlackHistoryTimeoutDegrades pins that a slow lookup sends the wake
// without history rather than holding or dropping it.
func TestSlackHistoryTimeoutDegrades(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.historyTimeout = 30 * time.Millisecond
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.setReplies("111.222", map[string]any{"ts": "111.222", "user": "U-bob", "text": "hello"})
	f.api.mu.Lock()
	f.api.replyDelay = 200 * time.Millisecond
	f.api.mu.Unlock()

	f.deliver(f.event("Ev-slow", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> hello",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")
	if wk.History != nil {
		t.Fatalf("timed-out lookup carried history %+v", wk.History)
	}
	if wk.Comment.Text != "@bb hello" {
		t.Fatalf("wake text %q", wk.Comment.Text)
	}
}

// TestSlackHistoryErrorDegrades pins that a refused lookup sends the wake
// without history.
func TestSlackHistoryErrorDegrades(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.replyError = "missing_scope"
	f.api.mu.Unlock()

	f.deliver(f.event("Ev-err", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> hello",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")
	if wk.History != nil {
		t.Fatalf("errored lookup carried history %+v", wk.History)
	}
	if wk.Comment.Text != "@bb hello" {
		t.Fatalf("wake text %q", wk.Comment.Text)
	}
}

// TestSlackHistoryClipMarker pins the oldest-end clipping: over the message
// cap or the text budget the oldest are dropped and a marker is prepended.
func TestSlackHistoryClipMarker(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// 60 short messages across three pages: the newest 50 are kept, the
	// oldest 10 dropped.
	f.api.mu.Lock()
	f.api.replyPageSize = 25
	f.api.mu.Unlock()
	msgs := make([]map[string]any, 0, 60)
	for i := 1; i <= 60; i++ {
		msgs = append(msgs, map[string]any{"ts": fmt.Sprintf("%03d.000", i), "user": "U-bob", "text": "m"})
	}
	f.api.setReplies("000.000", msgs...)
	f.deliver(f.event("Ev-cap", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "999.000", "thread_ts": "000.000", "text": "<@U-bb> hi",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:000.000")
	if len(wk.History) != maxSlackHistoryMessages+1 {
		t.Fatalf("capped history has %d entries, want %d", len(wk.History), maxSlackHistoryMessages+1)
	}
	if wk.History[0].Text != slackHistoryClipMarker {
		t.Fatalf("first history entry %+v, want the clip marker", wk.History[0])
	}
	if wk.History[1].TS != "011.000" || wk.History[len(wk.History)-1].TS != "060.000" {
		t.Fatalf("capped history kept %q..%q, want 011.000..060.000", wk.History[1].TS, wk.History[len(wk.History)-1].TS)
	}
	// Pagination followed the cursor to the end of the thread, so the newest
	// messages are the ones kept.
	f.api.mu.Lock()
	requests := f.api.replyRequests
	f.api.mu.Unlock()
	if requests != 3 {
		t.Fatalf("conversations.replies calls %d, want 3 pages", requests)
	}

	// A text budget smaller than the total drops the oldest until it fits.
	f2 := newSlackFixture(t)
	_, wakes2 := f2.pod(f2.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	big := strings.Repeat("x", slackHistoryTextBudget/2)
	f2.api.setReplies("000.000",
		map[string]any{"ts": "001.000", "user": "U-bob", "text": big},
		map[string]any{"ts": "002.000", "user": "U-bob", "text": big},
		map[string]any{"ts": "003.000", "user": "U-bob", "text": big},
	)
	f2.deliver(f2.event("Ev-budget", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "999.000", "thread_ts": "000.000", "text": "<@U-bb> hi",
	}), true, 0)
	w2 := wakeSlack(t, wakes2, "C-1:000.000")
	if len(w2.History) != 3 || w2.History[0].Text != slackHistoryClipMarker {
		t.Fatalf("budgeted history %+v", w2.History)
	}
	if w2.History[1].TS != "002.000" || w2.History[2].TS != "003.000" {
		t.Fatalf("budgeted history kept %q, %q; want the newest two", w2.History[1].TS, w2.History[2].TS)
	}

	// A single message longer than the whole budget is clipped to the budget,
	// ellipsis included, so the bound is exact.
	f3 := newSlackFixture(t)
	_, wakes3 := f3.pod(f3.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f3.api.setReplies("000.000", map[string]any{
		"ts": "001.000", "user": "U-bob", "text": strings.Repeat("x", slackHistoryTextBudget*2),
	})
	f3.deliver(f3.event("Ev-single", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "999.000", "thread_ts": "000.000", "text": "<@U-bb> hi",
	}), true, 0)
	w3 := wakeSlack(t, wakes3, "C-1:000.000")
	if len(w3.History) != 1 || len(w3.History[0].Text) > slackHistoryTextBudget {
		t.Fatalf("single-message history has %d entries, %d bytes of text; want 1 entry within %d", len(w3.History), len(w3.History[0].Text), slackHistoryTextBudget)
	}
}

// TestSlackHistoryFilesNotRouted pins the approval limit: the files named in
// history are metadata only, so the file endpoint cannot serve their bytes.
func TestSlackHistoryFilesNotRouted(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.fileBodies["F-hist"] = []byte("secret history bytes")
	f.api.fileMimes["F-hist"] = "text/plain"
	f.api.mu.Unlock()

	f.api.setReplies("111.222", map[string]any{
		"ts": "111.222", "user": "U-bob", "text": "see this",
		"files": []map[string]any{{"id": "F-hist", "name": "hist.txt", "mimetype": "text/plain", "size": 20, "url_private": f.fileURL("F-hist"), "filetype": "text"}},
	})
	f.deliver(f.event("Ev-histfile", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> what is this",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")
	if len(wk.History) != 1 || len(wk.History[0].Files) != 1 || wk.History[0].Files[0].ID != "F-hist" {
		t.Fatalf("history files %+v", wk.History)
	}

	// The history file's id was never remembered for the file endpoint, so
	// its bytes cannot be served and Slack is never called.
	if code, _ := f.getFile("C-1:111.222", "F-hist", conn); code != http.StatusNotFound {
		t.Fatalf("history file served: %d", code)
	}
	f.api.mu.Lock()
	fetches := f.api.fileRequests
	f.api.mu.Unlock()
	if fetches != 0 {
		t.Fatalf("history file fetched %d times, want 0", fetches)
	}
}

// TestSlackUntaggedThreadReply pins the BB-130 rule: an untagged reply inside
// a channel thread bb is already part of reaches the session's owner, from
// the owner as themselves and from anyone else as untrusted. A top-level
// channel message and a reply in a thread with no lease or route are dropped.
func TestSlackUntaggedThreadReply(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.mentionGrace = 30 * time.Millisecond
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	// A mention starts the session and leases it to Alice.
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> start",
	}), true, 0)
	wake := wakeSlack(t, aliceWakes, session)
	if out := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}}); len(out.Leases) != 1 {
		t.Fatalf("lease: %+v", out)
	}

	// An untagged reply from the owner routes to the lessee, tagged false and
	// mention false.
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "222.333", "thread_ts": "111.222", "text": "here is more",
	}), true, 0)
	wk := wakeSlack(t, aliceWakes, session)
	if wk.Tagged || wk.Mention || !wk.FromOwner || wk.Comment.Untrusted || wk.Comment.Text != "here is more" {
		t.Fatalf("owner untagged wake %+v", wk)
	}
	if wk.Asker.ID != "U-alice" || wk.Owner.ID != "U-alice" || wk.Channel != "C-1" || wk.Thread != "111.222" {
		t.Fatalf("owner untagged identities %+v", wk)
	}

	// The same from a non-owner routes to the lessee as untrusted.
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-bob", "channel": "C-1",
		"ts": "333.444", "thread_ts": "111.222", "text": "me too",
	}), true, 0)
	second := wakeSlack(t, aliceWakes, session)
	if second.Tagged || second.Mention || second.FromOwner || !second.Comment.Untrusted || second.Comment.Text != "me too" {
		t.Fatalf("non-owner untagged wake %+v", second)
	}
	if second.Asker.ID != "U-bob" || second.Owner.ID != "U-alice" {
		t.Fatalf("non-owner untagged identities %+v", second)
	}
	noSlackWake(t, bobWakes)

	// A top-level channel message and a reply in an unknown thread are
	// dropped, in memory, with only the aggregate counter kept.
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "444.555", "text": "top level",
	}), true, 0)
	f.deliver(f.event("Ev-5", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "555.666", "thread_ts": "999.000", "text": "unknown thread",
	}), true, 0)
	noSlackWake(t, aliceWakes)
	if got := f.slack.droppedChannelMessages.Load(); got != 2 {
		t.Fatalf("dropped channel messages %d, want 2", got)
	}

	// A private channel (channel_type group) works the same: a mention
	// follows the thread, then an untagged reply reaches the lessee.
	gsession := "G-1:111.222"
	f.deliver(f.event("Ev-6", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "G-1", "ts": "111.222", "text": "<@U-bb> private start",
	}), true, 0)
	gwake := wakeSlack(t, aliceWakes, gsession)
	if out := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: gsession, Capability: gwake.Capability}}); len(out.Leases) != 1 {
		t.Fatalf("group lease: %+v", out)
	}
	f.deliver(f.event("Ev-7", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "group", "user": "U-bob", "channel": "G-1",
		"ts": "222.333", "thread_ts": "111.222", "text": "private reply",
	}), true, 0)
	gwk := wakeSlack(t, aliceWakes, gsession)
	if gwk.Tagged || gwk.FromOwner || !gwk.Comment.Untrusted || gwk.Comment.Text != "private reply" {
		t.Fatalf("group untagged wake %+v", gwk)
	}
}

// TestSlackTaggedReplyOneWake pins the message dedupe: a tagged reply arrives
// as both app_mention and message.channels, with different event ids but the
// same channel and message ts, and yields exactly one wake. It holds either
// delivery order: whichever half arrives first routes.
func TestSlackTaggedReplyOneWake(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.mentionGrace = 200 * time.Millisecond
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	session := "C-1:111.222"
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> start",
	}), true, 0)
	wake := wakeSlack(t, wakes, session)
	if out := f.subscribe("slack", conn, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}}); len(out.Leases) != 1 {
		t.Fatalf("lease: %+v", out)
	}

	// The message.channels half arrives first. It tags the bot, so it routes
	// as the mention directly; the app_mention half then deduplicates.
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "222.333", "thread_ts": "111.222", "text": "<@U-bb> question",
	}), true, 0)
	time.Sleep(10 * time.Millisecond)
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "222.333", "thread_ts": "111.222", "text": "<@U-bb> question",
	}), true, 0)
	wk := wakeSlack(t, wakes, session)
	if !wk.Tagged || !wk.Mention || wk.Comment.Text != "@bb question" {
		t.Fatalf("superseding wake %+v", wk)
	}
	f.slack.mu.Lock()
	pending := len(f.slack.pending)
	f.slack.mu.Unlock()
	if pending != 0 {
		t.Fatalf("the held message was not superseded: %d pending", pending)
	}
	noSlackWake(t, wakes)

	// The app_mention half arrives first: the later message.channels half is
	// dropped, and the one wake is tagged.
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> again",
	}), true, 0)
	if wk := wakeSlack(t, wakes, session); !wk.Tagged || wk.Comment.Text != "@bb again" {
		t.Fatalf("mention-first wake %+v", wk)
	}
	f.deliver(f.event("Ev-5", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "333.444", "thread_ts": "111.222", "text": "<@U-bb> again",
	}), true, 0)
	noSlackWake(t, wakes)
}

// TestSlackTaggedChannelMessage pins BB-157: a channel or private-channel
// message that tags the bot routes as a mention even when its thread has no
// live session, so a lost app_mention half no longer loses the mention. It
// covers a tagged thread reply, a tagged top-level message, an untagged drop,
// and both delivery orders of the message/app_mention pair yielding one wake.
func TestSlackTaggedChannelMessage(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A tagged thread reply in a thread bb is not part of routes as a
	// mention to the asker's server.
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-1",
		"ts": "222.333", "thread_ts": "111.222", "text": "<@U-bb> question",
	}), true, 0)
	wk := wakeSlack(t, wakes, "C-1:111.222")
	if !wk.Tagged || !wk.Mention || !wk.FromOwner || wk.Comment.Untrusted ||
		wk.Comment.Text != "@bb question" || wk.Channel != "C-1" || wk.Thread != "111.222" ||
		wk.Asker.ID != "U-alice" || wk.Owner.ID != "U-alice" || wk.TS != "222.333" {
		t.Fatalf("tagged thread wake %+v", wk)
	}

	// A tagged top-level message gets the same treatment, with the message's
	// own ts as the thread root.
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-2",
		"ts": "333.444", "text": "<@U-bb> top level",
	}), true, 0)
	top := wakeSlack(t, wakes, "C-2:333.444")
	if !top.Tagged || !top.Mention || top.Comment.Text != "@bb top level" ||
		top.Thread != "333.444" || top.TS != "333.444" {
		t.Fatalf("tagged top-level wake %+v", top)
	}

	// An untagged message in a thread with no live session is still dropped.
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-3",
		"ts": "444.555", "thread_ts": "111.222", "text": "not for bb",
	}), true, 0)
	noSlackWake(t, wakes)
	if got := f.slack.droppedChannelMessages.Load(); got != 1 {
		t.Fatalf("dropped channel messages %d, want 1", got)
	}

	// The message half first: it routes as the mention and the app_mention
	// half with the same channel:ts is deduplicated.
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-4",
		"ts": "555.666", "thread_ts": "111.222", "text": "<@U-bb> first",
	}), true, 0)
	first := wakeSlack(t, wakes, "C-4:111.222")
	if !first.Tagged || !first.Mention || first.Comment.Text != "@bb first" {
		t.Fatalf("message-first wake %+v", first)
	}
	f.deliver(f.event("Ev-5", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-4",
		"ts": "555.666", "thread_ts": "111.222", "text": "<@U-bb> first",
	}), true, 0)
	noSlackWake(t, wakes)

	// The app_mention half first: the later message half is deduplicated.
	f.deliver(f.event("Ev-6", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-5",
		"ts": "666.777", "thread_ts": "111.222", "text": "<@U-bb> second",
	}), true, 0)
	second := wakeSlack(t, wakes, "C-5:111.222")
	if !second.Tagged || !second.Mention || second.Comment.Text != "@bb second" {
		t.Fatalf("mention-first wake %+v", second)
	}
	f.deliver(f.event("Ev-7", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-5",
		"ts": "666.777", "thread_ts": "111.222", "text": "<@U-bb> second",
	}), true, 0)
	noSlackWake(t, wakes)
}

// TestSlackUntaggedInert pins that the new message.channels/message.groups
// handling is inert unless the thread is already followed: without those
// events the DM and channel-mention paths behave exactly as before, and a
// channel message that does arrive for a thread with no lease or route is
// dropped.
func TestSlackUntaggedInert(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A DM still wakes, tagged and not a mention.
	f.deliver(f.message("Ev-dm", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	dm := wakeSlack(t, wakes, "D-1:111.222")
	if !dm.Tagged || dm.Mention || !dm.FromOwner || dm.Comment.Untrusted {
		t.Fatalf("dm wake %+v", dm)
	}

	// A channel mention still wakes, tagged and a mention.
	f.deliver(f.event("Ev-m", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> hi",
	}), true, 0)
	mention := wakeSlack(t, wakes, "C-1:111.222")
	if !mention.Tagged || !mention.Mention || !mention.FromOwner {
		t.Fatalf("mention wake %+v", mention)
	}

	// A channel message in a thread with no lease or route is dropped.
	f.deliver(f.event("Ev-c", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C-9",
		"ts": "222.333", "thread_ts": "111.222", "text": "not for bb",
	}), true, 0)
	noSlackWake(t, wakes)
	if got := f.slack.droppedChannelMessages.Load(); got != 1 {
		t.Fatalf("dropped channel messages %d, want 1", got)
	}
}

// TestSlackSessionLease covers the session-lease contract: a wake routed to
// the owner carries a capability that verifies for that user, a lease is
// admitted from it, and a forged, other-user or unidentified-connection
// attempt is refused. The capability is opaque and never logged.
func TestSlackSessionLease(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	session := "C-1:111.222"
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> build this",
	}), true, 0)
	wake := wakeSlack(t, aliceWakes, session)
	if wake.Capability == "" {
		t.Fatal("wake carries no capability")
	}
	if !f.slack.capabilityValid(session, "U-alice", wake.Capability) {
		t.Fatal("capability does not verify for the owner")
	}
	if f.slack.capabilityValid(session, "U-bob", wake.Capability) {
		t.Fatal("capability verifies for another user")
	}
	if strings.Contains(f.logged(), wake.Capability) {
		t.Fatalf("capability was logged:\n%s", f.logged())
	}

	// The lease is admitted, and the same user's renewal keeps it.
	out := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}})
	if len(out.Rejected) != 0 || len(out.Leases) != 1 || out.Leases[0].ID != session {
		t.Fatalf("subscribe %+v", out)
	}
	if !f.slack.allowed(session, "U-alice") || f.slack.allowed(session, "U-bob") {
		t.Fatalf("lease not held by alice: alice=%v bob=%v", f.slack.allowed(session, "U-alice"), f.slack.allowed(session, "U-bob"))
	}

	// A forged capability and another user's valid capability are refused.
	forged := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: "deadbeef"}})
	if len(forged.Leases) != 0 || len(forged.Rejected) != 1 || forged.Rejected[0].Reason != "forbidden" {
		t.Fatalf("forged: %+v", forged)
	}
	other := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: f.slack.leaseCapability(session, "U-bob")}})
	if len(other.Leases) != 0 || len(other.Rejected) != 1 || other.Rejected[0].Reason != "forbidden" {
		t.Fatalf("other-user capability: %+v", other)
	}

	// An unidentified connection cannot lease, even with a valid capability.
	anon, _ := f.stream()
	anonOut := f.subscribe("slack", anon, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}})
	if len(anonOut.Leases) != 0 || len(anonOut.Rejected) != 1 || anonOut.Rejected[0].Reason != "forbidden" {
		t.Fatalf("unidentified: %+v", anonOut)
	}

	// The capability never reaches the log, on the wake or the subscribe path.
	if strings.Contains(f.logged(), wake.Capability) {
		t.Fatalf("capability was logged:\n%s", f.logged())
	}
}

// TestSlackSessionLeaseSurvivesRestart proves the capability is derived from
// the signing secret, not from any per-process state: a new Slack value with
// the same secret admits a lease minted before it.
func TestSlackSessionLeaseSurvivesRestart(t *testing.T) {
	before := newSlackFixture(t)
	_, wakes := before.pod(before.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	session := "C-1:111.222"
	before.deliver(before.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> hi",
	}), true, 0)
	wake := wakeSlack(t, wakes, session)

	// A restart: a fresh service with the same signing secret, and a fresh
	// connection for the same user.
	after := newSlackFixture(t)
	alice, _ := after.pod(after.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	out := after.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}})
	if len(out.Rejected) != 0 || len(out.Leases) != 1 {
		t.Fatalf("lease after restart: %+v", out)
	}
	if !after.slack.allowed(session, "U-alice") {
		t.Fatal("the restarted service did not hold the lease")
	}
}

// TestSlackSessionLeaseOwned covers exclusivity: a second user's lease on a
// leased session is rejected owned, a mention by the second user routes to
// the lessee as untrusted, and the lessee may still reply after the bootstrap
// route table is gone.
func TestSlackSessionLeaseOwned(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	bob, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-alice", "channel": "C-1", "ts": "111.222", "text": "<@U-bb> build this",
	}), true, 0)
	wake := wakeSlack(t, aliceWakes, session)
	if out := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: wake.Capability}}); len(out.Leases) != 1 {
		t.Fatalf("alice lease: %+v", out)
	}

	// Bob presents a valid capability for himself, but Alice holds the
	// session: rejected owned, and Bob's lease does not displace hers.
	bobOut := f.subscribe("slack", bob, []Watch{{Kind: "session", ID: session, Capability: f.slack.leaseCapability(session, "U-bob")}})
	if len(bobOut.Leases) != 0 || len(bobOut.Rejected) != 1 || bobOut.Rejected[0].Reason != "owned" {
		t.Fatalf("bob lease: %+v", bobOut)
	}
	if !f.slack.allowed(session, "U-alice") || f.slack.allowed(session, "U-bob") {
		t.Fatalf("owner moved: alice=%v bob=%v", f.slack.allowed(session, "U-alice"), f.slack.allowed(session, "U-bob"))
	}

	// Bob's mention routes to Alice's server as untrusted, never to his, and
	// carries Alice's capability.
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-bob", "channel": "C-1", "ts": "222.333", "thread_ts": "111.222", "text": "<@U-bb> me too",
	}), true, 0)
	second := wakeSlack(t, aliceWakes, session)
	if second.Owner.ID != "U-alice" || second.Asker.ID != "U-bob" || second.FromOwner || !second.Comment.Untrusted {
		t.Fatalf("second wake %+v", second)
	}
	if !f.slack.capabilityValid(session, "U-alice", second.Capability) {
		t.Fatalf("second wake capability %q", second.Capability)
	}
	noSlackWake(t, bobWakes)

	// Clear the bootstrap route table: the lease alone still allows the owner
	// to reply and refuses the second user.
	f.slack.mu.Lock()
	f.slack.routed = nil
	f.slack.mu.Unlock()
	if code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."}); code != http.StatusOK {
		t.Fatalf("owner reply: %d %s", code, body)
	}
	if code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": bob, "text": "hi"}); code != http.StatusForbidden || !strings.Contains(string(body), "not-routed") {
		t.Fatalf("second reply: %d %s", code, body)
	}
}

// TestSlackSessionLeaseReleasedOnClose pins that a lease is bound to the
// connection: closing the stream releases the session for another user.
func TestSlackSessionLeaseReleasedOnClose(t *testing.T) {
	f := newSlackFixture(t)
	alice, _, closeAlice := f.openStream()
	if code, _ := f.identify(alice, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("identify alice: %d", code)
	}
	session := "C-1:111.222"
	if out := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: f.slack.leaseCapability(session, "U-alice")}}); len(out.Leases) != 1 {
		t.Fatalf("alice lease: %+v", out)
	}
	closeAlice()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.Registry.Get(alice) != nil {
		if time.Now().After(deadline) {
			t.Fatal("connection still registered after close")
		}
		time.Sleep(10 * time.Millisecond)
	}
	bob, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))
	out := f.subscribe("slack", bob, []Watch{{Kind: "session", ID: session, Capability: f.slack.leaseCapability(session, "U-bob")}})
	if len(out.Leases) != 1 || len(out.Rejected) != 0 {
		t.Fatalf("bob lease after close: %+v", out)
	}
}

// TestSlackSessionOwnerSetOnce pins that a session's owner is set by the
// first routed wake and kept: a second Slack user mentioning bb in the same
// live thread is delivered to the owner's connection as untrusted, the
// owner's reply still works, and the second user's reply is refused.
func TestSlackSessionOwnerSetOnce(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	bob, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	mention := func(id, user, ts, text string) map[string]any {
		return f.event(id, slackTeam, slackApp, map[string]any{
			"type": "app_mention", "user": user, "channel": "C-1", "ts": ts, "thread_ts": "111.222", "text": text,
		})
	}

	f.deliver(mention("Ev-1", "U-alice", "111.222", "<@U-bb> build this"), true, 0)
	first := wakeSlack(t, aliceWakes, session)
	if first.Owner.ID != "U-alice" || first.Asker.ID != "U-alice" || !first.FromOwner || first.Comment.Untrusted {
		t.Fatalf("first wake %+v", first)
	}

	// A second person in the same live thread: routed to the owner's
	// connection, marked untrusted, and never to the second person's.
	f.deliver(mention("Ev-2", "U-bob", "222.333", "<@U-bb> me too"), true, 0)
	second := wakeSlack(t, aliceWakes, session)
	if second.Owner.ID != "U-alice" || second.Asker.ID != "U-bob" || second.FromOwner || !second.Comment.Untrusted {
		t.Fatalf("second wake %+v", second)
	}
	if second.Comment.Text != "@bb me too" {
		t.Fatalf("second text %q", second.Comment.Text)
	}
	noSlackWake(t, bobWakes)

	if !f.slack.allowed(session, "U-alice") || f.slack.allowed(session, "U-bob") {
		t.Fatalf("owner not fixed: alice=%v bob=%v", f.slack.allowed(session, "U-alice"), f.slack.allowed(session, "U-bob"))
	}

	// The owner's reply is accepted; the second person's is refused.
	if code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."}); code != http.StatusOK {
		t.Fatalf("owner reply: %d %s", code, body)
	}
	if code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": bob, "text": "hi"}); code != http.StatusForbidden || !strings.Contains(string(body), "not-routed") {
		t.Fatalf("second reply: %d %s", code, body)
	}
}

// TestSlackSessionOwnerSetOnceConcurrent pins the atomic check-and-store:
// two first mentions racing in one session settle on a single owner, and
// both wakes land on that owner's connection rather than splitting.
func TestSlackSessionOwnerSetOnceConcurrent(t *testing.T) {
	f := newSlackFixture(t)
	_, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	ev := func(user, text string) slackRouted {
		return slackRouted{Session: session, Action: "message", Mention: true, Channel: "C-1", Thread: "111.222", User: user, Text: text, At: f.now}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); f.slack.route(ev("U-alice", "a")) }()
	go func() { defer wg.Done(); f.slack.route(ev("U-bob", "b")) }()
	wg.Wait()

	// The SSE pump delivers asynchronously; collect both wakes.
	var aliceGot, bobGot []SlackWake
	deadline := time.After(5 * time.Second)
	for len(aliceGot)+len(bobGot) < 2 {
		select {
		case wk := <-aliceWakes:
			aliceGot = append(aliceGot, wk)
		case wk := <-bobWakes:
			bobGot = append(bobGot, wk)
		case <-deadline:
			t.Fatalf("wakes: alice=%d bob=%d", len(aliceGot), len(bobGot))
		}
	}
	if len(aliceGot)+len(bobGot) != 2 {
		t.Fatalf("wakes: alice=%d bob=%d", len(aliceGot), len(bobGot))
	}
	if len(aliceGot) != 2 && len(bobGot) != 2 {
		t.Fatalf("wakes split across owners: alice=%d bob=%d", len(aliceGot), len(bobGot))
	}
	aliceOwns, bobOwns := f.slack.allowed(session, "U-alice"), f.slack.allowed(session, "U-bob")
	if aliceOwns == bobOwns {
		t.Fatalf("owner is not exactly one: alice=%v bob=%v", aliceOwns, bobOwns)
	}
	if (len(aliceGot) == 2) != aliceOwns || (len(bobGot) == 2) != bobOwns {
		t.Fatalf("wakes do not match the owner: alice wakes=%d owns=%v; bob wakes=%d owns=%v",
			len(aliceGot), aliceOwns, len(bobGot), bobOwns)
	}
}

// TestSlackSessionLapsedReowned pins that the owner's own wake renews the
// route, and that once it lapses the next mentioner owns the session.
func TestSlackSessionLapsedReowned(t *testing.T) {
	f := newSlackFixture(t)
	// Identities have a one-hour lease; give them room so the keep window can
	// lapse while the connections stay identified.
	f.srv.Registry.Lease = 72 * time.Hour
	_, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	mention := func(id, user, ts, text string) map[string]any {
		return f.event(id, slackTeam, slackApp, map[string]any{
			"type": "app_mention", "user": user, "channel": "C-1", "ts": ts, "thread_ts": "111.222", "text": text,
		})
	}
	f.deliver(mention("Ev-1", "U-alice", "111.222", "first"), true, 0)
	wakeSlack(t, aliceWakes, session)

	// The owner's own wake renews the route: it is still live just short of
	// two keep windows because the second wake reset the clock.
	f.now = f.now.Add(DefaultSessionKeep - time.Minute)
	f.deliver(mention("Ev-2", "U-alice", "222.333", "again"), true, 0)
	wakeSlack(t, aliceWakes, session)
	if !f.slack.allowed(session, "U-alice") {
		t.Fatal("the owner's own wake did not renew the route")
	}

	// Past the keep window the route lapses, and the next mentioner owns it.
	f.now = f.now.Add(DefaultSessionKeep + time.Minute)
	f.deliver(mention("Ev-3", "U-bob", "333.444", "bob here"), true, 0)
	wk := wakeSlack(t, bobWakes, session)
	if wk.Owner.ID != "U-bob" || wk.Asker.ID != "U-bob" || !wk.FromOwner || wk.Comment.Untrusted {
		t.Fatalf("re-owned wake %+v", wk)
	}
	if f.slack.allowed(session, "U-alice") || !f.slack.allowed(session, "U-bob") {
		t.Fatalf("lapsed route not re-owned: alice=%v bob=%v", f.slack.allowed(session, "U-alice"), f.slack.allowed(session, "U-bob"))
	}
}

// TestSlackSecondPersonOwnerGoneNotice pins the drop when the owner's
// connection is gone: the second person gets a notice, the wake never
// reaches the second person's server, and the notice names no server or
// identity.
func TestSlackSecondPersonOwnerGoneNotice(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	session := "C-1:111.222"
	mention := func(id, user, ts string) map[string]any {
		return f.event(id, slackTeam, slackApp, map[string]any{
			"type": "app_mention", "user": user, "channel": "C-1", "ts": ts, "thread_ts": "111.222", "text": "<@U-bb> hi",
		})
	}
	f.deliver(mention("Ev-1", "U-alice", "111.222"), true, 0)
	wakeSlack(t, aliceWakes, session)

	// Alice's stream goes away; Bob mentions. The wake is dropped, never
	// routed to Bob, and the notice names nobody.
	f.srv.Registry.Close(f.srv.Registry.Get(alice))
	f.deliver(mention("Ev-2", "U-bob", "222.333"), true, 0)
	noSlackWake(t, bobWakes)

	deadline := time.Now().Add(5 * time.Second)
	for {
		f.api.mu.Lock()
		var msg *slackMessage
		if len(f.api.messages) > 0 {
			m := f.api.messages[0]
			msg = &m
		}
		f.api.mu.Unlock()
		if msg != nil {
			if msg.Channel != "C-1" || msg.ThreadTS != "111.222" {
				t.Fatalf("notice %+v", msg)
			}
			for _, name := range []string{"Alice", "U-alice", "Bob", "U-bob"} {
				if strings.Contains(msg.Text, name) {
					t.Fatalf("notice names %q: %q", name, msg.Text)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no notice for the dropped wake")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSlackChannelMentionNoServer pins the no-server reply for a channel
// mention: the service posts it itself, in the mention's channel and thread.
func TestSlackChannelMentionNoServer(t *testing.T) {
	f := newSlackFixture(t)
	// A connected stream, but never identified.
	f.stream()
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-bob", "channel": "C-9", "ts": "111.222", "text": "<@U-bb> hello",
	}), true, 0)
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.api.mu.Lock()
		var msg *slackMessage
		if len(f.api.messages) > 0 {
			m := f.api.messages[0]
			msg = &m
		}
		f.api.mu.Unlock()
		if msg != nil {
			if msg.Channel != "C-9" || msg.ThreadTS != "111.222" {
				t.Fatalf("reply %+v", msg)
			}
			checkNoServerReply(t, *msg)
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no no-server reply for channel mention")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestSlackMemberJoinedDropped pins that a member_joined_channel event is
// dropped for every user — the bot included, with or without an inviter —
// so no pod hears about a join and nothing is posted.
func TestSlackMemberJoinedDropped(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// A person joining, the bot's own join with an inviter, the bot's own
	// join with no inviter (an admin added the app from the integrations
	// page), and a join with no channel: all dropped.
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "member_joined_channel", "user": "U-bob", "inviter": "U-alice", "channel": "C-1",
	}), true, 0)
	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "member_joined_channel", "user": slackBotUser, "inviter": "U-alice", "channel": "C-1",
	}), true, 0)
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "member_joined_channel", "user": slackBotUser, "channel": "C-1",
	}), true, 0)
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "member_joined_channel", "user": slackBotUser, "inviter": "U-bob",
	}), true, 0)
	noSlackWake(t, wakes)
	time.Sleep(100 * time.Millisecond)
	f.api.mu.Lock()
	defer f.api.mu.Unlock()
	if len(f.api.messages) != 0 {
		t.Fatalf("join posted %+v", f.api.messages)
	}
}

// TestSlackInteractivity pins the signed public interactivity path: the same
// signature and timestamp window as /slack (so a replay is refused), guest
// refusal, and a valid block_action routing to the clicking user's server
// with the action id, value and response_url.
func TestSlackInteractivity(t *testing.T) {
	f := newSlackFixture(t)
	alice, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	const responseURL = "https://hooks.slack.com/actions/T1/B1/capability-secret"
	payload := func(user, channel string) map[string]any {
		return map[string]any{
			"type":         "block_actions",
			"response_url": responseURL,
			"user":         map[string]any{"id": user},
			"channel":      map[string]any{"id": channel},
			"actions":      []map[string]any{{"action_id": "bb_set_project", "value": "proj_x"}},
		}
	}

	// Unsigned and stale deliveries are refused before the ack.
	if code := f.interact(payload("U-alice", "C-1"), false, f.now); code != http.StatusUnauthorized {
		t.Fatalf("unsigned: %d", code)
	}
	if code := f.interact(payload("U-alice", "C-1"), true, f.now.Add(-6*time.Minute)); code != http.StatusUnauthorized {
		t.Fatalf("stale: %d", code)
	}
	// A guest is acked and dropped without routing; the drop is logged.
	if code := f.interact(payload("U-guest", "C-1"), true, f.now); code != http.StatusOK {
		t.Fatalf("guest: %d", code)
	}
	noSlackWake(t, wakes)
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(f.logged(), "guest-external-or-wrong-team") {
		if time.Now().After(deadline) {
			t.Fatalf("guest click was not refused: %s", f.logged())
		}
		time.Sleep(5 * time.Millisecond)
	}

	// A valid click routes to the clicking user's server.
	if code := f.interact(payload("U-alice", "C-1"), true, f.now); code != http.StatusOK {
		t.Fatalf("valid: %d", code)
	}
	wk := wakeSlack(t, wakes, "")
	if wk.Action != "block_action" || wk.Channel != "C-1" || wk.ActionID != "bb_set_project" || wk.Value != "proj_x" ||
		wk.Asker.ID != "U-alice" || wk.Owner.ID != "U-alice" || !wk.FromOwner {
		t.Fatalf("wake %+v", wk)
	}
	if wk.ResponseURL != responseURL {
		t.Fatalf("responseUrl %q", wk.ResponseURL)
	}
	// The response_url is a capability: it reaches the pod that must use it,
	// but it is never logged.
	if strings.Contains(f.logged(), "capability-secret") {
		t.Fatalf("response_url was logged: %s", f.logged())
	}
	// A block_action wake no longer grants the ephemeral endpoint: no wake
	// records a channel for it today.
	if f.slack.allowedChannel(alice, "C-1") {
		t.Fatal("block_action recorded the ephemeral channel")
	}
}

// TestSlackInteractivityStaticSelect pins the dropdown payload shape: a
// static_select interaction carries its choice in selected_option.value and
// has no top-level value, so the block_action wake must carry that choice.
func TestSlackInteractivityStaticSelect(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	const responseURL = "https://hooks.slack.com/actions/T1/B1/capability-secret"
	// A real Slack static_select block_actions payload: the action has a
	// type, a block id and selected_option{text,value}, and no value.
	payload := map[string]any{
		"type":         "block_actions",
		"response_url": responseURL,
		"user":         map[string]any{"id": "U-alice"},
		"channel":      map[string]any{"id": "C-1"},
		"actions": []map[string]any{{
			"type":      "static_select",
			"action_id": "bb_set_project",
			"block_id":  "bb_project",
			"selected_option": map[string]any{
				"text":  map[string]any{"type": "plain_text", "text": "Project X"},
				"value": "proj_x",
			},
		}},
	}

	if code := f.interact(payload, true, f.now); code != http.StatusOK {
		t.Fatalf("static_select: %d", code)
	}
	wk := wakeSlack(t, wakes, "")
	if wk.Action != "block_action" || wk.Channel != "C-1" || wk.ActionID != "bb_set_project" || wk.Value != "proj_x" ||
		wk.Asker.ID != "U-alice" || wk.Owner.ID != "U-alice" || !wk.FromOwner {
		t.Fatalf("wake %+v", wk)
	}
	if wk.ResponseURL != responseURL {
		t.Fatalf("responseUrl %q", wk.ResponseURL)
	}
	// The response_url is a capability: it reaches the pod that must use it,
	// but it is never logged.
	if strings.Contains(f.logged(), "capability-secret") {
		t.Fatalf("response_url was logged: %s", f.logged())
	}
}

// TestSlackEphemeral pins the ephemeral endpoint's restrictions: it posts
// only to the connection's own bound user, and only in a channel the
// service recorded for that connection. No wake records a channel today —
// the invite prompt that did is gone — so the endpoint refuses every
// channel until the mention-time prompt grants one. rememberChannel is the
// plumbing that will, called here to exercise the endpoint's post path.
func TestSlackEphemeral(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	bob, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	f.slack.rememberChannel(alice, "C-1")

	post := func(v any) (int, string) {
		code, body := f.post("/v1/slack/ephemeral", v)
		return code, string(body)
	}
	// Unknown connection, an unidentified connection, another user, and an
	// unsolicited channel are refused; nothing is posted.
	stranger, _ := f.stream()
	if code, body := post(map[string]any{"connection": "c_nope", "channel": "C-1", "user": "U-alice", "text": "hi"}); code != http.StatusNotFound || !strings.Contains(body, "unknown-connection") {
		t.Fatalf("unknown connection: %d %s", code, body)
	}
	if code, body := post(map[string]any{"connection": stranger, "channel": "C-1", "user": "U-alice", "text": "hi"}); code != http.StatusForbidden || !strings.Contains(body, "not-identified") {
		t.Fatalf("unidentified: %d %s", code, body)
	}
	if code, body := post(map[string]any{"connection": alice, "channel": "C-1", "user": "U-bob", "text": "hi"}); code != http.StatusForbidden || !strings.Contains(body, "not-yours") {
		t.Fatalf("another user: %d %s", code, body)
	}
	if code, body := post(map[string]any{"connection": alice, "channel": "C-9", "user": "U-alice", "text": "hi"}); code != http.StatusForbidden || !strings.Contains(body, "not-routed") {
		t.Fatalf("unsolicited channel: %d %s", code, body)
	}
	// A channel recorded for Alice is not usable by Bob's connection.
	if code, body := post(map[string]any{"connection": bob, "channel": "C-1", "user": "U-bob", "text": "hi"}); code != http.StatusForbidden || !strings.Contains(body, "not-routed") {
		t.Fatalf("other connection: %d %s", code, body)
	}
	f.api.mu.Lock()
	if len(f.api.ephemerals) != 0 {
		t.Fatalf("refused ephemeral posted %+v", f.api.ephemerals)
	}
	f.api.mu.Unlock()

	// The owner's connection posts to its own user, in the recorded channel,
	// with the Block Kit blocks.
	blocks := []map[string]any{{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": "pick one"}}}
	if code, body := post(map[string]any{"connection": alice, "channel": "C-1", "user": "U-alice", "text": "Which project?", "blocks": blocks}); code != http.StatusOK {
		t.Fatalf("ephemeral: %d %s", code, body)
	}
	f.api.mu.Lock()
	ep := f.api.ephemerals[len(f.api.ephemerals)-1]
	f.api.mu.Unlock()
	if ep.Channel != "C-1" || ep.User != "U-alice" || ep.Text != "Which project?" || ep.Blocks == nil {
		t.Fatalf("posted %+v", ep)
	}
}

func TestSlackIdentify(t *testing.T) {
	f := newSlackFixture(t)
	conn, wakes := f.stream()

	// A bad token.
	if code, _ := f.identify(conn, "xoxp-forged"); code != http.StatusUnauthorized {
		t.Fatalf("bad token: %d", code)
	}
	// Another workspace.
	if code, _ := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-other", TeamID: "T-other", Name: "Other"})); code != http.StatusForbidden {
		t.Fatalf("other team: %d", code)
	}
	// A guest.
	if code, _ := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-guest", TeamID: slackTeam, Name: "Guest", IsRestricted: true})); code != http.StatusForbidden {
		t.Fatalf("guest: %d", code)
	}
	// An external user.
	if code, _ := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-ext", TeamID: "T-other", Name: "Ext", IsStranger: true})); code != http.StatusForbidden {
		t.Fatalf("external: %d", code)
	}
	// A user whose workspace Slack does not name is refused.
	if code, _ := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-noteam", TeamID: "", Name: "NoTeam"})); code != http.StatusForbidden {
		t.Fatalf("empty team: %d", code)
	}
	// Good.
	code, out := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	if code != http.StatusOK || out.User.ID != "U-alice" || out.User.Name != "Alice" {
		t.Fatalf("identify: %d %+v", code, out)
	}
	// The same user on a second live connection is refused.
	conn2, _ := f.stream()
	if code, _ := f.identify(conn2, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusConflict {
		t.Fatalf("already bound: %d", code)
	}
	// Renewal on the same connection is fine.
	if code, _ := f.identify(conn, f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})); code != http.StatusOK {
		t.Fatalf("renewal: %d", code)
	}
	// And now a DM routes.
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	if wk := wakeSlack(t, wakes, "D-1:111.222"); wk.Owner.ID != "U-alice" {
		t.Fatalf("wake %+v", wk)
	}
}

// TestSlackIdentifyTokenKinds proves identify accepts both the new OAuth v2
// user token (read with auth.test) and a still-valid OpenID Connect token
// (read with openid.connect.userInfo), and that the name comes from the bot
// token's users:read either way. Neither sign-in forces a sign-out.
func TestSlackIdentifyTokenKinds(t *testing.T) {
	f := newSlackFixture(t)

	// The new user token: auth.test answers, userInfo is not used.
	userConn, _ := f.stream()
	userToken := f.api.userAccessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})
	if code, out := f.identify(userConn, userToken); code != http.StatusOK || out.User.ID != "U-alice" || out.User.Name != "Alice" {
		t.Fatalf("user token: %d %+v", code, out)
	}

	// The old OpenID token still identifies.
	oldConn, _ := f.stream()
	oldToken := f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"})
	if code, out := f.identify(oldConn, oldToken); code != http.StatusOK || out.User.ID != "U-bob" || out.User.Name != "Bob" {
		t.Fatalf("openid token: %d %+v", code, out)
	}

	// A user token from another workspace is still refused.
	otherConn, _ := f.stream()
	other := f.api.userAccessFor(fakeSlackUser{ID: "U-other", TeamID: "T-other", Name: "Other"})
	if code, _ := f.identify(otherConn, other); code != http.StatusForbidden {
		t.Fatalf("other workspace user token: %d", code)
	}
}

// TestSlackBotJoin covers POST /v1/slack/bot/join: an identified connection
// has the bot join a public channel with the bot token, the cached
// membership list learns it at once, a private channel is refused with a
// code the plugin can explain, and an unidentified or unknown connection
// joins nothing.
func TestSlackBotJoin(t *testing.T) {
	f := newSlackFixture(t)
	f.api.mu.Lock()
	f.api.botChannels = []string{"C0001"}
	f.api.mu.Unlock()
	alice := f.api.userAccessFor(f.api.users["U-alice"])
	conn, _ := f.pod(alice)

	// Warm the membership cache so the join has something to update.
	if code, _ := f.get("/v1/slack/bot/channels"); code != http.StatusOK {
		t.Fatalf("bot channels: %d", code)
	}

	code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0002"})
	if code != http.StatusOK {
		t.Fatalf("join: %d %s", code, body)
	}
	f.api.mu.Lock()
	joins := append([]url.Values(nil), f.api.joins...)
	reads := f.api.channelRequests
	f.api.mu.Unlock()
	if len(joins) != 1 || joins[0].Get("channel") != "C0002" {
		t.Fatalf("conversations.join forms %v", joins)
	}
	code, body = f.get("/v1/slack/bot/channels")
	if code != http.StatusOK {
		t.Fatalf("bot channels after join: %d", code)
	}
	var out SlackBotChannelsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(out.Channels, []string{"C0001", "C0002"}) {
		t.Fatalf("channels after join %v", out.Channels)
	}
	f.api.mu.Lock()
	readsAfter := f.api.channelRequests
	f.api.mu.Unlock()
	if readsAfter != reads {
		t.Fatalf("the cache was not updated in place: %d reads, was %d", readsAfter, reads)
	}

	// Joining a channel the bot is already in is a success.
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0001"}); code != http.StatusOK {
		t.Fatalf("already in: %d %s", code, body)
	}

	// A private channel cannot be self-joined; the plugin is told why.
	f.api.mu.Lock()
	f.api.joinError = "method_not_supported_for_channel_type"
	f.api.mu.Unlock()
	code, body = f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "G0009"})
	if code != http.StatusConflict || !strings.Contains(string(body), `"private-channel"`) {
		t.Fatalf("private: %d %s", code, body)
	}
	f.api.mu.Lock()
	f.api.joinError = "channel_not_found"
	f.api.mu.Unlock()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0404"}); code != http.StatusNotFound || !strings.Contains(string(body), `"channel-not-found"`) {
		t.Fatalf("not found: %d %s", code, body)
	}
	f.api.mu.Lock()
	f.api.joinError = "missing_scope"
	f.api.mu.Unlock()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0003"}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), `"missing-scope"`) {
		t.Fatalf("missing scope: %d %s", code, body)
	}
	f.api.mu.Lock()
	f.api.joinError = "is_archived"
	f.api.mu.Unlock()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0007"}); code != http.StatusConflict || !strings.Contains(string(body), `"archived"`) {
		t.Fatalf("archived: %d %s", code, body)
	}
	// Any other Slack refusal is the shared 502, as for the other calls.
	f.api.mu.Lock()
	f.api.joinError = "ratelimited"
	f.api.mu.Unlock()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0008"}); code != http.StatusBadGateway || !strings.Contains(string(body), `"slack-refused"`) {
		t.Fatalf("refused: %d %s", code, body)
	}
	// An unreachable Slack is the shared 503.
	f.api.mu.Lock()
	f.api.down = true
	f.api.mu.Unlock()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0009"}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), `"slack-unavailable"`) {
		t.Fatalf("unavailable: %d %s", code, body)
	}
	f.api.mu.Lock()
	f.api.down = false
	f.api.joinError = ""
	before := len(f.api.joins)
	f.api.mu.Unlock()

	// A name, an unidentified connection and an unknown one join nothing.
	if code, _ := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "general"}); code != http.StatusBadRequest {
		t.Fatalf("name: %d", code)
	}
	anon, _ := f.stream()
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: anon, Channel: "C0005"}); code != http.StatusForbidden || !strings.Contains(string(body), `"not-identified"`) {
		t.Fatalf("unidentified: %d %s", code, body)
	}
	if code, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: "c_nobody", Channel: "C0005"}); code != http.StatusNotFound || !strings.Contains(string(body), `"unknown-connection"`) {
		t.Fatalf("unknown: %d %s", code, body)
	}
	f.api.mu.Lock()
	after := len(f.api.joins)
	f.api.mu.Unlock()
	if after != before {
		t.Fatalf("refused requests reached Slack: %d joins, was %d", after, before)
	}
	// The user token never went anywhere near conversations.join.
	for _, form := range joins {
		if form.Get("token") != "" {
			t.Fatalf("token in form %v", form)
		}
	}
	// Every attempt is logged with the owner, the channel and the outcome,
	// and no line carries the bot token.
	logged := f.logged()
	for _, want := range []string{
		"connection=" + conn + " owner=U-alice ownerName=Alice channel=C0002 outcome=joined",
		"owner=U-alice ownerName=Alice channel=C0001 outcome=already-in",
		"owner=U-alice ownerName=Alice channel=G0009 outcome=private-channel",
		"owner=U-alice ownerName=Alice channel=C0404 outcome=channel-not-found",
		"owner=U-alice ownerName=Alice channel=C0003 outcome=missing-scope",
		"owner=U-alice ownerName=Alice channel=C0007 outcome=archived",
		"owner=U-alice ownerName=Alice channel=C0008 outcome=slack-refused",
		"owner=U-alice ownerName=Alice channel=C0009 outcome=slack-unavailable",
		"channel=general outcome=bad-request",
		"outcome=not-identified",
		"outcome=unknown-connection",
	} {
		if !strings.Contains(logged, want) {
			t.Fatalf("log is missing %q:\n%s", want, logged)
		}
	}
	if strings.Contains(logged, slackBotToken) {
		t.Fatalf("the bot token reached the log:\n%s", logged)
	}
}

// TestSlackBotChannels covers GET /v1/slack/bot/channels: it is on the
// cluster-only listener, paginates users.conversations with the bot token,
// returns ids only, and caches the answer.
func TestSlackBotChannels(t *testing.T) {
	f := newSlackFixture(t)
	f.api.mu.Lock()
	f.api.botChannels = []string{"C-1", "G-2", "C-3"}
	f.api.channelPageSize = 2
	f.api.mu.Unlock()

	code, body := f.get("/v1/slack/bot/channels")
	if code != http.StatusOK {
		t.Fatalf("bot channels: %d %s", code, body)
	}
	var out SlackBotChannelsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Channels) != 3 || out.Channels[0] != "C-1" || out.Channels[1] != "G-2" || out.Channels[2] != "C-3" {
		t.Fatalf("channels %v", out.Channels)
	}
	// Three channels in pages of two is two calls.
	f.api.mu.Lock()
	afterFirst := f.api.channelRequests
	f.api.mu.Unlock()
	if afterFirst != 2 {
		t.Fatalf("users.conversations calls %d", afterFirst)
	}
	f.api.mu.Lock()
	first := f.api.channelForms[0]
	f.api.mu.Unlock()
	if first.Get("types") != "public_channel,private_channel" || first.Get("exclude_archived") != "true" {
		t.Fatalf("users.conversations form %v", first)
	}

	// A second call is served from the cache.
	if code, _ := f.get("/v1/slack/bot/channels"); code != http.StatusOK {
		t.Fatalf("cached call: %d", code)
	}
	f.api.mu.Lock()
	cached := f.api.channelRequests
	f.api.mu.Unlock()
	if cached != afterFirst {
		t.Fatalf("cache miss: %d calls", cached)
	}

	// Past the TTL it reads again.
	f.now = f.now.Add(slackChannelsTTL + time.Minute)
	if code, _ := f.get("/v1/slack/bot/channels"); code != http.StatusOK {
		t.Fatalf("expired call: %d", code)
	}
	f.api.mu.Lock()
	afterTTL := f.api.channelRequests
	f.api.mu.Unlock()
	if afterTTL <= cached {
		t.Fatalf("cache did not expire: %d calls", afterTTL)
	}

	// It is not on the public listener: the endpoint is cluster-only.
	resp, err := http.Get(f.public.URL + "/v1/slack/bot/channels")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("public listener answered %d", resp.StatusCode)
	}

	// The bot token never reaches a pod's stream or the logs.
	for _, secret := range []string{slackBotToken, slackClientSec, slackSigningKey} {
		if strings.Contains(f.seen(), secret) || strings.Contains(f.logged(), secret) {
			t.Fatalf("%q leaked", secret)
		}
	}

	// A server with no bot token answers 503, not a Slack-refused 502.
	f.slack.BotToken = nil
	if code, _ := f.get("/v1/slack/bot/channels"); code != http.StatusServiceUnavailable {
		t.Fatalf("no bot token: %d", code)
	}
}

// TestSlackBotChannelsPageCap proves the pagination loop stops at the page
// cap rather than following a cursor that never ends.
func TestSlackBotChannelsPageCap(t *testing.T) {
	f := newSlackFixture(t)
	f.api.mu.Lock()
	for i := 0; i < maxSlackChannelPages+5; i++ {
		f.api.botChannels = append(f.api.botChannels, fmt.Sprintf("C-%d", i))
	}
	f.api.channelPageSize = 1
	f.api.mu.Unlock()

	code, body := f.get("/v1/slack/bot/channels")
	if code != http.StatusOK {
		t.Fatalf("bot channels: %d %s", code, body)
	}
	var out SlackBotChannelsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Channels) != maxSlackChannelPages {
		t.Fatalf("capped at %d channels", len(out.Channels))
	}
	f.api.mu.Lock()
	calls := f.api.channelRequests
	f.api.mu.Unlock()
	if calls != maxSlackChannelPages {
		t.Fatalf("calls %d", calls)
	}
}

func TestSlackSigninFlow(t *testing.T) {
	f := newSlackFixture(t)
	conn, _ := f.stream()

	authorize, state := f.start(conn)
	u, err := url.Parse(authorize)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/oauth/v2/authorize" {
		t.Fatalf("authorize path %q", u.Path)
	}
	q := u.Query()
	if q.Get("client_id") != slackClientID || q.Get("user_scope") != "channels:read,groups:read" || q.Get("state") != state ||
		q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("authorize url %s", authorize)
	}
	if got := q.Get("redirect_uri"); got != "https://bb.example.com/api/v1/plugins/slack/http/signin/callback" {
		t.Fatalf("redirect_uri %q", got)
	}
	// The sign-in asks for the user scopes only: the bot scopes come from
	// the app's installation, not from a developer's sign-in.
	if q.Get("scope") != "" {
		t.Fatalf("bot scope requested at sign-in: %q", q.Get("scope"))
	}
	if strings.Contains(q.Get("user_scope"), "email") {
		t.Fatalf("email scope requested: %q", q.Get("user_scope"))
	}

	// An unknown state is refused.
	if code, _ := f.exchange(conn, "bogus", "code"); code != http.StatusNotFound {
		t.Fatalf("unknown state: %d", code)
	}

	// Simulate the browser: hit the fake authorize endpoint without
	// following the redirect, and read the code it issued.
	f.api.setNextUser(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(authorize)
	if err != nil {
		t.Fatal(err)
	}
	loc := resp.Header.Get("Location")
	resp.Body.Close()
	lu, err := url.Parse(loc)
	if err != nil {
		t.Fatal(err)
	}
	code := lu.Query().Get("code")
	if code == "" {
		t.Fatalf("no code in %q", loc)
	}

	// Another connection is refused and does not consume the state, so the
	// connection that started the flow can still exchange it.
	conn2, _ := f.stream()
	if status, body := f.exchange(conn2, state, code); status != http.StatusForbidden || !strings.Contains(string(body), "not-yours") {
		t.Fatalf("cross-connection exchange: %d %s", status, body)
	}
	status, body := f.exchange(conn, state, code)
	if status != http.StatusOK {
		t.Fatalf("exchange: %d %s", status, body)
	}
	var got SigninExchangeResponse
	if err := json.Unmarshal(body, &got); err != nil || got.Token == "" {
		t.Fatalf("exchange %s %v", body, err)
	}
	// Replay is refused: the state is consumed and the flow is gone.
	if status, _ := f.exchange(conn, state, code); status != http.StatusNotFound {
		t.Fatalf("replay: %d", status)
	}
	// The token identifies.
	if code, out := f.identify(conn, got.Token); code != http.StatusOK || out.User.ID != "U-alice" {
		t.Fatalf("identify with exchanged token: %d %+v", code, out)
	}

	// An expired flow is refused before any exchange.
	_, state2 := f.start(conn)
	f.now = f.now.Add(11 * time.Minute)
	if status, _ := f.exchange(conn, state2, "code"); status != http.StatusNotFound {
		t.Fatalf("expired flow: %d", status)
	}

	// The client secret and bot token are nowhere in the logs or on the
	// pod's stream; the user token reaches the pod that started the flow
	// (that is how identify works), so it is checked against the logs only.
	for _, secret := range []string{slackClientSec, slackBotToken, slackSigningKey} {
		if strings.Contains(f.seen(), secret) || strings.Contains(f.logged(), secret) {
			t.Fatalf("%q leaked", secret)
		}
	}
	if strings.Contains(f.logged(), got.Token) {
		t.Fatalf("user token was logged")
	}
	// The token endpoint saw the client secret and the PKCE verifier, once.
	f.api.mu.Lock()
	defer f.api.mu.Unlock()
	if len(f.api.tokenRequests) != 1 {
		t.Fatalf("token requests %d", len(f.api.tokenRequests))
	}
	form := f.api.tokenRequests[0]
	if form.Get("client_secret") != slackClientSec || form.Get("code_verifier") == "" || form.Get("redirect_uri") == "" {
		t.Fatalf("token form %v", form)
	}
}

func TestSlackRebindAfterClose(t *testing.T) {
	f := newSlackFixture(t)
	user := f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"})
	conn1, _, close1 := f.openStream()
	if code, _ := f.identify(conn1, user); code != http.StatusOK {
		t.Fatalf("first identify: %d", code)
	}
	// A second live connection cannot bind the same user.
	conn2, _, close2 := f.openStream()
	defer close2()
	if code, _ := f.identify(conn2, user); code != http.StatusConflict {
		t.Fatalf("bound while live: %d", code)
	}
	// Close the first connection: the binding goes with it, and the user
	// can bind to a new one.
	close1()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.Registry.Get(conn1) != nil {
		if time.Now().After(deadline) {
			t.Fatal("connection still registered after close")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code, _ := f.identify(conn2, user); code != http.StatusOK {
		t.Fatalf("rebind after close: %d", code)
	}
}

func TestSlackReplyAuthorization(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	bob, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))
	stranger, _ := f.stream() // connected, never identified

	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")

	session := "D-1:111.222"
	post := func(path string, v any) (int, string) {
		code, body := f.post(path, v)
		return code, string(body)
	}
	for _, c := range []struct {
		name string
		conn string
		body map[string]any
		code int
		want string
	}{
		{"another server", bob, map[string]any{"connection": bob, "text": "hi"}, http.StatusForbidden, "not-routed"},
		{"unidentified", stranger, map[string]any{"connection": stranger, "text": "hi"}, http.StatusForbidden, "not-identified"},
		{"unknown connection", "c_nope", map[string]any{"connection": "c_nope", "text": "hi"}, http.StatusNotFound, "unknown-connection"},
		{"unknown session", alice, map[string]any{"connection": alice, "text": "hi"}, http.StatusForbidden, "not-routed"},
	} {
		sess := session
		if c.name == "unknown session" {
			sess = "D-9:1.1"
		}
		code, body := post("/v1/slack/sessions/"+sess+"/message", c.body)
		if code != c.code || !strings.Contains(body, c.want) {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	f.api.mu.Lock()
	if len(f.api.messages) != 0 {
		t.Fatalf("refused reply posted %+v", f.api.messages)
	}
	f.api.mu.Unlock()

	// A routed reply posts as the app.
	if code, body := post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."}); code != http.StatusOK {
		t.Fatalf("reply: %d %s", code, body)
	}
	f.api.mu.Lock()
	msg := f.api.messages[len(f.api.messages)-1]
	f.api.mu.Unlock()
	if msg.Channel != "D-1" || msg.ThreadTS != "111.222" || msg.Text != "On it." {
		t.Fatalf("posted %+v", msg)
	}

	// Status and title helpers.
	if code, body := post("/v1/slack/sessions/"+session+"/status", map[string]any{"connection": alice, "status": "is thinking\u2026"}); code != http.StatusOK {
		t.Fatalf("status: %d %s", code, body)
	}
	f.api.mu.Lock()
	st := f.api.statuses[len(f.api.statuses)-1]
	f.api.mu.Unlock()
	if st.ChannelID != "D-1" || st.ThreadTS != "111.222" || st.Status != "is thinking\u2026" {
		t.Fatalf("status %+v", st)
	}
	if code, body := post("/v1/slack/sessions/"+session+"/title", map[string]any{"connection": alice, "title": "Build BB-38"}); code != http.StatusOK {
		t.Fatalf("title: %d %s", code, body)
	}
	f.api.mu.Lock()
	ti := f.api.titles[len(f.api.titles)-1]
	f.api.mu.Unlock()
	if ti.ChannelID != "D-1" || ti.ThreadTS != "111.222" || ti.Title != "Build BB-38" {
		t.Fatalf("title %+v", ti)
	}
}

// TestSlackNoticeFallsBackToEphemeral pins BB-159: a no-server notice the
// channel refuses because it does not let the app post is shown to the asker
// alone as an ephemeral message, with the one-line note. Nothing is posted in
// the channel, and the blocks are dropped so the note stays visible.
func TestSlackNoticeFallsBackToEphemeral(t *testing.T) {
	f := newSlackFixture(t)
	f.stream()
	f.api.mu.Lock()
	f.api.postError = "restricted_action_read_only_channel"
	f.api.mu.Unlock()
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "app_mention", "user": "U-bob", "channel": "C-9", "ts": "111.222", "text": "<@U-bb> hello",
	}), true, 0)
	ephs := f.waitEphemerals(1)
	if ephs[0].Channel != "C-9" || ephs[0].User != "U-bob" {
		t.Fatalf("ephemeral fallback %+v", ephs[0])
	}
	if !strings.Contains(ephs[0].Text, f.slack.noServerText()) || !strings.Contains(ephs[0].Text, slackChannelRestrictedNote) {
		t.Fatalf("ephemeral text %q", ephs[0].Text)
	}
	if ephs[0].Blocks != nil {
		t.Fatalf("ephemeral carried blocks, which would hide the note: %+v", ephs[0].Blocks)
	}
	if msgs := f.posted(); len(msgs) != 0 {
		t.Fatalf("a notice was posted in the channel: %+v", msgs)
	}
}

// TestSlackReplyFallsBackToEphemeral pins BB-159: a reply the channel
// refuses is posted as an ephemeral message to the connection's own bound
// user, and the pod is told it was ephemeral under the channel-restricted
// reason.
func TestSlackReplyFallsBackToEphemeral(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	session := "D-1:111.222"

	f.api.mu.Lock()
	f.api.postError = "restricted_action_read_only_channel"
	f.api.mu.Unlock()
	code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."})
	if code != http.StatusOK || !strings.Contains(string(body), `"ephemeral":true`) || !strings.Contains(string(body), `"reason":"channel-restricted"`) {
		t.Fatalf("fallback answer: %d %s", code, body)
	}
	ephs := f.waitEphemerals(1)
	if ephs[0].Channel != "D-1" || ephs[0].User != "U-alice" {
		t.Fatalf("ephemeral fallback %+v", ephs[0])
	}
	if !strings.Contains(ephs[0].Text, "On it.") || !strings.Contains(ephs[0].Text, slackChannelRestrictedNote) {
		t.Fatalf("ephemeral text %q", ephs[0].Text)
	}
	if msgs := f.posted(); len(msgs) != 0 {
		t.Fatalf("a reply was posted in the channel: %+v", msgs)
	}
}

// TestSlackReplyFallbackFailure pins BB-159's one failure status: when the
// ephemeral fallback fails too, the answer is 502 channel-restricted.
func TestSlackReplyFallbackFailure(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	session := "D-1:111.222"

	f.api.mu.Lock()
	f.api.postError = "restricted_action_read_only_channel"
	f.api.ephemeralError = "channel_not_found"
	f.api.mu.Unlock()
	code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."})
	if code != http.StatusBadGateway || !strings.Contains(string(body), `"channel-restricted"`) {
		t.Fatalf("both-fail answer: %d %s", code, body)
	}
	if msgs := f.posted(); len(msgs) != 0 {
		t.Fatalf("a reply was posted in the channel: %+v", msgs)
	}
}

// TestSlackReplyUnrelatedErrorUnchanged pins that only the three channel-
// restricted codes fall back: any other Slack refusal keeps the generic
// slack-refused answer and posts no ephemeral message.
func TestSlackReplyUnrelatedErrorUnchanged(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello", nil), true, 0)
	wakeSlack(t, aliceWakes, "D-1:111.222")
	session := "D-1:111.222"

	f.api.mu.Lock()
	f.api.postError = "channel_not_found"
	f.api.mu.Unlock()
	code, body := f.post("/v1/slack/sessions/"+session+"/message", map[string]any{"connection": alice, "text": "On it."})
	if code != http.StatusBadGateway || !strings.Contains(string(body), `"slack-refused"`) {
		t.Fatalf("unrelated error answer: %d %s", code, body)
	}
	f.api.mu.Lock()
	ephs := append([]slackEphemeral(nil), f.api.ephemerals...)
	f.api.mu.Unlock()
	if len(ephs) != 0 {
		t.Fatalf("an unrelated refusal posted an ephemeral fallback: %+v", ephs)
	}
}

// TestSlackBotJoinRestricted pins BB-159's join warning: a channel that does
// not let the app post is refused with channel-restricted so the settings
// page can warn, instead of mapping a channel bb can never answer in. Every
// code in the shared restricted set is exercised, so the join switch cannot
// drift from the post/reply list.
func TestSlackBotJoinRestricted(t *testing.T) {
	f := newSlackFixture(t)
	alice := f.api.userAccessFor(f.api.users["U-alice"])
	conn, _ := f.pod(alice)

	for _, code := range []string{"restricted_action_read_only_channel", "restricted_action", "not_in_channel"} {
		f.api.mu.Lock()
		f.api.joinError = code
		f.api.mu.Unlock()
		status, body := f.post("/v1/slack/bot/join", SlackJoinRequest{Connection: conn, Channel: "C0002"})
		if status != http.StatusConflict || !strings.Contains(string(body), `"channel-restricted"`) {
			t.Fatalf("restricted join (%s): %d %s", code, status, body)
		}
	}
}

func TestSlackWorkspaceDiscovery(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.TeamID, f.slack.AppID = "", ""
	// Start resolves them from the bot token.
	if err := f.slack.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.slack.TeamID != slackTeam || f.slack.AppID != slackApp {
		t.Fatalf("discovered %q %q", f.slack.TeamID, f.slack.AppID)
	}
	// An event is then accepted.
	conn, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_ = conn
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hi", nil), true, 0)
	wakeSlack(t, wakes, "D-1:111.222")
}

// TestSlackWorkspaceDiscoveryFallsBackToProfile: when bots.info names no
// app, the bot user's own profile does.
func TestSlackWorkspaceDiscoveryFallsBackToProfile(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.TeamID, f.slack.AppID = "", ""
	f.api.mu.Lock()
	f.api.hideBotApp = true
	f.api.mu.Unlock()
	if err := f.slack.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	if f.slack.TeamID != slackTeam || f.slack.AppID != slackApp {
		t.Fatalf("discovered %q %q", f.slack.TeamID, f.slack.AppID)
	}
}

// TestSlackUnresolvedAckIsFast pins the ack budget when the workspace has
// not been resolved yet: the webhook answers 503 at once and the discovery
// happens in the background.
func TestSlackUnresolvedAckIsFast(t *testing.T) {
	f := newSlackFixture(t)
	f.slack.TeamID, f.slack.AppID = "", ""
	f.api.discoverDelay = 2 * time.Second
	code, took := f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hi", nil), true, 0)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("unresolved: %d", code)
	}
	if took >= 500*time.Millisecond {
		t.Fatalf("ack waited for discovery: %v", took)
	}
	// The background resolve lands, and the next event is accepted.
	deadline := time.Now().Add(15 * time.Second)
	for {
		team, app := f.slack.resolved()
		if team != "" && app != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("workspace never resolved")
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "hi", nil), true, 0)
	wakeSlack(t, wakes, "D-1:111.222")
}

// TestSlackNotReadingReply pins the message for a bound server that is not
// draining its wake buffer: it is not a sign-in problem.
func TestSlackNotReadingReply(t *testing.T) {
	f := newSlackFixture(t)
	conn, err := f.srv.Registry.Open("10.0.0.9")
	if err != nil {
		t.Fatal(err)
	}
	f.srv.Registry.Identify(conn, "slack", "U-alice", "Alice", nil)
	for i := 0; i < cap(conn.SlackWakes); i++ {
		conn.SlackWakes <- SlackWake{}
	}
	f.slack.route(slackRouted{Session: "D-1:1.2", Action: "message", Channel: "D-1", Thread: "1.2", User: "U-alice", Text: "hi", At: f.now})
	f.api.mu.Lock()
	defer f.api.mu.Unlock()
	if len(f.api.messages) != 1 || !strings.Contains(f.api.messages[0].Text, "not reading") {
		t.Fatalf("messages %+v", f.api.messages)
	}
	if f.api.messages[0].Blocks != nil {
		t.Fatalf("not-reading reply carried blocks: %+v", f.api.messages[0].Blocks)
	}
}

func TestSlackSecretsNeverReachPods(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hi", nil), true, 0)
	wakeSlack(t, wakes, "D-1:111.222")
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "no server", map[string]any{"ts": "2.2"}), true, 0)
	f.deliver(f.message("Ev-3", slackTeam, slackApp, "U-bob", "D-9", "nobody", nil), true, 0)
	time.Sleep(200 * time.Millisecond)
	for _, secret := range []string{slackSigningKey, slackBotToken, slackClientSec, "xoxp-"} {
		if strings.Contains(f.seen(), secret) {
			t.Fatalf("%q reached a pod: %s", secret, f.seen())
		}
		if strings.Contains(f.logged(), secret) {
			t.Fatalf("%q was logged", secret)
		}
	}
}

func TestParseSlackEvent(t *testing.T) {
	now := time.Unix(1000, 0)
	cases := []struct {
		name string
		env  string
		live bool
		ok   bool
		want slackRouted
	}{
		{"dm", `{"type":"event_callback","event":{"type":"message","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","text":"hi"}}`, false, true, slackRouted{Session: "D1:1.2", Action: "message", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "hi", TS: "1.2"}},
		{"thread", `{"type":"event_callback","event":{"type":"message","channel_type":"im","user":"U1","channel":"D1","ts":"3.4","thread_ts":"1.2","text":"more"}}`, false, true, slackRouted{Session: "D1:1.2", Action: "message", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "more", TS: "3.4"}},
		{"bot", `{"type":"event_callback","event":{"type":"message","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","bot_id":"B1"}}`, false, false, slackRouted{}},
		{"subtype", `{"type":"event_callback","event":{"type":"message","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","subtype":"channel_join"}}`, false, false, slackRouted{}},
		{"dm-edit", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"1.2","text":"new"},"previous_message":{"user":"U1","ts":"1.2","text":"old"}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "edited", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "new", TS: "1.2"}},
		{"dm-edit-metadata-only", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"1.2","text":"same","files":[{"id":"F1","name":"a.png","size":10}]},"previous_message":{"user":"U1","ts":"1.2","text":"same","files":[{"id":"F1","name":"a.png","size":10}]}}}`, false, false, slackRouted{}},
		{"dm-edit-metadata-only-no-id", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"1.2","text":"same","files":[{"name":"a.png","size":10}]},"previous_message":{"user":"U1","ts":"1.2","text":"same","files":[{"name":"a.png","size":10}]}}}`, false, false, slackRouted{}},
		{"dm-edit-files-added", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"1.2","text":"same","files":[{"id":"F1","name":"a.png","size":10}]},"previous_message":{"user":"U1","ts":"1.2","text":"same"}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "edited", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "same", TS: "1.2"}},
		{"dm-edit-files-changed", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"1.2","text":"same","files":[{"id":"F2","name":"b.png","size":20}]},"previous_message":{"user":"U1","ts":"1.2","text":"same","files":[{"id":"F1","name":"a.png","size":10}]}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "edited", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "same", TS: "1.2"}},
		{"dm-edit-thread", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","ts":"3.4","thread_ts":"1.2","text":"new"}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "edited", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "new", TS: "3.4"}},
		{"dm-edit-bot", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","channel":"D1","message":{"user":"U1","bot_id":"B1","ts":"1.2","text":"new"}}}`, false, false, slackRouted{}},
		{"dm-edit-no-inner", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","text":"new"}}`, false, false, slackRouted{}},
		{"dm-edit-channel", `{"type":"event_callback","event":{"type":"message","subtype":"message_changed","channel_type":"channel","channel":"C1","message":{"user":"U1","ts":"1.2","text":"new"}}}`, false, false, slackRouted{}},
		{"dm-delete", `{"type":"event_callback","event":{"type":"message","subtype":"message_deleted","channel_type":"im","channel":"D1","deleted_ts":"1.2","previous_message":{"user":"U1","ts":"1.2","text":"old"}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "deleted", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", TS: "1.2"}},
		{"dm-delete-fallback", `{"type":"event_callback","event":{"type":"message","subtype":"message_deleted","channel_type":"im","channel":"D1","previous_message":{"user":"U1","ts":"5.6","text":"old"}}}`, false, true, slackRouted{Session: "D1:5.6", Action: "deleted", Tagged: true, Channel: "D1", Thread: "5.6", User: "U1", TS: "5.6"}},
		{"dm-delete-bot", `{"type":"event_callback","event":{"type":"message","subtype":"message_deleted","channel_type":"im","channel":"D1","deleted_ts":"1.2","previous_message":{"user":"U1","bot_id":"B1","ts":"1.2"}}}`, false, false, slackRouted{}},
		{"dm-delete-no-prev", `{"type":"event_callback","event":{"type":"message","subtype":"message_deleted","channel_type":"im","channel":"D1","deleted_ts":"1.2"}}`, false, false, slackRouted{}},
		{"channel-top-level", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"1.2","text":"hi"}}`, true, false, slackRouted{}},
		{"channel-not-followed", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"hi"}}`, false, false, slackRouted{}},
		{"channel-tagged-top-level", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"1.2","text":"<@U-bb> hi"}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:1.2", Channel: "C1", Thread: "1.2", User: "U1", Text: "<@U-bb> hi", TS: "1.2"}},
		{"channel-tagged-thread", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"<@U-bb> hi"}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:3.4", Channel: "C1", Thread: "1.2", User: "U1", Text: "<@U-bb> hi", TS: "3.4"}},
		{"group-tagged-thread", `{"type":"event_callback","event":{"type":"message","channel_type":"group","user":"U1","channel":"G1","ts":"3.4","thread_ts":"1.2","text":"<@U-bb> hi"}}`, false, true, slackRouted{Session: "G1:1.2", Action: "message", Mention: true, Tagged: true, Key: "G1:3.4", Channel: "G1", Thread: "1.2", User: "U1", Text: "<@U-bb> hi", TS: "3.4"}},
		{"channel-tagged-file-share", `{"type":"event_callback","event":{"type":"message","subtype":"file_share","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"<@U-bb> see this","files":[{"id":"F1","name":"a.png","mimetype":"image/png","size":10}]}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:3.4", Channel: "C1", Thread: "1.2", User: "U1", Text: "<@U-bb> see this", TS: "3.4", Files: []SlackFile{{ID: "F1", Name: "a.png", MimeType: "image/png", Size: 10}}}},
		{"channel-tagged-followed", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"<@U-bb> hi"}}`, true, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:3.4", Channel: "C1", Thread: "1.2", User: "U1", Text: "<@U-bb> hi", TS: "3.4"}},
		{"channel-tagged-bot", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","bot_id":"B1","text":"<@U-bb> hi"}}`, false, false, slackRouted{}},
		{"channel-mention-other-bot", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"<@U-other> hi"}}`, false, false, slackRouted{}},
		{"channel-followed", `{"type":"event_callback","event":{"type":"message","channel_type":"channel","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"hi"}}`, true, true, slackRouted{Session: "C1:1.2", Action: "message", Key: "C1:3.4", Channel: "C1", Thread: "1.2", User: "U1", Text: "hi", TS: "3.4"}},
		{"group-followed", `{"type":"event_callback","event":{"type":"message","channel_type":"group","user":"U1","channel":"G1","ts":"3.4","thread_ts":"1.2","text":"hi"}}`, true, true, slackRouted{Session: "G1:1.2", Action: "message", Key: "G1:3.4", Channel: "G1", Thread: "1.2", User: "U1", Text: "hi", TS: "3.4"}},
		{"mention", `{"type":"event_callback","event":{"type":"app_mention","user":"U1","channel":"C1","ts":"1.2","text":"<@U-bb> hi"}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:1.2", Channel: "C1", Thread: "1.2", User: "U1", Text: "<@U-bb> hi", TS: "1.2"}},
		{"mention-thread", `{"type":"event_callback","event":{"type":"app_mention","user":"U1","channel":"C1","ts":"3.4","thread_ts":"1.2","text":"more"}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:3.4", Channel: "C1", Thread: "1.2", User: "U1", Text: "more", TS: "3.4"}},
		{"mention-files", `{"type":"event_callback","event":{"type":"app_mention","user":"U1","channel":"C1","ts":"1.2","text":"","files":[{"id":"F1","name":"a.png","mimetype":"image/png","size":10},{"id":"F2","title":"b.go","mimetype":"text/plain","size":20}]}}`, false, true, slackRouted{Session: "C1:1.2", Action: "message", Mention: true, Tagged: true, Key: "C1:1.2", Channel: "C1", Thread: "1.2", User: "U1", TS: "1.2", Files: []SlackFile{{ID: "F1", Name: "a.png", MimeType: "image/png", Size: 10}, {ID: "F2", Name: "b.go", MimeType: "text/plain", Size: 20}}}},
		{"dm-file-share", `{"type":"event_callback","event":{"type":"message","subtype":"file_share","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","text":"","files":[{"id":"F1","name":"a.png","mimetype":"image/png","size":10}]}}`, false, true, slackRouted{Session: "D1:1.2", Action: "message", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", TS: "1.2", Files: []SlackFile{{ID: "F1", Name: "a.png", MimeType: "image/png", Size: 10}}}},
		{"dm-file-share-text", `{"type":"event_callback","event":{"type":"message","subtype":"file_share","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","text":"what is this?","files":[{"id":"F1","name":"a.png","mimetype":"image/png","size":10}]}}`, false, true, slackRouted{Session: "D1:1.2", Action: "message", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1", Text: "what is this?", TS: "1.2", Files: []SlackFile{{ID: "F1", Name: "a.png", MimeType: "image/png", Size: 10}}}},
		{"dm-file-share-bot", `{"type":"event_callback","event":{"type":"message","subtype":"file_share","channel_type":"im","user":"U1","channel":"D1","ts":"1.2","bot_id":"B1","files":[{"id":"F1","name":"a.png","mimetype":"image/png","size":10}]}}`, false, false, slackRouted{}},
		{"mention-bot", `{"type":"event_callback","event":{"type":"app_mention","user":"U1","channel":"C1","ts":"1.2","bot_id":"B1"}}`, false, false, slackRouted{}},
		{"mention-no-user", `{"type":"event_callback","event":{"type":"app_mention","channel":"C1","ts":"1.2"}}`, false, false, slackRouted{}},
		{"assistant", `{"type":"event_callback","event":{"type":"assistant_thread_started","assistant_thread":{"user_id":"U1","channel_id":"D1","thread_ts":"1.2"}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "assistant_thread_started", Tagged: true, Channel: "D1", Thread: "1.2", User: "U1"}},
		{"context", `{"type":"event_callback","event":{"type":"assistant_thread_context_changed","assistant_thread":{"user_id":"U1","channel_id":"D1","thread_ts":"1.2","context":{"channel_id":"C9"}}}}`, false, true, slackRouted{Session: "D1:1.2", Action: "assistant_thread_context_changed", Tagged: true, Channel: "D1", ContextChannel: "C9", Thread: "1.2", User: "U1"}},
		{"member-joined-bot", `{"type":"event_callback","event":{"type":"member_joined_channel","user":"U-bb","inviter":"U1","channel":"C1"}}`, false, false, slackRouted{}},
		{"member-joined-other", `{"type":"event_callback","event":{"type":"member_joined_channel","user":"U2","inviter":"U1","channel":"C1"}}`, false, false, slackRouted{}},
		{"member-joined-no-inviter", `{"type":"event_callback","event":{"type":"member_joined_channel","user":"U-bb","channel":"C1"}}`, false, false, slackRouted{}},
		{"member-joined-no-channel", `{"type":"event_callback","event":{"type":"member_joined_channel","user":"U-bb","inviter":"U1"}}`, false, false, slackRouted{}},
		{"other", `{"type":"event_callback","event":{"type":"reaction_added"}}`, false, false, slackRouted{}},
	}
	s := &Slack{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var env slackEnvelope
			if err := json.Unmarshal([]byte(c.env), &env); err != nil {
				t.Fatal(err)
			}
			got, ok := s.parseSlackEvent(&env, now, func(string) bool { return c.live }, slackBotUser)
			if ok != c.ok {
				t.Fatalf("ok %v, want %v", ok, c.ok)
			}
			got.At = time.Time{}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}

// TestSlackResolveMentions pins every token kind the resolver rewrites, the
// app's own mention (always @bb, with no users.info call), the channel label
// and conversations.info forms, the special mentions, the link forms, and the
// mentions list the wake carries.
func TestSlackResolveMentions(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.channelNames["C-2"] = "random"

	text := "<@U-alice> and <@U-bb> see <#C-1|general> and <#C-2> and " +
		"<!here> <!channel> <!everyone> <!subteam^S-1|@team> <!date^123^date|tomorrow> " +
		"<https://example.com|Example> <https://example.com> <mailto:a@b.com|mail>"
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", text, nil), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	want := "@Alice and @bb see #general and #random and " +
		"@here @channel @everyone @team tomorrow " +
		"Example (https://example.com) https://example.com mail (mailto:a@b.com)"
	if wk.Comment.Text != want {
		t.Fatalf("text\n got %q\nwant %q", wk.Comment.Text, want)
	}
	wantMentions := []SlackMention{{ID: "U-alice", Name: "Alice"}, {ID: "U-bb", Name: "bb"}}
	if !slices.Equal(wk.Mentions, wantMentions) {
		t.Fatalf("mentions %+v, want %+v", wk.Mentions, wantMentions)
	}

	// A repeated mention is resolved each time but listed once.
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "hi <@U-bob> and <@U-bob> again",
		map[string]any{"ts": "222.333"}), true, 0)
	wk = wakeSlack(t, wakes, "D-1:222.333")
	if wk.Comment.Text != "hi @Bob and @Bob again" {
		t.Fatalf("dedup text %q", wk.Comment.Text)
	}
	if want := []SlackMention{{ID: "U-bob", Name: "Bob"}}; !slices.Equal(wk.Mentions, want) {
		t.Fatalf("dedup mentions %+v, want %+v", wk.Mentions, want)
	}
}

// TestSlackResolvePlainText pins that text with no token, and an
// angle-bracketed run that is not a token, is unchanged, and that a wake with
// no mentions carries no mentions key at all.
func TestSlackResolvePlainText(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hello world, no tokens, and <not a token> stays", nil), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	if wk.Comment.Text != "hello world, no tokens, and <not a token> stays" {
		t.Fatalf("text %q", wk.Comment.Text)
	}
	if wk.Mentions != nil {
		t.Fatalf("mentions %+v, want none", wk.Mentions)
	}
	b, err := json.Marshal(wk)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "mentions") {
		t.Fatalf("wake JSON carries mentions: %s", b)
	}
}

// TestSlackResolveLookupFailureFallsBack pins that a users.info failure keeps
// the id in the text, still lists the id so a reply can mention the person,
// and never drops the wake.
func TestSlackResolveLookupFailureFallsBack(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.down = true

	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "ask <@U-bob> please", nil), true, 0)
	wk := wakeSlack(t, wakes, "D-1:111.222")
	if wk.Comment.Text != "ask @U-bob please" {
		t.Fatalf("text %q", wk.Comment.Text)
	}
	if want := []SlackMention{{ID: "U-bob", Name: "U-bob"}}; !slices.Equal(wk.Mentions, want) {
		t.Fatalf("mentions %+v, want %+v", wk.Mentions, want)
	}
}

// TestSlackResolveCachesUser pins that a user resolved once is not looked up
// again within the TTL.
func TestSlackResolveCachesUser(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.mu.Lock()
	before := f.api.userInfoRequests
	f.api.mu.Unlock()

	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-alice", "D-1", "hi <@U-bob>", nil), true, 0)
	_ = wakeSlack(t, wakes, "D-1:111.222")
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-alice", "D-1", "again <@U-bob>", map[string]any{"ts": "222.333"}), true, 0)
	wk := wakeSlack(t, wakes, "D-1:222.333")
	if wk.Comment.Text != "again @Bob" {
		t.Fatalf("text %q", wk.Comment.Text)
	}

	f.api.mu.Lock()
	after := f.api.userInfoRequests
	ids := append([]string(nil), f.api.userInfoIDs...)
	f.api.mu.Unlock()
	if got := after - before; got != 1 {
		t.Fatalf("users.info calls %d, want 1 (ids %v)", got, ids)
	}
}

// openConversation posts to the conversation opener endpoint and returns the
// status, the decoded answer and the raw body.
func (f *slackFixture) openConversation(conn string, req slackConversationsRequest) (int, slackConversationsResponse, []byte) {
	f.t.Helper()
	code, body := f.post("/v1/slack/conversations", req)
	var out slackConversationsResponse
	if code == http.StatusOK {
		if err := json.Unmarshal(body, &out); err != nil {
			f.t.Fatal(err)
		}
	}
	return code, out, body
}

// open posts a conversation opener and fails the test unless it answers 200.
func (f *slackFixture) open(conn string, req slackConversationsRequest) slackConversationsResponse {
	f.t.Helper()
	code, out, body := f.openConversation(conn, req)
	if code != http.StatusOK {
		f.t.Fatalf("open conversation: %d %s", code, body)
	}
	return out
}

// TestSlackConversationsEndpoint pins the opener endpoint's shape and its
// gating: it is on the cluster-only listener, refuses an unknown or
// unidentified connection and a malformed body, and refuses over 32 KiB
// before any Slack call.
func TestSlackConversationsEndpoint(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	// The public listener never serves it.
	body, _ := json.Marshal(slackConversationsRequest{Connection: alice, Text: "hi", Channel: "C-1"})
	resp, err := http.Post(f.public.URL+"/v1/slack/conversations", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("public listener answered %d, want 404", resp.StatusCode)
	}

	for _, c := range []struct {
		name string
		req  slackConversationsRequest
		code int
		want string
	}{
		{"unknown connection", slackConversationsRequest{Connection: "c_nope", Text: "hi", Channel: "C-1"}, http.StatusNotFound, "unknown-connection"},
		{"no text", slackConversationsRequest{Connection: alice, Channel: "C-1"}, http.StatusBadRequest, ""},
		{"neither users nor channel", slackConversationsRequest{Connection: alice, Text: "hi"}, http.StatusBadRequest, ""},
		{"both users and channel", slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"bob"}, Channel: "C-1"}, http.StatusBadRequest, ""},
		{"bad channel id", slackConversationsRequest{Connection: alice, Text: "hi", Channel: "not-a-channel"}, http.StatusBadRequest, ""},
	} {
		code, _, body := f.openConversation(alice, c.req)
		if code != c.code || (c.want != "" && !strings.Contains(string(body), c.want)) {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}

	// An unidentified connection is refused exactly as a reply is.
	anon, _ := f.stream()
	if code, _, body := f.openConversation(anon, slackConversationsRequest{Connection: anon, Text: "hi", Channel: "C-1"}); code != http.StatusForbidden || !strings.Contains(string(body), "not-identified") {
		t.Fatalf("unidentified: %d %s", code, body)
	}

	// Over 32 KiB is 413, before any Slack call.
	big := strings.Repeat("x", slackReplyBody+1)
	if code, _, _ := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: big, Channel: "C-1"}); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized text: %d", code)
	}
}

// TestSlackConversationsUsers pins name resolution and the DM/group-DM opens:
// resolution by id and by case-insensitive real name, display name and
// handle against a cached users.list, unknown and ambiguous refusals with
// candidates and nothing opened or posted, guests/bots/strangers refused as
// identify refuses them, and a duplicate entry collapsing to one user.
func TestSlackConversationsUsers(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.mu.Lock()
	f.api.users["U-corey"] = fakeSlackUser{ID: "U-corey", TeamID: slackTeam, Name: "corey", RealName: "Corey Hart", DisplayName: "Corey H"}
	f.api.users["U-casey"] = fakeSlackUser{ID: "U-casey", TeamID: slackTeam, Name: "casey", RealName: "Casey Jones", DisplayName: "Casey J"}
	f.api.users["U-alex1"] = fakeSlackUser{ID: "U-alex1", TeamID: slackTeam, Name: "alex1", RealName: "Alex Smith"}
	f.api.users["U-alex2"] = fakeSlackUser{ID: "U-alex2", TeamID: slackTeam, Name: "alex2", RealName: "Alex Smith"}
	f.api.users["U-botty"] = fakeSlackUser{ID: "U-botty", TeamID: slackTeam, Name: "botty", RealName: "Botty", IsBot: true}
	f.api.mu.Unlock()

	// A single user by id opens a DM and the opener is posted verbatim.
	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Hi Corey", Users: []string{"U-corey"}})
	if out.Channel != "D-U-corey" || out.Session != "D-U-corey:1.000000" || out.Capability == "" {
		t.Fatalf("open by id: %+v", out)
	}
	if len(out.Participants) != 1 || out.Participants[0].ID != "U-corey" || out.Participants[0].Name != "Corey H" {
		t.Fatalf("participants %+v", out.Participants)
	}
	if out.Permalink == "" || !strings.Contains(out.Permalink, "D-U-corey") {
		t.Fatalf("permalink %q", out.Permalink)
	}
	msgs := f.waitMessages(1)
	if msgs[0].Channel != "D-U-corey" || msgs[0].ThreadTS != "" || msgs[0].Text != "Hi Corey" {
		t.Fatalf("posted opener %+v", msgs[0])
	}
	f.api.mu.Lock()
	forms := append([]url.Values(nil), f.api.openForms...)
	f.api.mu.Unlock()
	if len(forms) != 1 || forms[0].Get("users") != "U-corey" {
		t.Fatalf("open forms %v", forms)
	}

	// A name matches on real name, display name and handle, case-insensitively.
	for _, name := range []string{"Corey Hart", "corey h", "@COREY"} {
		got := f.open(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{name}})
		if len(got.Participants) != 1 || got.Participants[0].ID != "U-corey" {
			t.Fatalf("name %q: %+v", name, got.Participants)
		}
	}

	// Several users open a group DM.
	group := f.open(alice, slackConversationsRequest{Connection: alice, Text: "hi all", Users: []string{"U-corey", "U-casey"}})
	if group.Channel != "G-U-corey_U-casey" || len(group.Participants) != 2 {
		t.Fatalf("group open: %+v", group)
	}
	f.api.mu.Lock()
	forms = append([]url.Values(nil), f.api.openForms...)
	f.api.mu.Unlock()
	if got := forms[len(forms)-1].Get("users"); got != "U-corey,U-casey" {
		t.Fatalf("group open users %q", got)
	}

	// A duplicate entry resolves to one user, so it is a DM.
	dup := f.open(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"U-corey", "Corey Hart"}})
	if dup.Channel != "D-U-corey" || len(dup.Participants) != 1 {
		t.Fatalf("duplicate users: %+v", dup)
	}

	// Unknown and ambiguous names are 400 with the candidates, and nothing is
	// opened or posted.
	f.api.mu.Lock()
	opens, posted := len(f.api.openForms), len(f.api.messages)
	f.api.mu.Unlock()
	code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"nobody"}})
	if code != http.StatusBadRequest || !strings.Contains(string(body), `"error":"unknown-user"`) || !strings.Contains(string(body), `"name":"nobody"`) {
		t.Fatalf("unknown user: %d %s", code, body)
	}
	code, _, body = f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"Alex Smith"}})
	if code != http.StatusBadRequest || !strings.Contains(string(body), `"error":"ambiguous-user"`) {
		t.Fatalf("ambiguous user: %d %s", code, body)
	}
	for _, id := range []string{"U-alex1", "U-alex2"} {
		if !strings.Contains(string(body), `"id":"`+id+`"`) {
			t.Fatalf("ambiguous candidates missing %s: %s", id, body)
		}
	}
	f.api.mu.Lock()
	opensAfter, postedAfter := len(f.api.openForms), len(f.api.messages)
	f.api.mu.Unlock()
	if opensAfter != opens || postedAfter != posted {
		t.Fatalf("a refused opener opened or posted: opens %d->%d messages %d->%d", opens, opensAfter, posted, postedAfter)
	}

	// A guest, a stranger, a bot and a wrong-team user are refused 403.
	for _, id := range []string{"U-guest", "U-ext", "U-botty", "U-other"} {
		if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{id}}); code != http.StatusForbidden || !strings.Contains(string(body), `"error":"forbidden"`) {
			t.Fatalf("forbidden %s: %d %s", id, code, body)
		}
	}

	// users.list is cached: every resolution above made one read.
	f.api.mu.Lock()
	reads := f.api.usersListRequests
	f.api.mu.Unlock()
	if reads != 1 {
		t.Fatalf("users.list calls %d, want 1", reads)
	}
}

// TestSlackConversationsEmail pins the email form of a conversation opener:
// an entry shaped like an email resolves with users.lookupByEmail instead of
// the cached member list, and the address is never cached, logged or echoed
// back. A lookup without users:read.email is the same 503 as users.list, and
// the guest/bot/stranger refusals apply to the resolved user.
func TestSlackConversationsEmail(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.mu.Lock()
	f.api.users["U-corey"] = fakeSlackUser{ID: "U-corey", TeamID: slackTeam, Name: "corey", RealName: "Corey Hart", DisplayName: "Corey H", Email: "corey@example.com"}
	f.api.users["U-guest"] = fakeSlackUser{ID: "U-guest", TeamID: slackTeam, Name: "Guest", IsRestricted: true, Email: "guest@example.com"}
	f.api.mu.Unlock()

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Hi Corey", Users: []string{"corey@example.com"}})
	if out.Channel != "D-U-corey" || len(out.Participants) != 1 || out.Participants[0].ID != "U-corey" || out.Participants[0].Name != "Corey H" {
		t.Fatalf("email open: %+v", out)
	}
	f.api.mu.Lock()
	lookups := f.api.lookupRequests
	emails := append([]string(nil), f.api.lookupEmails...)
	lists := f.api.usersListRequests
	f.api.mu.Unlock()
	if lookups != 1 || len(emails) != 1 || emails[0] != "corey@example.com" {
		t.Fatalf("users.lookupByEmail calls %d emails %v", lookups, emails)
	}
	if lists != 0 {
		t.Fatalf("users.list calls %d, want 0: an email must not read the member list", lists)
	}
	f.slack.mu.Lock()
	members := f.slack.members
	f.slack.mu.Unlock()
	if members != nil {
		t.Fatalf("email opener filled the member cache: %+v", members)
	}
	if logs := f.logged(); strings.Contains(logs, "corey@example.com") {
		t.Fatalf("log leaked the email:\n%s", logs)
	}
	if seen := f.seen(); strings.Contains(seen, "corey@example.com") {
		t.Fatalf("response or wake leaked the email:\n%s", seen)
	}

	// A guest resolved by email is refused, and the address is not echoed.
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"guest@example.com"}}); code != http.StatusForbidden || !strings.Contains(string(body), `"error":"forbidden"`) || strings.Contains(string(body), "guest@example.com") {
		t.Fatalf("guest email: %d %s", code, body)
	}

	// An email Slack does not know is unknown-user with no candidates, and
	// the address is not echoed back.
	code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"nobody@example.com"}})
	if code != http.StatusBadRequest || !strings.Contains(string(body), `"error":"unknown-user"`) {
		t.Fatalf("unknown email: %d %s", code, body)
	}
	if strings.Contains(string(body), "nobody@example.com") {
		t.Fatalf("unknown email echoed the address: %s", body)
	}

	// A missing scope on the lookup is the same 503 as users.list.
	f.api.mu.Lock()
	f.api.lookupError = "missing_scope"
	f.api.mu.Unlock()
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"corey@example.com"}}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), "missing-scope") {
		t.Fatalf("missing scope lookup: %d %s", code, body)
	}
}

// TestSlackConversationsUnknownCandidates pins that an unknown name is refused
// 400 with up to five near matches as candidates — a case-insensitive prefix
// or substring on the handle, real name or display name — each carrying the
// name and handle and never an email.
func TestSlackConversationsUnknownCandidates(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.mu.Lock()
	f.api.users["U-corey"] = fakeSlackUser{ID: "U-corey", TeamID: slackTeam, Name: "corey", RealName: "Corey Hart", DisplayName: "Corey H", Email: "corey@example.com"}
	f.api.users["U-corbin"] = fakeSlackUser{ID: "U-corbin", TeamID: slackTeam, Name: "corbin", RealName: "Corbin Lee"}
	f.api.users["U-cord"] = fakeSlackUser{ID: "U-cord", TeamID: slackTeam, Name: "cord", RealName: "Cordelia Stone"}
	f.api.users["U-cora"] = fakeSlackUser{ID: "U-cora", TeamID: slackTeam, Name: "cora", RealName: "Cora Vane"}
	f.api.users["U-cortez"] = fakeSlackUser{ID: "U-cortez", TeamID: slackTeam, Name: "cortez", RealName: "Cortez Ruiz"}
	f.api.users["U-corwin"] = fakeSlackUser{ID: "U-corwin", TeamID: slackTeam, Name: "corwin", RealName: "Corwin Black"}
	// A bot and a guest whose ids sort before the eligible matches: they are
	// near matches but can never be a target, so they must not be offered.
	f.api.users["U-aabot"] = fakeSlackUser{ID: "U-aabot", TeamID: slackTeam, Name: "aabot", RealName: "Corbot", IsBot: true}
	f.api.users["U-aaguest"] = fakeSlackUser{ID: "U-aaguest", TeamID: slackTeam, Name: "aaguest", RealName: "Corin Guest", IsRestricted: true}
	f.api.mu.Unlock()

	code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"cor"}})
	if code != http.StatusBadRequest || !strings.Contains(string(body), `"error":"unknown-user"`) {
		t.Fatalf("unknown name: %d %s", code, body)
	}
	var errBody struct {
		Error      string `json:"error"`
		Name       string `json:"name"`
		Candidates []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Handle string `json:"handle"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(body, &errBody); err != nil {
		t.Fatal(err)
	}
	// Six eligible users match and the cap is five; the bot and the guest
	// match too but are left out.
	if errBody.Name != "cor" || len(errBody.Candidates) != 5 {
		t.Fatalf("unknown-user body %+v", errBody)
	}
	handles := map[string]string{}
	for _, c := range errBody.Candidates {
		handles[c.ID] = c.Handle
	}
	for _, want := range []string{"U-cora", "U-corbin", "U-cord", "U-corey", "U-cortez"} {
		if handles[want] == "" {
			t.Fatalf("candidate %s missing from %v", want, handles)
		}
	}
	if _, ok := handles["U-aabot"]; ok {
		t.Fatalf("a bot was offered as a candidate: %v", handles)
	}
	if _, ok := handles["U-aaguest"]; ok {
		t.Fatalf("a guest was offered as a candidate: %v", handles)
	}
	if strings.Contains(string(body), "corey@example.com") {
		t.Fatalf("candidate leaked an email: %s", body)
	}
}

// TestSlackConversationsMissingScope pins the by-hand degrade: a multi-user
// DM whose open needs mpim:write, and a users.list without users:read, both
// answer 503 missing-scope.
func TestSlackConversationsMissingScope(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	f.api.mu.Lock()
	f.api.openError = "missing_scope"
	f.api.mu.Unlock()
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"U-bob", "U-carol"}}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), "missing-scope") {
		t.Fatalf("missing scope open: %d %s", code, body)
	}

	f.api.mu.Lock()
	f.api.openError = ""
	f.api.usersListError = "missing_scope"
	f.api.mu.Unlock()
	f.slack.mu.Lock()
	f.slack.members = nil
	f.slack.membersExpires = time.Time{}
	f.slack.mu.Unlock()
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"U-bob"}}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), "missing-scope") {
		t.Fatalf("missing scope list: %d %s", code, body)
	}
}

// TestSlackConversationsChannel pins the channel opener: a new top-level
// message as the app, 409 not-in-channel when the bot is not a member, and
// 503 slack-unavailable when Slack cannot be reached.
func TestSlackConversationsChannel(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Channel opener", Channel: "C0123"})
	if out.Channel != "C0123" || out.Session != "C0123:1.000000" || len(out.Participants) != 0 {
		t.Fatalf("channel open: %+v", out)
	}
	msgs := f.waitMessages(1)
	if msgs[0].Channel != "C0123" || msgs[0].ThreadTS != "" || msgs[0].Text != "Channel opener" {
		t.Fatalf("channel opener %+v", msgs[0])
	}

	f.api.mu.Lock()
	f.api.postError = "not_in_channel"
	f.api.mu.Unlock()
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Channel: "C0456"}); code != http.StatusConflict || !strings.Contains(string(body), "not-in-channel") {
		t.Fatalf("not in channel: %d %s", code, body)
	}

	f.api.mu.Lock()
	f.api.postError = ""
	f.api.down = true
	f.api.mu.Unlock()
	if code, _, body := f.openConversation(alice, slackConversationsRequest{Connection: alice, Text: "hi", Channel: "C0789"}); code != http.StatusServiceUnavailable || !strings.Contains(string(body), "slack-unavailable") {
		t.Fatalf("down: %d %s", code, body)
	}
}

// TestSlackConversationsLease pins that the answer's session and capability
// are leasable exactly as after a wake, and that a lease on a conversation bb
// opened is accepted only from the connection that opened it.
func TestSlackConversationsLease(t *testing.T) {
	f := newSlackFixture(t)
	alice, _ := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "hi", Users: []string{"U-bob"}})
	if !f.slack.capabilityValid(out.Session, "U-alice", out.Capability) || f.slack.capabilityValid(out.Session, "U-bob", out.Capability) {
		t.Fatalf("capability %q", out.Capability)
	}

	// Another connection of the same user cannot take the opened lease.
	other, _ := f.stream()
	if c := f.srv.Registry.Get(other); c != nil {
		f.srv.Registry.Identify(c, "slack", "U-alice", "Alice", nil)
	}
	refused := f.subscribe("slack", other, []Watch{{Kind: "session", ID: out.Session, Capability: out.Capability}})
	if len(refused.Leases) != 0 || len(refused.Rejected) != 1 || refused.Rejected[0].Reason != "forbidden" {
		t.Fatalf("other connection lease: %+v", refused)
	}

	ok := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: out.Session, Capability: out.Capability}})
	if len(ok.Leases) != 1 || len(ok.Rejected) != 0 {
		t.Fatalf("opener lease: %+v", ok)
	}
	if !f.slack.allowed(out.Session, "U-alice") {
		t.Fatal("opener does not hold the lease")
	}
}

// TestSlackOpenedDMTopLevelRouting pins the 1:1 DM rule: with one live
// opened lease and a sender who has no bb connection, a top-level DM
// continues the opened conversation; once the sender has a server of their
// own, their top-level DM reaches it instead; and a threaded reply in the
// opener's thread always routes to the opened session.
func TestSlackOpenedDMTopLevelRouting(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Bob, quick question", Users: []string{"bob"}})
	if out.Channel != "D-U-bob" {
		t.Fatalf("channel %q", out.Channel)
	}
	if sub := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: out.Session, Capability: out.Capability}}); len(sub.Leases) != 1 {
		t.Fatalf("lease: %+v", sub)
	}
	openerTS := strings.TrimPrefix(out.Session, "D-U-bob:")

	// Bob has no bb connection, so his top-level reply continues the opened
	// conversation and reaches Alice's server.
	f.deliver(f.message("Ev-1", slackTeam, slackApp, "U-bob", "D-U-bob", "Here you go", map[string]any{"ts": "222.333"}), true, 0)
	wk := wakeSlack(t, aliceWakes, out.Session)
	if !wk.Opened || wk.Tagged || wk.Mention || wk.FromOwner || !wk.Comment.Untrusted || wk.Comment.Text != "Here you go" {
		t.Fatalf("opened reply wake %+v", wk)
	}
	if wk.Asker.ID != "U-bob" || wk.Owner.ID != "U-alice" || wk.Thread != openerTS || wk.TS != "222.333" {
		t.Fatalf("opened reply identities %+v", wk)
	}

	// Bob connects his own server: his top-level DM now reaches it, not the
	// opened lease, and its wake is byte-identical to an ordinary DM's.
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))
	f.deliver(f.message("Ev-2", slackTeam, slackApp, "U-bob", "D-U-bob", "my own bb", map[string]any{"ts": "333.444"}), true, 0)
	own := wakeSlack(t, bobWakes, "D-U-bob:333.444")
	if own.Opened || !own.Tagged || !own.FromOwner || own.Owner.ID != "U-bob" {
		t.Fatalf("connected sender wake %+v", own)
	}
	if data, _ := json.Marshal(own); strings.Contains(string(data), "opened") {
		t.Fatalf("ordinary wake carries opened: %s", data)
	}
	noSlackWake(t, aliceWakes)

	// A threaded reply in the opener's thread always routes to the opened
	// session, even from the sender's own connected server.
	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "im", "user": "U-bob", "channel": "D-U-bob",
		"ts": "444.555", "thread_ts": openerTS, "text": "in thread",
	}), true, 0)
	threaded := wakeSlack(t, aliceWakes, out.Session)
	if !threaded.Opened || threaded.Tagged || threaded.TS != "444.555" || threaded.Thread != openerTS {
		t.Fatalf("opened threaded wake %+v", threaded)
	}
	noSlackWake(t, bobWakes)
}

// TestSlackOpenedChannelThread pins that a reply in the opener's thread of a
// channel bb opened routes as an untagged reply in a followed thread.
func TestSlackOpenedChannelThread(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Channel opener", Channel: "C0123"})
	if sub := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: out.Session, Capability: out.Capability}}); len(sub.Leases) != 1 {
		t.Fatalf("lease: %+v", sub)
	}
	openerTS := strings.TrimPrefix(out.Session, "C0123:")
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "channel", "user": "U-alice", "channel": "C0123",
		"ts": "222.333", "thread_ts": openerTS, "text": "a reply",
	}), true, 0)
	wk := wakeSlack(t, aliceWakes, out.Session)
	if !wk.Opened || wk.Tagged || !wk.FromOwner || wk.Comment.Text != "a reply" {
		t.Fatalf("opened channel wake %+v", wk)
	}
}

// TestSlackOpenedMpimRouting pins group-DM routing: a top-level message, a
// file_share, an edit and a deletion in a group DM bb opened route to the
// opened session, marked opened and untagged.
func TestSlackOpenedMpimRouting(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))

	out := f.open(alice, slackConversationsRequest{Connection: alice, Text: "Group opener", Users: []string{"bob", "carol"}})
	if out.Channel != "G-U-bob_U-carol" {
		t.Fatalf("channel %q", out.Channel)
	}
	if sub := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: out.Session, Capability: out.Capability}}); len(sub.Leases) != 1 {
		t.Fatalf("lease: %+v", sub)
	}
	openerTS := strings.TrimPrefix(out.Session, "G-U-bob_U-carol:")

	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "mpim", "user": "U-bob", "channel": "G-U-bob_U-carol",
		"ts": "222.333", "text": "hello group",
	}), true, 0)
	wk := wakeSlack(t, aliceWakes, out.Session)
	if !wk.Opened || wk.Tagged || wk.FromOwner || !wk.Comment.Untrusted || wk.Comment.Text != "hello group" {
		t.Fatalf("mpim top-level wake %+v", wk)
	}
	if wk.Thread != openerTS || wk.TS != "222.333" {
		t.Fatalf("mpim identities %+v", wk)
	}

	f.deliver(f.event("Ev-2", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "file_share", "channel_type": "mpim", "user": "U-carol",
		"channel": "G-U-bob_U-carol", "ts": "333.444", "text": "see file",
		"files": []map[string]any{{"id": "F-1", "name": "x.txt", "mimetype": "text/plain", "size": 3}},
	}), true, 0)
	fileWake := wakeSlack(t, aliceWakes, out.Session)
	if !fileWake.Opened || len(fileWake.Files) != 1 || fileWake.Files[0].ID != "F-1" {
		t.Fatalf("mpim file wake %+v", fileWake)
	}

	f.deliver(f.event("Ev-3", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_changed", "channel_type": "mpim",
		"channel":          "G-U-bob_U-carol",
		"message":          map[string]any{"user": "U-bob", "ts": "222.333", "text": "hello group edited"},
		"previous_message": map[string]any{"user": "U-bob", "ts": "222.333", "text": "hello group"},
	}), true, 0)
	edit := wakeSlack(t, aliceWakes, out.Session)
	if edit.Action != "edited" || !edit.Opened || edit.Tagged || edit.Comment.Text != "hello group edited" {
		t.Fatalf("mpim edit wake %+v", edit)
	}
	f.deliver(f.event("Ev-4", slackTeam, slackApp, map[string]any{
		"type": "message", "subtype": "message_deleted", "channel_type": "mpim",
		"channel": "G-U-bob_U-carol", "deleted_ts": "222.333",
		"previous_message": map[string]any{"user": "U-bob", "ts": "222.333", "text": "hello group"},
	}), true, 0)
	del := wakeSlack(t, aliceWakes, out.Session)
	if del.Action != "deleted" || !del.Opened || del.Tagged || del.TS != "222.333" {
		t.Fatalf("mpim delete wake %+v", del)
	}
}

// TestSlackOpenedMpimHistory pins that a group-DM thread's first wake carries
// the earlier messages, exactly as a DM or channel thread does.
func TestSlackOpenedMpimHistory(t *testing.T) {
	f := newSlackFixture(t)
	_, wakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	f.api.setReplies("111.222", map[string]any{"ts": "111.222", "user": "U-bob", "text": "group earlier"})
	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "mpim", "user": "U-alice", "channel": "G-9",
		"ts": "222.333", "thread_ts": "111.222", "text": "group reply",
	}), true, 0)
	wk := wakeSlack(t, wakes, "G-9:111.222")
	if len(wk.History) != 1 || wk.History[0].Text != "group earlier" {
		t.Fatalf("mpim history %+v", wk.History)
	}
}

// TestSlackOpenedTwoLeases pins the fallback: a channel with two live opened
// leases does not hijack a top-level message; it goes down today's path.
func TestSlackOpenedTwoLeases(t *testing.T) {
	f := newSlackFixture(t)
	alice, aliceWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-alice", TeamID: slackTeam, Name: "Alice"}))
	_, bobWakes := f.pod(f.api.accessFor(fakeSlackUser{ID: "U-bob", TeamID: slackTeam, Name: "Bob"}))

	first := f.open(alice, slackConversationsRequest{Connection: alice, Text: "one", Users: []string{"bob", "carol"}})
	second := f.open(alice, slackConversationsRequest{Connection: alice, Text: "two", Users: []string{"bob", "carol"}})
	if first.Channel != second.Channel || first.Session == second.Session {
		t.Fatalf("two opens: %+v %+v", first, second)
	}
	for _, session := range []string{first.Session, second.Session} {
		if sub := f.subscribe("slack", alice, []Watch{{Kind: "session", ID: session, Capability: f.slack.leaseCapability(session, "U-alice")}}); len(sub.Leases) != 1 {
			t.Fatalf("lease %s: %+v", session, sub)
		}
	}

	f.deliver(f.event("Ev-1", slackTeam, slackApp, map[string]any{
		"type": "message", "channel_type": "mpim", "user": "U-bob", "channel": first.Channel,
		"ts": "222.333", "text": "top level",
	}), true, 0)
	wk := wakeSlack(t, bobWakes, first.Channel+":222.333")
	if wk.Opened || !wk.Tagged || !wk.FromOwner || wk.Owner.ID != "U-bob" {
		t.Fatalf("two-lease wake %+v", wk)
	}
	noSlackWake(t, aliceWakes)
}
