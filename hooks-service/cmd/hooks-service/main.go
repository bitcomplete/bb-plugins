// hooks-service: webhooks in from the internet, doorbells out to developer
// servers. See docs/hooks.md.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"hooks-service/hooks"
	"hooks-service/sentryx"
)

func main() {
	if err := run(); err != nil {
		slog.Error("hooks-service", "err", err)
		os.Exit(1)
	}
}

// verifyStatsInterval is how often the hooks log their verification read
// counters. It is short enough to line up with a half-hourly Sentry sweep and
// long enough that the lines stay sparse.
const verifyStatsInterval = 15 * time.Minute

func run() error {
	var (
		listen      = flag.String("listen", ":8080", "public listen address: one path per source")
		subListen   = flag.String("subscribe-listen", ":8081", "cluster-only listen address: the subscriber API")
		opsListen   = flag.String("ops-listen", ":9090", "health listen address")
		subToken    = flag.String("subscribe-token", os.Getenv("BB_HOOKS_SUBSCRIBE_TOKEN"), "bearer token required on every subscriber API request (8081); BB_HOOKS_SUBSCRIBE_TOKEN otherwise")
		subOpen     = flag.Bool("subscribe-allow-unauthenticated", false, "allow the subscriber API on a non-loopback address with no token; for a namespace-isolated deployment")
		lease       = flag.Duration("lease", 60*time.Minute, "how long an admitted watch lasts without renewal")
		cache       = flag.Duration("verify-cache", 5*time.Minute, "how long a successful verification is remembered; 0 disables")
		sentryCache = flag.Duration("sentry-verify-cache", 6*time.Hour, "how long a successful Sentry verification is remembered; 0 uses -verify-cache")
		sentryStale = flag.Duration("sentry-verify-stale", 24*time.Hour, "how long past -sentry-verify-cache an expired successful Sentry verification may still be served when a renewal is rate limited; 0 disables")
		linearAPI   = flag.String("linear-api", hooks.LinearAPI, "Linear GraphQL endpoint for verification fetches")
		linearSec   = flag.String("linear-secret-file", "", "file holding the Linear webhook signing secret, re-read on every use; LINEAR_WEBHOOK_SECRET otherwise")
		linearCID   = flag.String("linear-client-id", os.Getenv("LINEAR_CLIENT_ID"), "the bb Linear application's OAuth client id, for minting the app token agent sessions post with; LINEAR_CLIENT_ID otherwise")
		linearCS    = flag.String("linear-client-secret-file", "", "file holding that application's client secret, re-read at every mint; LINEAR_CLIENT_SECRET otherwise")
		linearTok   = flag.String("linear-token-url", hooks.LinearTokenURL, "Linear OAuth token endpoint for the client credentials grant")
		linearSco   = flag.String("linear-app-scope", hooks.DefaultAppScope, "scope set requested for the app token; a change revokes the application's existing app tokens")
		linearStore = flag.String("linear-token-store", os.Getenv("LINEAR_TOKEN_STORE"), "file holding per-workspace Linear app token pairs (0600, atomic writes); empty keeps them in memory")
		linearAllow = flag.String("linear-allowed-workspaces", os.Getenv("LINEAR_ALLOWED_WORKSPACES"), "comma-separated Linear organization ids an admin may install bb into; the home workspace needs no entry")
		linearRedir = flag.String("linear-install-redirect-url", os.Getenv("LINEAR_INSTALL_REDIRECT_URL"), "the registered OAuth redirect URI for the per-workspace install callback; no default, the deployment sets it")
		ackBudget   = flag.Duration("session-ack-budget", hooks.DefaultAckBudget, "how long routing and acknowledging an agent session event may take; Linear's limit is 10s")
		githubAPI   = flag.String("github-api", hooks.GitHubAPI, "GitHub REST root for verification fetches")
		githubSec   = flag.String("github-secret-file", "", "file holding the GitHub webhook secret, re-read on every use; GITHUB_WEBHOOK_SECRET otherwise")
		sentryAPI   = flag.String("sentry-api", hooks.SentryAPI, "Sentry REST root for verification fetches")
		sentrySec   = flag.String("sentry-secret-file", "", "file holding the Sentry webhook signing secret, re-read on every use; SENTRY_WEBHOOK_SECRET otherwise")
		amAPI       = flag.String("alertmanager-api", os.Getenv("ALERTMANAGER_API"), "Alertmanager v2 API root; read only to admit a watch. Empty turns the Alertmanager adapter off")
		amSec       = flag.String("alertmanager-secret-file", "", "file holding the Alertmanager webhook bearer token, re-read on every use; ALERTMANAGER_WEBHOOK_SECRET otherwise")
		slackSec    = flag.String("slack-secret-file", "", "file holding the Slack signing secret, re-read on every use; SLACK_SIGNING_SECRET otherwise")
		slackBot    = flag.String("slack-bot-token-file", "", "file holding the Slack bot token, re-read on every use; SLACK_BOT_TOKEN otherwise")
		slackCID    = flag.String("slack-client-id", os.Getenv("SLACK_CLIENT_ID"), "the Slack app's OAuth client id, for Sign in with Slack; SLACK_CLIENT_ID otherwise")
		slackCS     = flag.String("slack-client-secret-file", "", "file holding the Slack app's OAuth client secret, re-read on every use; SLACK_CLIENT_SECRET otherwise")
		slackRed    = flag.String("slack-redirect-url", os.Getenv("SLACK_REDIRECT_URL"), "the registered Slack OAuth redirect URI: the plugin's callback on the developer's own server, behind tsjwt; no default, the deployment sets it")
		publicBase  = flag.String("public-base-url", os.Getenv("PUBLIC_BASE_URL"), "the public base URL of a developer's bb server, used in the Slack set-up replies; no default, the deployment sets it")
		slackTeam   = flag.String("slack-team-id", os.Getenv("SLACK_TEAM_ID"), "the team app's workspace id; discovered from the bot token when empty")
		slackApp    = flag.String("slack-app-id", os.Getenv("SLACK_APP_ID"), "the team app's id; discovered from the bot token when empty")
		slackAPI    = flag.String("slack-api", hooks.SlackAPI, "Slack Web API root")
		verbose     = flag.Bool("v", false, "debug logging")
	)
	flag.Parse()

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	base := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	sentryClient, _ := sentryx.Init(sentryx.Options{Service: "hooks-service", Logger: slog.New(base)})
	defer sentryClient.Flush(2 * time.Second)
	log := slog.New(sentryx.NewHandler(base, sentryClient))
	slog.SetDefault(log)

	// Secrets come from the deployment's Secret, one key per source,
	// mounted as files and re-read on use so the adapter turns on when the
	// key appears and follows a rotation without a restart. An absent key
	// disables that adapter rather than the service. The environment
	// variable is for running outside the cluster.
	linear := &hooks.Linear{
		Secret:     []byte(strings.TrimSpace(os.Getenv("LINEAR_WEBHOOK_SECRET"))),
		SecretFile: *linearSec,
		API:        *linearAPI,
		HTTP:       &http.Client{Timeout: 10 * time.Second},
	}
	github := &hooks.GitHub{
		Secret:     []byte(strings.TrimSpace(os.Getenv("GITHUB_WEBHOOK_SECRET"))),
		SecretFile: *githubSec,
		API:        *githubAPI,
		HTTP:       &http.Client{Timeout: 10 * time.Second},
	}
	sentry := &hooks.Sentry{
		Secret:     []byte(strings.TrimSpace(os.Getenv("SENTRY_WEBHOOK_SECRET"))),
		SecretFile: *sentrySec,
		API:        *sentryAPI,
		HTTP:       &http.Client{Timeout: 10 * time.Second},
		Logger:     log,
	}
	alertmanager := &hooks.Alertmanager{
		Secret:     []byte(strings.TrimSpace(os.Getenv("ALERTMANAGER_WEBHOOK_SECRET"))),
		SecretFile: *amSec,
		API:        *amAPI,
		HTTP:       &http.Client{Timeout: 10 * time.Second},
	}
	adapters := []hooks.Adapter{linear, github, sentry, alertmanager}
	for _, a := range adapters {
		if !a.Enabled() {
			log.Warn("adapter disabled: not configured", "source", a.Source())
		}
	}

	// Slack: the one team app. The signing secret verifies deliveries, the
	// bot token posts as the app, and the OAuth client secret is used only
	// here to exchange a developer's "Sign in with Slack" code. None of the
	// three ever reaches a pod.
	slack := &hooks.Slack{
		SigningSecret:     []byte(strings.TrimSpace(os.Getenv("SLACK_SIGNING_SECRET"))),
		SigningSecretFile: *slackSec,
		BotToken:          []byte(strings.TrimSpace(os.Getenv("SLACK_BOT_TOKEN"))),
		BotTokenFile:      *slackBot,
		ClientID:          strings.TrimSpace(*slackCID),
		ClientSecret:      []byte(strings.TrimSpace(os.Getenv("SLACK_CLIENT_SECRET"))),
		ClientSecretFile:  *slackCS,
		RedirectURL:       strings.TrimSpace(*slackRed),
		PublicBaseURL:     strings.TrimSpace(*publicBase),
		TeamID:            strings.TrimSpace(*slackTeam),
		AppID:             strings.TrimSpace(*slackApp),
		API:               *slackAPI,
		HTTP:              &http.Client{Timeout: 10 * time.Second},
	}
	if !slack.Enabled() {
		log.Warn("slack adapter disabled: no signing secret yet")
	} else {
		if slack.RedirectURL == "" {
			log.Warn("slack adapter enabled without -slack-redirect-url; Sign in with Slack will fail")
		}
		if slack.PublicBaseURL == "" {
			log.Warn("slack adapter enabled without -public-base-url; set-up replies will omit the bb link")
		}
		// Resolve the workspace and app id from the bot token in the
		// background so the first event does not pay for it. A failure is
		// not fatal: the first event tries again.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := slack.Start(ctx); err != nil {
				log.Warn("slack workspace not resolved yet; will retry on the first event", "err", err)
			}
		}()
	}

	// Agent sessions post as the app with a token this service mints from
	// the application's client credentials and holds in memory; neither the
	// secret nor the token is ever sent to a developer's server. Without
	// credentials, sessions are acknowledged to Linear with a 200 and
	// otherwise dropped. Other workspaces' tokens come from the install
	// callback and are persisted under StorePath.
	var allowedWorkspaces []string
	for _, id := range strings.Split(*linearAllow, ",") {
		if id = strings.TrimSpace(id); id != "" {
			allowedWorkspaces = append(allowedWorkspaces, id)
		}
	}
	sessions := &hooks.Sessions{
		ClientID:           strings.TrimSpace(*linearCID),
		ClientSecret:       []byte(strings.TrimSpace(os.Getenv("LINEAR_CLIENT_SECRET"))),
		ClientSecretFile:   *linearCS,
		TokenURL:           *linearTok,
		Scope:              *linearSco,
		API:                *linearAPI,
		HTTP:               &http.Client{Timeout: 10 * time.Second},
		AckBudget:          *ackBudget,
		StorePath:          strings.TrimSpace(*linearStore),
		AllowedWorkspaces:  allowedWorkspaces,
		InstallRedirectURL: strings.TrimSpace(*linearRedir),
	}
	if !sessions.Enabled() {
		log.Warn("agent sessions disabled: no Linear client id and secret yet")
	} else {
		if sessions.InstallRedirectURL == "" {
			log.Warn("agent sessions enabled without -linear-install-redirect-url; per-workspace install will fail")
		}
		// Mint the first token now rather than inside the first event's
		// acknowledgement budget. A failure is logged, not fatal: the next
		// use mints again, and the secret may be fixed in place.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := sessions.Start(ctx); err != nil {
				log.Error("app token not minted at startup; will retry on first use", "err", err)
			}
		}()
	}

	// Refuse to serve the subscriber API unauthenticated on a non-loopback
	// address unless the operator explicitly opted out. A namespace-isolated
	// deployment passes the opt-out because the port is reachable only from
	// its own pods.
	subTokenValue := strings.TrimSpace(*subToken)
	if err := hooks.CheckSubscriberAuth(*subListen, subTokenValue, *subOpen); err != nil {
		return err
	}

	srv := &hooks.Server{
		Registry:          &hooks.Registry{Lease: *lease},
		Adapters:          adapters,
		CacheTTL:          *cache,
		SentryCacheTTL:    *sentryCache,
		SentryVerifyStale: *sentryStale,
		Logger:            log,
		Sessions:          sessions,
		Slack:             slack,
		SubscriberToken:   []byte(subTokenValue),
	}

	// Log the verify read counters on an interval, so the reads hooks makes
	// per hour are measurable from the logs.
	statsCtx, stopStats := context.WithCancel(context.Background())
	defer stopStats()
	go func() {
		t := time.NewTicker(verifyStatsInterval)
		defer t.Stop()
		for {
			select {
			case <-statsCtx.Done():
				return
			case <-t.C:
				srv.LogVerifyStats()
			}
		}
	}()

	ops := http.NewServeMux()
	ops.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })

	// No write timeouts: the event stream lives for hours.
	public := &http.Server{Addr: *listen, Handler: sentryClient.Recover(srv.Public()), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second}
	sub := &http.Server{Addr: *subListen, Handler: sentryClient.Recover(srv.Subscriber()), ReadHeaderTimeout: 10 * time.Second}
	opsSrv := &http.Server{Addr: *opsListen, Handler: sentryClient.Recover(ops), ReadHeaderTimeout: 5 * time.Second}

	errc := make(chan error, 3)
	go func() { errc <- public.ListenAndServe() }()
	go func() { errc <- sub.ListenAndServe() }()
	go func() { errc <- opsSrv.ListenAndServe() }()
	log.Info("serving", "public", *listen, "subscribe", *subListen, "ops", *opsListen, "lease", *lease)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = opsSrv.Shutdown(shut)
	_ = public.Shutdown(shut)
	// End the streams first: Shutdown waits for handlers, and the stream
	// handler would otherwise hold until the deadline.
	srv.Close()
	return sub.Shutdown(shut)
}
