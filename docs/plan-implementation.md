# Plan - client-side VAD (`/stt-live`)

**Goal:** Add client-side VAD to `pi-stt` for self-hosted servers without server-side VAD (llama.cpp `/v1/realtime`, which reports `turn_detection: null`).

**Non-goals:** Do not replace OpenAI server-side VAD (it stays the default). Do not touch the Linux AEC. Do not build a server. Do not build Silero (neural network, heavy).

---

## Why libfvad WASM

| Option | Pros | Cons |
|---|---|---|
| **`@ozymandiasthegreat/vad`** (libfvad, WebRTC VAD GMM, WASM) | Same VAD class as mobile/Android apps; ~53 KB; WASM for Node and browser; TypeScript included; no model download; maintained by OpenAI; ready-frame API | It is WebRTC VAD, not Silero; needs 8/16/32/48 kHz; WASM under jiti needs a tested loader |
| Silero (neural) | Better in noise | Large model, ~45 KB JS + WASM; heavy for the hot path; overkill |
| Pure RMS | Zero deps, light | Poor on background noise and non-continuous speech |

Choice: **libfvad WASM as the main engine, pure RMS as the backup**, with a warning ("fail to WASM → RMS"). Light, mobile standard, no model. The upstream `earendil-works/pi-voice` uses exactly this package.

Note: the package **does not publish `.wasm` in the tarball**. The WASM is a base64 string inside the bundle (`.cjs`/`.mjs`), auto-initialized. `npm install` already brings everything.

**Brew:** `libfvad` is not in Homebrew (it is not a formula). It is not needed: the WASM ships in the npm package. `brew install webrtc-audio-processing` exists, but it is the full C++ library (overkill). The Linux AEC uses the PulseAudio module, not brew.

---

## Design decisions

### 1. Code location - `src/audio/vad.ts` (new module)

It lives next to the existing `src/audio.ts` (same directory). Imports use an explicit `.ts` extension (`ar-llm` rule, loads through jiti).

Contents:
- `SpeechGate` - the gate: onset, hangover, prefill, events.
- `RmsScorer` - ported from `better-pi-voice` (adaptive noise floor, dual start/stop threshold).
- `WebRtcScorer` - wraps the `VAD` instance (libfvad), `AGGRESSIVE` mode by default.
- `loadVad()` - loads the package with fallbacks (see below).
- Types: `VadEngine`, `VadSettings`, `GateEvent`, `Scorer`.

### 2. `SpeechGate` contract

- `constructor(settings: VadSettings, deps: { createScorer })`
- `push(captureFrame: Buffer): { frames: Buffer[]; events: GateEvent[] }`
- `reset(): void` - clears prefill and counters (used on mute/teardown)
- `get phase(): "silent" | "speaking"`
- Events: `{ type: "speechStarted" }`, `{ type: "speechEnded" }`

### 3. Resampling 24 kHz → 16 kHz (inside the gate)

- The gate takes 24 kHz capture frames (480 samples / 960 bytes / 20 ms).
- Resample by 2:3 linear decimation → 320 samples / 16 kHz, with a continuous phase tail across frames (`createResampler16`).
- Split into two 10 ms sub-frames (160 samples), and score each one.
- Frame label = **any sub-frame with speech** (more responsive at onset).
- The resampler keeps state; `reset()` re-creates it.

### 4. Gate state (hysteresis + pre-audio)

Constants (ms) in `VadSettings` with defaults:

| Field | Default | Function |
|---|---|---|
| `onsetMs` | 60 | Continuous speech over N frames (3×20 ms) opens the turn |
| `hangoverMs` | 700 | Continuous silence closes the turn (**commit point**) |
| `prefillMs` | 450 | Pre-audio kept so the first syllable is not lost |
| `commitResponse` | true | Emit `response.create` after `commit` |

Algorithm (20 ms capture frames):

```
state = "silent"; onset = 0; hangover = 0; prefill = ring(N frames)
push(frame):
  label = score(label24(frame))        # true when the frame has speech
  if state == silent:
    onset = label ? onset + 1 : 0
    if onset*20ms >= onsetMs:
      state = "speaking"; hangover = 0
      return { frames: prefill.drain() + [frame], events: [speechStarted] }
    return { frames: [], events: [] }   # swallowed
  if state == speaking:
    if label: hangover = 0; return { frames: [frame], events: [] }
    hangover++;
    if hangover*20ms >= hangoverMs:
      state = "silent"; onset = 0
      return { frames: [], events: [speechEnded] }
    return { frames: [frame], events: [] }
```

