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
| `apiKey` | empty | Sent only as `Authorization: Bearer` to `baseUrl`. Stored in the plugin's 0600 secrets file and never sent to the frontend. Leave empty for a self-hosted server with no auth. |
| `model` | `gpt-4o-transcribe` | Passed through verbatim. |
| `language` | empty | ISO-639-1 code such as `en`. Empty lets the endpoint auto-detect. |

The service is **not ready** while `baseUrl` or `model` is empty, and it is
also not ready when `apiKey` is empty against the default OpenAI endpoint —
that would send audio to OpenAI unauthenticated. An empty key is ready only
when `baseUrl` points somewhere else.

Recordings over 25 MB (OpenAI's limit) are refused before anything is sent.
One retry is made on HTTP 429 or 5xx if the caller is still waiting; a
timeout, an abort and every 4xx are final. A failed call reports the status,
the endpoint and the first 200 characters of the response body with the key
removed. The server log gets one line per call — duration, bytes, status —
and never the audio or the transcript.

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

The plugin ships with no credential; each developer sets their own `apiKey`
(or points `baseUrl` at an endpoint that needs none).
