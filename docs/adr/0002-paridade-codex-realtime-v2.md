# ADR 0002 - Parity with the Codex `/voice` (realtime V2, two agents)

**Status:** proposed. Replaces ADR 0001.
**Reference:** `codex-rs` at `/home/movida/projetos/codex` (commit `c419fd01a7`).

## Context

ADR 0001 made the voice model only an ear and a mouth. It did not answer, and it did not delegate. Spoken output was text-to-speech of pi text. That choice diverged from Codex, which is the adopted reference. The rule for this ADR: Codex decisions win, unless they are incompatible with pi or with the language (Node/TypeScript).

## Decision

Replicate the Codex **V2** realtime session (default `RealtimeConversationVersion::V2`), over a WebSocket transport.

### 1. Realtime session (`session.update`)

Source: `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`.

- `output_modalities: ["audio"]`.
- Input: PCM 24 kHz, `noise_reduction: near_field`, transcription `gpt-4o-mini-transcribe`.
- `server_vad` VAD with `interrupt_response: true`, **`create_response: true`**, `silence_duration_ms: 500`.
- `tool_choice: "auto"`.
- V2 default voice: `marin` (`protocol/src/protocol.rs:408`).
- Default model: `gpt-realtime-1.5` (`core/src/realtime_conversation.rs:112`).

**Diverges from current state:** drop `create_response: false` and the "ear only" instructions.

### 2. Instructions

- `instructions` = `backend_prompt.md` (identity, "delegate everything" policy, `[USER]`/`[BACKEND]` prefixes) + startup context (`realtime_context.rs`, 5,300 token budget).
- On start, send a developer message with `realtime_start.md` ("Realtime conversation started…"). On end, send `realtime_end.md`.
- The prompt states explicitly that work goes through the backend and is never refused. All delegation policy comes from there, not from code.

### 3. Tools

| Codex | Function |
|---|---|
| `background_agent(prompt)` | Default action. Send the user's speech to the agent, with no rewrite. Start a task when idle; *steer* when busy. |
| `remain_silent()` | Do not speak after control messages or silent updates. |

Replaces `delegate_to_pi`.

### 4. Handoff cycle (V2)

Source: `realtime_conversation.rs` (`handle_handoff_output`, `RealtimeEventParser::RealtimeV2`).

- **Start:** `background_agent` takes the turn with `<realtime_delegation><input>…</input><transcript_delta>…</transcript_delta></realtime_delegation>`. The `transcript_delta` holds the turns since the last handoff.
- **Progress:** send each agent output as a `user` item with the `[BACKEND] ` prefix.
- **Finish:** `function_call_output` with `"Background agent finished. Use the preceding [BACKEND] messages as the result."`, then `response.create`.
- **Steer (agent busy):** the new call gets `function_call_output` `"This was sent to steer the previous background agent task."` and `response.create`.
- **`response.create` queue:** only one active response at a time (`RealtimeResponseCreateQueue`).
- **Do not speak the reasoning:** only the final answer is spoken; commentary channels come from the BEM (see gaps).

**Diverges from current state:** today the response becomes `[BACKEND] Agent Final Message` with no `function_call_output`. Without the call output, the API does not close the tool cycle.

### 5. Barge-in

Codex: on `input_audio_buffer.speech_started`, send `conversation.item.truncate` with the `audio_end_ms` of what already played (`ResponseCancelled`/`OutputAudioState`). Do not use only `response.cancel` plus a local cut.

### 6. Persistence and history

- Codex writes `RealtimeItem` to the rollout: `RealtimeSessionStarted`, `TranscriptSegment{role,text}`, `BemItemPromoted`, `RealtimeSessionClosed{outcome}` (`protocol/src/realtime.rs`).
- Speech transcription is also recorded in the **model history** (`realtime_history.rs`, `transcript_tail.rs`). This diverges from the current README ("outside the context"), which is now revoked.
- At session end, send the unconsumed transcript tail to Codex as a `<realtime_delegation>` with `<source>transcript_tail_flush</source>`.

### 7. Size limits

Codex truncates: 4 KiB per delegation field; 1,000 tokens of agent output; 8,192 tokens for initial items; 128 items. Adopt the same values.

## Gaps and how to close them

| # | Gap | Codex source | Closure |
|---|---|---|---|
| L1 | Model does not answer (`create_response: false`) | `methods_v2.rs` | Set it to `true`; policy in the prompt. |
| L2 | "Ear" instructions | `prompts/templates/realtime/*.md` | Use `backend_prompt.md` and `realtime_start.md`. |
| L3 | Tool `delegate_to_pi` | `background_agent`, `remain_silent` | Rename it; add `remain_silent`. |
| L4 | No `function_call_output` / `response.create` | `handle_handoff_output` | Send them in the three cases (finish, steer, silence). |
| L5 | No `response.create` queue | `RealtimeResponseCreateQueue` | Port the queue. |
| L6 | Barge-in without truncate | `OutputAudioState` | Track `item_id` and `audio_end_ms`. |
| L7 | Transcription outside the model context | `realtime_history.rs` | Record it in pi history and in the context. |
| L8 | No transcript tail flush | `transcript_tail.rs` | Send the rest at session end. |
| L9 | No startup context | `realtime_context.rs` | Build it: recent session turns + cwd. |
| L10 | No commentary/BEM | `bem.rs` | Make the FinalAnswer phase required; do not speak commentary. |
| L11 | No reconnect | `tui/src/app/reconnect.rs` | Port it after the basic flow. |
| L12 | No steer in an active task | `REALTIME_V2_STEER_ACKNOWLEDGEMENT` | `deliverAs: steer` + ack. |
| L13 | Default model `gpt-realtime` | `realtime_conversation.rs:112` | Switch to `gpt-realtime-1.5`. |

## Justified deviations (pi / language)

- **WebSocket transport, not WebRTC.** Codex supports `transport = "websocket"` (`config_toml.rs`). Node has no native WebRTC with Opus/AEC equivalent to the `voice-host` helper. Revisit this if the acoustic measurement fails.
- **Capture and AEC through PipeWire** (`parec`/`pacat` + `module-echo-cancel`), not `voice-host`. Linux only, as already stated.
- **No voice owner across threads.** pi has one active session per `/stt-live`; `background_voice` stays out of scope.
- **Persistence through `pi.appendEntry`** instead of the Codex rollout.

## Consequences

- The role of voice changes: the model talks and delegates. ADR 0001 is superseded, and the ongoing TTS/bridge work (`speech.ts`, `bridge.ts`, `docs/plano-implementacao.md`) is no longer the path.
- Latency for simple conversation drops. Risk: the model answers something that should go to the agent. The prompt policy is the control, and it must be tested.
- Changes `glossary.md` (terms: `background_agent`, handoff, steer, `[BACKEND]`).

## Success criteria

1. A coding request leaves as `background_agent` with `<realtime_delegation>`, and returns with `function_call_output` plus a spoken answer.
2. Speech during a running task produces `steer` with an ack, and does not cancel the task.
3. Interrupted speech cuts the audio and records `conversation.item.truncate`.
4. Transcription appears in pi history and in the model context.
5. Session end sends `transcript_tail_flush`.