- The pre-roll (ring of N frames) keeps the last silence frames. When the gate opens, it returns pre-roll + speech frames, so no word is lost.
- `speechEnded` fires **once** (speaking→silent transition).

### 5. Engine fallback (fail-open)

- If `loadVad()` throws, `createScorer()` falls back to `RmsScorer` with **one warning** (`onWarn`), and `phase` keeps working.
- If the **scorer throws** inside `push()`, the gate goes **fail-open**: it forwards all audio, keeps an implied running `speechStarted` (no events), and warns once. It never freezes the microphone.

---

## Session contract (`realtime.ts`)

- `buildSessionUpdate()`: when `vad.engine !== "off"`, set `audio.input.turn_detection` to **`null`** (do not send `server_vad`). Otherwise keep `server_vad` as today.
- `commit(): void` → sends `input_audio_buffer.commit` (state-gated `ready`), same as `appendAudio`.
- `commitAndRespond(): void` → calls `commit()`, then `createResponse()` when `commitResponse`.
- **Barge-in:** with `turn_detection: null`, the server **does not** send `input_audio_buffer.speech_started`. The local gate triggers barge-in.

---

## Wiring (`index.ts`)

- `VoiceDeps` gains `createGate` (injectable, mirroring `createRecorder`).
- `start()` builds the gate from `settings.vad`.
- `onFrame`:
  ```
  const { frames, events } = gate.push(frame)
  for (f of frames) current.appendAudio(f)   # whole frames, byte-identical
  micSum += rmsLevel(frame); micCount++; micLastAt = Date.now()  # meter sees EVERYTHING
  for (e of events) onGateEvent(e, current, ctx)
  ```
- `onGateEvent`:
  - `speechStarted` → **local** barge-in (reuses the current `input_audio_buffer.speech_started` code): `player.stop()` **only when not muted**, clear the queue, set `playhead` to zero, `setStatus`.
  - `speechEnded` → `current.commitAndRespond()`.
- `toggleMute` / `teardown` → `gate.reset()` (drops the pre-mute pre-roll).
- `/stt-live status` adds a line: `vad: <engine> · <wasm status> · gate: <state>`.

---

## Config (`config.ts`)

```ts
export type VadEngine = "webrtc_fvad" | "rms" | "off";   // default: off
export type VadMode = "normal" | "low_bitrate" | "aggressive" | "very_aggressive";
export interface VadSettings { engine; mode; onsetMs; hangoverMs; prefillMs; commitResponse; }
export interface VoiceSettings { ...; vad: VadSettings; }
```
`loadSettings()` merges the nested `{ vad: {...} }` with defaults, and clamps `onsetMs/hangoverMs/prefillMs` to safe ranges.

---

## WASM loader under jiti

`src/socket.ts` sets the pattern: `createRequire` over `[process.argv[1], process.execPath]`. Strategies, in order, with fallback:
1. `await import("@ozymandiasthegreat/vad")`
2. `createRequire(argv[1])` → same
3. `createRequire(execPath)` → same

Wrap each step in try/catch; the last failure triggers the RMS fallback plus a warning. **Test on Node first** (any platform; the loader has no audio dependency). The WASM does not publish `.wasm` in the tarball; it is base64 in the bundle, so there is no file path resolution.

---

## Tests

### Unit - `test/vad.test.ts` (synthetic frames, no microphone)
1. Onset: 1 speech frame does not open the gate; 3 frames do.
2. A single click (1 frame between silences) never opens the gate.
3. Hangover: a 300 ms pause with `hangoverMs=700` keeps the gate open; 700+ ms closes it.
4. Pre-audio + contiguity: concatenating the outputs == the input concatenation up to `speechEnded` (no word lost).
5. `speechEnded` fires exactly once per turn.
6. Two turns in one gate: open, close, open.
7. `reset()` mid-turn clears pre-roll and state.
8. fail-open: a scorer that throws → forwards everything, warns once.
9. `RmsScorer`: calibration, dual threshold, speech vs silence.
10. Loader: inject a factory that throws → returns `RmsScorer` + warning.
11. `engine: "off"` → gate bypassed, byte-identical stream, zero events.

