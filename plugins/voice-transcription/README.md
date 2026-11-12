# Voice transcription

A voice-input service for bb that runs in the **server process** and posts a
recording to any OpenAI-compatible `/audio/transcriptions` endpoint. It needs
no primary machine, no bb account and no Codex login, so it works on a
`bb-server` pod and on a devbox alike.

bb keeps its normal voice flow: click the mic in the composer, record, click
stop, and the text lands in the composer. `bb voice transcribe <file>` uses
the same service. This plugin registers `voice-transcription:openai-compatible`
as a third voice service beside bb cloud and Codex; it does not touch either.

The one wire format it speaks covers OpenAI (`gpt-4o-transcribe`,
`gpt-4o-mini-transcribe`, `whisper-1`), Groq (Whisper large v3 turbo),
Mistral (Voxtral), OpenRouter, Fireworks and self-hosted Whisper servers
(whisper.cpp server, faster-whisper-server, vLLM). Vendor-specific adapters
(ElevenLabs Scribe, AssemblyAI, Deepgram) are follow-ups.

## Settings

Editable under **Settings → Plugins → Voice transcription**, or with
`bb plugin config voice-transcription`:

| key | default | meaning |
| -- | -- | -- |
| `baseUrl` | `https://api.openai.com/v1` | No trailing slash; `/audio/transcriptions` is appended. |
| `apiKey` | empty | Sent only as `Authorization: Bearer` to `baseUrl`. Stored in the plugin's 0600 secrets file and never sent to the frontend. The same key mints short-lived Realtime client secrets when `baseUrl` is OpenAI's. Leave empty for a self-hosted server with no auth. |
| `model` | `gpt-4o-transcribe` | Passed through verbatim. |
| `language` | empty | ISO-639-1 code such as `en`. Empty lets the endpoint auto-detect. |

The service is **not ready** while `baseUrl` or `model` is empty, and it is
also not ready when `apiKey` is empty against the default OpenAI endpoint —
that would send audio to OpenAI unauthenticated. An empty key is ready only
when `baseUrl` points somewhere else.

