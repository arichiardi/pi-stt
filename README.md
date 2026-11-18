# pi-stt — speech-to-text for pi

Speech-to-text for the [Pi](https://pi.dev) coding agent. Today it gives you
full-duplex realtime voice, the same design as the `/voice` mode of
[openai/codex](https://github.com/openai/codex). Over time it will also add
transcription agent tools (audio files, voice notes) so Pi can transcribe on
demand, not only in a live session.

> **Origin and credit.** This project started as a fork of
> [`pi-voice-realtime`](https://github.com/IgorGuariroba/pi-voice-realtime) and
> is evolving it. All credit for the original code, the Codex `/voice` parity
> work, and the realtime architecture goes to **[@IgorGuariroba](https://github.com/IgorGuariroba)**.
> It is MIT licensed. See [Origin and attribution](#origin-and-attribution).

```
/voice
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
- **Later:** transcription agent tools — transcribe a file, a voice note, or a
  meeting on demand, outside a live session.

## Demo

[![Voice conversation in Pi, with transcript and audio meters](https://raw.githubusercontent.com/IgorGuariroba/pi-voice-realtime/main/docs/media/preview.png)](https://raw.githubusercontent.com/IgorGuariroba/pi-voice-realtime/main/docs/media/demo.mp4)

[Watch the demo (MP4, 20 seconds, no audio)](https://raw.githubusercontent.com/IgorGuariroba/pi-voice-realtime/main/docs/media/demo.mp4).

## Install

Requirements:

- Linux with PulseAudio/PipeWire, `pactl`, `parec`, `pacat`, and
  `module-echo-cancel` with WebRTC AEC.
- An OpenAI credential with access to the Realtime API.

```bash
pi install npm:@ar-llm/pi-stt
```

Restart Pi or run `/reload`, then run `/voice`.
To update an existing npm install, run `pi update --extensions`.

## Usage

| Command / key | Effect |
|---|---|
| `/voice` or `/voice start` | start the session (idempotent) |
| `/voice stop` | end the session and release mic/player |
| `/voice mute` / `unmute` | microphone (does not affect playback) |
| `f9` | toggle mute |
| `/voice settings` | choose the voice; ↑↓ plays a preview (sample is generated once and cached in `~/.pi/agent/voice/previews/`) (applies to the next session) |
| `/voice status` | state, voice, model, credential, devices |

UI: a widget above the editor (`voice ● listening` / `mic ▁ ▂ ▄ ▆ █ ▅ ▃ ▂ ▁ ▁` /
`f9 mute` / `/voice stop`) plus a line in the native footer, which keeps showing
tokens/git/model. Consolidated speech appears in history and enters the agent
context as a `[USER]` message without triggering a turn (`sendMessage` without
`triggerTurn`), the same way Codex records a `TranscriptSegment`.

## Credential

The normal path is Pi's own login. The extension reads the same credential:

```
/login openai
/voice status   # credential: ok
```

Precedence: `OPENAI_API_KEY` → `PI_VOICE_API_KEY` → the `openai` entry in
`~/.pi/agent/auth.json` (where `/login openai` writes). The environment
variables are for temporary use or CI.

## Configuration

`~/.pi/agent/voice.json` (created when you choose a voice in `/voice settings`):

```json
{ "voice": "marin", "model": "gpt-realtime-2.1-mini", "muteOnStart": false }
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
backend-selection functions remain in `audio.ts`, but `/voice` does not use them.

This backend uses WebRTC AEC from the audio server. It is not the same Sonora
helper as Codex. Creating the routes does not prove echo reduction. Acoustic
measurement and speaker validation are still pending.

## Codex fidelity (what differs, and why)

| Codex | Here | Reason |
|---|---|---|
| `/v1/realtime?intent=quicksilver` + ChatGPT auth | `/v1/realtime` + API key | `intent=quicksilver` is not public |
| transport auth | `ws` + `Authorization` | GA does not send `OpenAI-Beta`; see below |
| WebRTC (SDP/ICE) | WebSocket PCM16 | same model and same VAD; avoids native `wrtc` |
| Rust helper + Sonora AEC + GStreamer + Opus | PulseAudio/PipeWire WebRTC AEC + `parec`/`pacat` | Linux backend, no proven acoustic parity |
| V2 handoff (`background_agent`, `remain_silent`) | same tools, same return texts | parity (ADR 0002) |
| `codex-realtime-webrtc` module | `socket.ts` + `realtime.ts` + `audio.ts` | — |

### Transport

`import("ws")` fails from the extension directory, but
`createRequire(process.argv[1])("ws")` works: `process.argv[1]` is the Pi
entrypoint, which owns the `node_modules` where `ws` lives. This makes the
transport match Codex (headers). If that resolution fails (running outside Pi),
the extension falls back to Node's global `WebSocket`, which **does not** accept
headers, and then swaps the API key for an ephemeral client secret in a
subprotocol. The active mode shows in `/voice status`:
`transport: ws|global-websocket · auth: header|ephemeral-subprotocol`.

### Payload dialect

Only the GA format (Codex V2 `session.update`). The beta dialect was removed: V2
does not use it. `session.update` errors are reported, with no resubmit in a
different format.

### OpenRouter does not serve realtime mode

OpenRouter offers `/api/v1/audio/speech` (TTS), `/api/v1/audio/transcriptions`
(STT), and `gpt-audio` via `/chat/completions`, but it **does not** expose a
duplex session endpoint (`/v1/realtime`). Without it there is no continuous VAD,
barge-in, or streamed spoken answer. Using OpenRouter would require a different
mode (record → transcribe → agent → TTS), which is out of v1 scope.

What is faithful to Codex V2: spoken answer from the model itself, delegation as
`background_agent` with a `<realtime_delegation>` envelope, progress and result
as `[BACKEND]`, `function_call_output` on completion and on steer, a one-at-a-time
`response.create` queue, barge-in with `conversation.item.truncate`, speech in
the agent history, and `remain_silent`.

## Tests

```bash
node --test --experimental-strip-types tests/*.test.ts
```

The suite also covers realtime session lifecycle, the GA handshake, and AEC
route ownership (creation commands, pair usage, idempotent unload). These tests
do not measure canceler acoustic performance.

Offline coverage: GA event parser with a fixture, V2 `session.update` payload
(VAD, tools, instructions), delegation envelope, `response.create` queue,
truncate on barge-in, handoff cycle with a fake socket
(`tests/integration.test.ts`), startup context, and PCM framing.

## Validation status

Proven: the offline tests above, real conversation with transcript and spoken
answer in Pi, and visual meter validation. Real capture through the AEC path
delivered blocks every 27–32 ms after startup, with the buffer set to 30 ms.

Still pending specific E2E validation: acoustic quality of echo cancellation,
barge-in against the server, and the full delegation cycle
speech → agent task → spoken answer.

## Known limits

- Device picker and persistent captions are deferred to v2 (scope decision).
- No reconnect phase: a WebSocket drop ends the session (Codex: `reconnect.rs`).
- No transcript-tail-flush with a turn: speech goes to history immediately, so no
  buffer remains at close.
- Without an OpenAI key, `/voice` warns and opens no session — there is no local
  fallback.
- The session keeps the microphone open until `/voice stop` (like Codex), which
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
remain the source of truth for the Codex-parity design.