### Integration - `test/integration.test.ts`
12. Bell + silence through a fake mic: appends, then commit, then `response.create`, in that order.
13. `engine: "off"` → behaviour identical to today (regression).
14. Gate `speechStarted` → `player.stop()` (barge-in).
15. Muted mic: nothing forwarded, no commit.
16. Fallback path: injected loader fails → session stays alive, warning, audio flows.

### Session - `test/realtime-session.test.ts`
17. `commit()` sends commit only when `ready`.
18. `turn_detection: null` when `vad.engine != off`.
19. Order `commit` → `response.create`.

---

## Integrity contracts

- **Contiguity:** `Buffer.concat(out) === Buffer.concat(input.slice(0, end))`. No duplicated or missing samples (pre-roll + onset + speaking meet with no gap).
- **No-commit-after-end:** send nothing after `speechEnded`.
- **speechEnded uniqueness** per turn.
- **Byte-identity:** the gate forwards whole frames, never resampled ones.

---

## Files

**New:** `src/audio/vad.ts`, `test/vad.test.ts`, this plan.
**Modified:** `package.json` (dep), `src/config.ts` (`VadSettings` + merge + clamps), `src/realtime.ts` (`commit`, `turn_detection` null, barge-in), `src/index.ts` (`createGate`, `onFrame`, `onGateEvent`, mute/teardown reset, status), `README.md` (VAD section + macOS/brew note), `CHANGELOG.md`, `glossary.md`, tests.

---

## Phases

- **F1 - Plan** (this doc). ✔
- **F2 - Gate core** (`src/audio/vad.ts`: `SpeechGate` + `RmsScorer`, full gate, resampler, ring, events, `reset`) + tests 1-9. ✔
- **F3 - libfvad scorer** (`WebRtcScorer` + `loadVad` + loader + dep) + test 10. ✔
- **F4 - Session contract** (`commit`, `turn_detection`, order) + tests 17-19. ✔
- **F5 - Wiring** (`index.ts`: gate, local barge-in, mute/teardown reset, status) + tests 12-16, 11. ✔
- **F6 - Config + docs** (`config.ts` merge/clamps, README, CHANGELOG, GLOSSARY). ✔
- **F7 - On-device validation** (Linux + llama.cpp; real AEC + acoustics).

---

## Risks

| Risk | Mitigation |
|---|---|
| WASM does not load under jiti | `createRequire` fallback + RMS + warning; test Node first |
| Double turn boundaries (server + client) | `turn_detection: null` when a client engine is active |
| Audio lost at the start | Pre-roll (450 ms ring) drains at onset |
| Early close (pauses) | Hangover + RMS dual threshold |
| Barge-in breaks without `speech_started` | Local barge-in in the gate; reuses the truncate |
| Scorer CPU on the hot path | libfvad is cheap; 10 ms sub-frame; sync scorer |
| Unmute plays pre-mute audio | `gate.reset()` on mute |

---

## On-device validation

Rules from `README.md` / `docs/plan-implementation.md`: production validation
needs a Node platform for the code path (macOS is fine) + Linux for capture. The
code-side phases are cross-platform: Node, no microphone, no real-time server.
The WASM scorer loads in Node on macOS and Linux. Capture with AEC
(`parec`/`pacat` + `module-echo-cancel`) is Linux, so only F7 needs Linux.

- **F2-F3 (code side, any Node):** ✔ Verified that `loadVad()` + `createScorer("webrtc_fvad")` return `WebRtcScorer` (no fallback), that `processBuffer` runs (silence → `SILENCE`, transitions to `VOICE`, zero `ERROR`), and that `dispose()` releases resources. Acoustic `VOICE` triggering **cannot** be validated with stationary synthetic signals (WebRTC VAD suppresses stationary tones and noise; it needs real speech transients).
- **F7 (Linux + llama.cpp):** `VOICE` triggering with real speech, commit point, barge-in, and acoustics. Pending.
