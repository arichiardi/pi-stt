# pi-stt - speech-to-text for pi

Speech-to-text for the [Pi](https://pi.dev) coding agent. Today it gives you
full-duplex realtime voice over the OpenAI Realtime API (`/v1/realtime`). Over
time it will also add transcription agent tools (audio files, voice notes) so Pi
can transcribe on demand, not only in a live session.

> **Origin and credit.** This project started as a fork of
> [`pi-voice-realtime`](https://github.com/IgorGuariroba/pi-voice-realtime) and
> is evolving it. All credit for the original code, the Codex `/voice` parity
> work, and the realtime architecture goes to **[@IgorGuariroba](https://github.com/IgorGuariroba)**.
> It is MIT licensed. See [Origin and attribution](#origin-and-attribution).

```
/stt-live
  → opens a realtime session (microphone open, server VAD)
  → you speak; the voice model answers by voice
  → a work request → background_agent → a normal Pi agent turn
  → when it finishes, the result returns as [BACKEND] + function_call_output (ADR 0002)
  → the voice model summarizes in 1–3 spoken sentences
```

## Roadmap

- **v1 (now):** realtime voice sessions over `/v1/realtime` (OpenAI Realtime).
- **Next:** client-side VAD so the project works against self-hosted
  `/v1/realtime` servers such as llama.cpp, which return `turn_detection: null`
  and provide no server-side VAD.
- **Later:** transcription agent tools - transcribe a file, a voice note, or a
  meeting on demand, outside a live session.

## Install

Requirements:

- Linux with PulseAudio/PipeWire, `pactl`, `parec`, `pacat`, and
  `module-echo-cancel` with WebRTC AEC.
- An OpenAI credential with access to the Realtime API.

```bash
pi install npm:@ar-llm/pi-stt
```

Restart Pi or run `/reload`, then run `/stt-live`.
To update an existing npm install, run `pi update --extensions`.

## Usage

| Command / key | Effect |
|---|---|
| `/stt-live` or `/stt-live start` | start the session (idempotent) |
| `/stt-live stop` | end the session and release mic/player |
| `/stt-live mute` / `unmute` | microphone (does not affect playback) |
| `f9` | toggle mute |
| `/stt-live settings` | choose the voice; ↑↓ plays a preview (sample is generated once and cached in `<agentDir>/voice/previews/`) (applies to the next session) |
| `/stt-live status` | state, voice, model, credential, devices |

UI: a widget above the editor (`voice ● listening` / `mic ▁ ▂ ▄ ▆ █ ▅ ▃ ▂ ▁ ▁` /
`f9 mute` / `/stt-live stop`) plus a line in the native footer, which keeps showing
tokens/git/model. Consolidated speech appears in history and enters the agent
context as a `[USER]` message without triggering a turn (`sendMessage` without
`triggerTurn`), so it enters the model context as a `TranscriptSegment`.

## Credential

The normal path is Pi's own login. The extension reads the same credential:

```
/login openai
/stt-live status   # credential: ok
```

Precedence: `OPENAI_API_KEY` → `PI_VOICE_API_KEY` → the `openai` entry in
`<agentDir>/auth.json` (where `/login openai` writes). `agentDir` is
`$PI_CODING_AGENT_DIR` or `~/.config/pi/agent`. The environment
variables are for temporary use or CI.

## Configuration

`<agentDir>/ar-llm/stt.json` (created when you choose a voice in `/stt-live settings`):

```json
{
  "voice": "marin",
  "model": "gpt-realtime-2.1-mini",
  "muteOnStart": false,
  "vad": {
    "engine": "server",
    "mode": "aggressive",
    "onsetMs": 60,
    "hangoverMs": 700,
    "prefillMs": 450,
    "commitResponse": true
  }
}
```

The current AEC path uses the default PulseAudio/PipeWire devices. Remove
`inputDevice`/`outputDevice` if they are set. Explicit ALSA devices are rejected
so playback cannot bypass the echo reference.

## Audio

PCM16LE mono 24 kHz, 20 ms frames (960 bytes). The active path requires Linux,
`pactl`, `parec`, `pacat`, and `module-echo-cancel` with WebRTC AEC.

Each session creates a processed source and a reference sink with unique names:
`parec` reads the source with a 30 ms buffer to track speech on the meter;
`pacat` sends the whole answer to the sink. The module cancels echo locally and
keeps full-duplex. Global default devices are not changed. Stop and failures end
the processes and request module unload. If AEC does not load, the session does
not fall back to raw capture.

macOS/Windows are not supported by the current AEC path. The older
backend-selection functions remain in `src/audio.ts`, but `/stt-live` does not use them.

This backend uses WebRTC AEC from the audio server. It is not a Sonora-style
helper. Creating the routes does not prove echo reduction. Acoustic
measurement and speaker validation are still pending.

## Client VAD (turn detection)

Self-hosted servers such as `llama.cpp` `/v1/realtime` report
`turn_detection: null`. They do not detect turn boundaries. The client decides
the boundary with a Voice Activity Detection (VAD) gate. This is off by default.
OpenAI keeps server VAD when `engine` is `off`.

Pick a `vad.engine`:

| Engine | What it is | Cost |
|---|---|---|
| `fvad` | WebRTC VAD (libfvad, GMM) through `@ozymandiasthegreat/vad` (WASM). The mobile/Android algorithm. | ~53 KB, no model download |
| `rms` | Pure-TypeScript RMS gate. The fallback. | zero extra dependency |
| `server` | No client VAD. Server VAD is kept (OpenAI default). | none |

The gate resamples 24 kHz capture to 16 kHz. It scores 10 ms frames. A turn
opens after `onsetMs` of speech. It closes after `hangoverMs` of silence. That
silence is the commit point. `prefillMs` keeps a short pre-roll so the first
syllable is not lost. `commitResponse` sends `response.create` after each
`input_audio_buffer.commit`.

When a client engine is active, the session update sends `turn_detection: null`.
This stops double turn boundaries. The gate drives barge-in locally.

The main engine falls back to `rms` with a warning if the WASM module does not
load. A scorer failure makes the gate fail open: it forwards all audio and warns
once. The microphone never freezes.

`@ozymandiasthegreat/vad` ships its WASM in the npm package. `npm install` brings
it. `brew install libfvad` does not exist on macOS. The WASM path is used in
production. AEC capture uses PulseAudio/PipeWire (`parec`/`pacat`) and is Linux,
so validate VAD on Linux with `llama.cpp`. See `docs/plan-implementation.md`.

Set a client engine to try it:

```json
{ "vad": { "engine": "fvad", "mode": "aggressive" } }
```

## Implementation notes (what and why)

| Aspect | This extension | Why |
|---|---|---|
| Auth | `/v1/realtime` + API key | ChatGPT `intent=quicksilver` is not public |
| Transport auth | `ws` + `Authorization` | GA does not send `OpenAI-Beta`; see below |
| Transport | WebSocket PCM16 | same model and same VAD; avoids native `wrtc` |
| Audio / AEC | PulseAudio/PipeWire WebRTC AEC + `parec`/`pacat` | Linux backend; acoustic parity pending |
| Turn detection | Client VAD (libfvad/RMS) when `vad.engine` is not `off`; server VAD when off | self-hosted servers report `turn_detection: null` |
| Handoff | `background_agent`, `remain_silent` tools, fixed return texts | delegation + silence (ADR 0002) |
| Modules | `src/socket.ts` + `src/realtime.ts` + `src/audio.ts` | - |

### Transport

`import("ws")` fails from the extension directory, but
`createRequire(process.argv[1])("ws")` works: `process.argv[1]` is the Pi
entrypoint, which owns the `node_modules` where `ws` lives. This keeps the GA
handshake (headers). If that resolution fails (running outside Pi),
the extension falls back to Node's global `WebSocket`, which **does not** accept
headers, and then swaps the API key for an ephemeral client secret in a
subprotocol. The active mode shows in `/stt-live status`:
`transport: ws|global-websocket · auth: header|ephemeral-subprotocol`.

### Payload dialect

Only the GA format (`session.update`). The beta dialect was removed: it is not
used. `session.update` errors are reported, with no resubmit in a
different format.

### OpenRouter does not serve realtime mode

OpenRouter offers `/api/v1/audio/speech` (TTS), `/api/v1/audio/transcriptions`
(STT), and `gpt-audio` via `/chat/completions`, but it **does not** expose a
duplex session endpoint (`/v1/realtime`). Without it there is no continuous VAD,
barge-in, or streamed spoken answer. Using OpenRouter would require a different
mode (record → transcribe → agent → TTS), which is out of v1 scope.

What the current implementation supports: spoken answer from the model itself,
delegation as
`background_agent` with a `<realtime_delegation>` envelope, progress and result
as `[BACKEND]`, `function_call_output` on completion and on steer, a one-at-a-time
`response.create` queue, barge-in with `conversation.item.truncate`, speech in
the agent history, and `remain_silent`.

## Tests

```bash
node --test "test/**/*.test.ts"
```

The suite also covers realtime session lifecycle, the GA handshake, and AEC
route ownership (creation commands, pair usage, idempotent unload). These tests
do not measure canceler acoustic performance.

Offline coverage: GA event parser with a fixture, V2 `session.update` payload
(VAD, tools, instructions), delegation envelope, `response.create` queue,
truncate on barge-in, handoff cycle with a fake socket
(`test/integration.test.ts`), startup context, and PCM framing.

## Validation status

Proven: the offline tests above, real conversation with transcript and spoken
answer in Pi, and visual meter validation. Real capture through the AEC path
delivered blocks every 27–32 ms after startup, with the buffer set to 30 ms.

Still pending specific E2E validation: acoustic quality of echo cancellation,
barge-in against the server, and the full delegation cycle
speech → agent task → spoken answer.

## Known limits

- Device picker and persistent captions are deferred to v2 (scope decision).
- No reconnect phase: a WebSocket drop ends the session (no reconnect in v1).
- No transcript-tail-flush with a turn: speech goes to history immediately, so no
  buffer remains at close.
- Without an OpenAI key, `/stt-live` warns and opens no session - there is no local
  fallback.
- The session keeps the microphone open until `/stt-live stop`, which
  consumes audio even in silence.

## Origin and attribution

This project is a fork, and it evolves that fork.

- **Started from:** [`pi-voice-realtime`](https://github.com/IgorGuariroba/pi-voice-realtime),
  an MIT-licensed Pi extension by **[@IgorGuariroba](https://github.com/IgorGuariroba)**.
- **Credit:** the original implementation, the Codex `/voice` parity design, the
  realtime/transport/audio architecture, the ADRs in [docs/adr/](docs/adr/), and
  the test suite come from upstream. Thank you, Igor.
- **Upstream license:** MIT, copyright (c) 2026 Igor Guariroba. The
  [LICENSE](LICENSE) file is kept as in upstream.

Changes in this fork build on top of that work. The upstream README and ADRs
remain the source of truth for the design and provenance.
