# ADR 0004 - Current implementation over /v1/realtime

**Status:** accepted. Builds on ADR 0002.

## Context

ADR 0002 recorded the design we adopted: a realtime voice session that answers
by voice and delegates work to a Pi agent. This ADR records the shape of the
current code, so the implementation is documented on its own terms.

## Decision

The current implementation is:

- **Endpoint:** OpenAI Realtime `/v1/realtime`. The model goes in the URL query.
- **Auth:** API key (`OPENAI_API_KEY` → `PI_VOICE_API_KEY` → the `openai` entry
  in `<agentDir>/auth.json`). No ChatGPT `intent=quicksilver`.
- **Transport:** WebSocket PCM16. `ws` is loaded from the Pi `node_modules` with
  `createRequire(process.argv[1])`. If that fails, fall back to the Node global
  `WebSocket` and swap the key for an ephemeral client secret in a subprotocol.
- **Payload:** GA `session.update` only. The beta dialect is removed.
- **Audio:** PCM16LE mono 24 kHz, 20 ms frames. AEC via PulseAudio/PipeWire
  `module-echo-cancel`. Linux is required for the AEC path.
- **Turn detection:** server VAD by default (`vad.engine: off`). When a client
  engine is active, send `turn_detection: null` and drive the boundary in the
  client. Engines: `webrtc_fvad` (libfvad WASM), `rms` fallback, `off`.
- **Delegation:** tools `background_agent` and `remain_silent`. A work request
  becomes a Pi turn `<realtime_delegation><input>...</input></realtime_delegation>`.
  Progress and result return as `[BACKEND]`, then `function_call_output`.
- **Barge-in:** on `input_audio_buffer.speech_started`, send
  `conversation.item.truncate` for the audio already played.
- **Response queue:** one spoken response at a time. A `response.create` during an
  active response is queued and sent on `response.done`.
- **Config:** `$PI_CODING_AGENT_DIR/ar-llm/stt.json`.

## Consequences

- Positive: runs on the public API with a plain key; works against self-hosted
  servers through client VAD.
- Negative: the AEC path is Linux-only. Acoustic parity of echo cancellation is
  not measured. No reconnect: a socket drop ends the session.