Recordings over 25 MB (OpenAI's limit) are refused before anything is sent.
One retry is made on HTTP 429 or 5xx if the caller is still waiting. bb
bounds a transcribe call through the signal it passes (10 seconds), so a
signal timeout, an abort and every 4xx are final. A failed call reports the status,
the endpoint and the first 200 characters of the response body with the key
removed. The server log gets one line per call — duration, bytes, status —
and never the audio or the transcript.

## Realtime voice

The plugin can also carry a two-way spoken session, for a plugin that wants a
voice conversation rather than a one-shot transcript. It is **inert unless
`baseUrl` is OpenAI's own endpoint and a key is set**: the transcription-only
vendors have no Realtime API, so the routes refuse and the overlay renders
nothing, no session can be opened, and the ordinary transcription above is
untouched.

A session has three pieces:

* An opener — another plugin — calls the `realtime.open` RPC with the session
  instructions and the tools the model may call, and names its own RPC method
  for the tool results. It receives a session id. Two optional opt-ins shape the
  turn-taking: `speaksFirst: true` makes the overlay send one `response.create`
  when the data channel opens, so the model greets and leads instead of waiting
  for the owner to speak; and `onClose: { method }` names the opener's own RPC
  method that the close route calls with the session id whenever the session
  ends. Both default off, so an opener that wants today's behaviour is
  unchanged. It may also name the `client` that asked: the overlay in every
  tab keeps a per-tab id in
  `sessionStorage` under `voice-transcription:realtime-client`, and an opener
  whose frontend reads that entry and passes it through its backend gets a
  session that only that tab answers. Without it the open signal reaches every
  tab of the same server, and the first overlay to mint takes the session —
  a stand-up started on a phone can then play from a laptop left open on a
  desk.
* The plugin's **mint route** (`POST
  /api/v1/plugins/voice-transcription/http/realtime/session`) exchanges the
  plugin's stored key for a short-lived OpenAI **ephemeral client secret** and
  returns that to the browser. The standard key is used only in the server's
  request to OpenAI and never reaches the browser. It refuses with a clear
  status when the endpoint is not OpenAI's (400) or no key is set (403), for
  an unknown or already-minted session (404/409), and for a session opened
  for another client (409).
* The app-wide **overlay** opens the WebRTC session straight from the browser
  to OpenAI with the ephemeral secret, plays the model's audio, shows the live
  transcript, and forwards each model tool call to the opener, returning its
  result. It ends the session on the server when it closes.

The tool route's reply is `{ output }`, or `{ output, last: true }` when the
opener returns an object with that flag instead of a plain string. A `last`
reply lets the model finish its current response and its audio (the overlay
waits for the WebRTC `output_audio_buffer.stopped` signal, with a short
fallback), then stops the session itself, which is how an opener ends a
conversation from inside a tool call. Note that the extended shape reserves an
object with a string `output` field: an opener that returns other JSON is
stringified as before, but one that returns data under an `output` key now
gets the unwrapped text, so use a different key for data.

The close route calls the opener's `onClose` method with the session id for
every kind of end: the End button, the 20-minute cap, the overlay unmounting
(a closed tab), and a model-initiated end after a `last` tool reply. The
overlay also nudges the route on `pagehide`, and the server sweeps expired
sessions on its own timer, so a closed tab or a quiet model still ends the
session and reaches the opener. An opener that named no `onClose` is
unaffected, the handler is called at most once per session, and a failed
handler is logged, not surfaced to the browser.

Spend is bounded: the ephemeral secret expires after 60 seconds, one session
is capped at 20 minutes (the overlay counts down and closes itself, and the
server refuses tool calls once a session is past the cap), and the session is
dropped when the overlay closes.

`throwaway/` holds a minimal caller used to prove the surface end to end
without a second plugin; it is disposable once a real caller exists. The
browser audio path still needs a by-hand check with a real key and a
microphone.

## Deployment-wide defaults

A deployment running a server per developer can hand them all one key and
endpoint instead of each person pasting their own. The server process reads
these variables at start:

| variable | setting | meaning |
| -- | -- | -- |
| `VOICE_TRANSCRIPTION_API_KEY` | `apiKey` | The shared key, sent as `Authorization: Bearer`. It is never a settings default, so it never reaches the frontend. |
| `VOICE_TRANSCRIPTION_BASE_URL` | `baseUrl` | The default endpoint, used when `baseUrl` is unset. |
| `VOICE_TRANSCRIPTION_MODEL` | `model` | The default model, used when `model` is unset. |

A developer's own setting still wins. `bb plugin config voice-transcription
unset apiKey` goes back to the shared key; `unset baseUrl` or `unset model`
goes back to the deployment's default for that one.

The environment is read once, when the plugin loads, so rotating the shared
key or endpoint needs a server restart. `bb plugin config voice-transcription
set apiKey <key>` overrides the shared key on that server until it is unset.

## Examples

OpenAI:

```
baseUrl  https://api.openai.com/v1
apiKey   sk-…
model    gpt-4o-transcribe
language en
```

Groq (Whisper large v3 turbo):

```
baseUrl  https://api.groq.com/openai/v1
apiKey   gsk_…
model    whisper-large-v3-turbo
language en
```

A self-hosted whisper.cpp or faster-whisper server on the tailnet, no auth:

```
baseUrl  http://whisper.local:8080/v1
apiKey   (empty)
model    whisper-1
language (empty, auto-detect)
```

## Choosing the service

List the voice services and their readiness:

```sh
bb settings ai-services
```

Pin this one for voice input (otherwise Automatic uses it once it is ready):

```sh
bb settings ai-services set voice voice-transcription:openai-compatible
```

Back to Automatic, or off:

```sh
bb settings ai-services set voice automatic
bb settings ai-services set voice off
```

## Installing

```sh
bb plugin install git:https://github.com/bitcomplete/bb-plugins.git@main --plugin voice-transcription
```

The plugin ships with no credential of its own. A deployment can supply one
through the environment (see [Deployment-wide defaults](#deployment-wide-defaults));
otherwise each developer sets their own `apiKey`, or points `baseUrl` at an
endpoint that needs none.
