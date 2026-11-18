# Glossary - /stt-live

**Realtime session**: the connection to the voice model (`/v1/realtime`, realtime V2 protocol). It speaks, it listens, and it decides when to delegate.

**Voice model**: the realtime model. It talks to the user, and for any work it calls `background_agent`. It does not run code tools.

**Agent**: a normal pi turn, with the same tools, sandbox, and permissions as the session.

**background_agent**: a voice model tool that sends the user request to the agent without rewriting it. When idle, it starts a task. When busy, it steers.

**remain_silent**: a voice model tool for not speaking (for example, after control messages).

**Handoff**: one `background_agent` call, from the start to the end of the agent run.

**Steer**: a new instruction sent to a running task. The original call runs to the end. The new call gets only the ack.

**Delegation envelope**: `<realtime_delegation><input>…</input></realtime_delegation>`, the text the agent receives as a turn.

**[BACKEND]**: prefix on a voice model item with agent progress or the agent result. The model reads it as a user message, and the prefix makes it easy to tell apart.

**[USER]**: prefix on consolidated speech in the agent history. It enters the context without triggering a turn.

**Startup context**: recent turns from the pi branch and the working directory, sent as session instructions (budget of 5,300 tokens).

**response.create queue**: at most one model response at a time; a request during an active response waits for `response.done`.

**Truncate**: `conversation.item.truncate` sent on barge-in, with the audio time already played.

**Voice owner**: the pi session where `/stt-live` started. It does not follow focus changes.

**Client VAD**: client-side speech detection that decides the turn boundary when the server reports `turn_detection: null` (llama.cpp). Off by default; OpenAI keeps the server VAD.

**VAD engine**: `webrtc_fvad` (WebRTC VAD/libfvad, WASM, the Android algorithm), `rms` (the fallback in pure TS), `off` (server VAD).

**SpeechGate**: the state machine that takes 20 ms frames and emits `speechStarted` and `speechEnded`. It uses hysteresis (onset/hangover) and pre-roll.

**Commit point**: the moment when silence reaches `hangoverMs`. At that moment the client sends `input_audio_buffer.commit`.

**Pre-roll (prefill)**: the pre-audio kept so the first syllable of a turn is not lost.

**Fail-open**: if the VAD engine fails, the gate forwards all audio and warns once, so the microphone does not freeze.

*Obsolete*: "ear", "mouth", "transcription as input only", "voice synthesis", "spoken summary" (ADR 0001).
