# ADR 0001 - The pi session is the only head of the voice conversation

**Status:** Superseded by ADR 0002 (parity with the Codex `/voice`). Kept as history.

## Context

`/stt-live` used a realtime model with its own instructions. It answered on its own, and it did not see the pi session. Result: lost context ("fix that" with no referent), answers that diverged from the agent, and speech outside the history.

## Decision

- The pi session holds the context, the decisions, and the execution.
- Voice only carries: it transcribes the input, and it synthesizes the output from text given by pi.
- All consolidated speech enters the session as a voice message (`steer` when a run is in progress).
- pi generates the spoken summary together with the visual answer.
- Pending decisions stay in the terminal; voice only warns.

## Consequences

- Latency per turn goes up: every utterance goes through the agent. Measure before optimizing.
- The "mouth only" boundary cannot depend on a prompt alone. Keep transcription and synthesis as separate services, or make the integration control when the realtime model emits audio and what content it speaks.
- Record in the history which answers were already spoken as audio.

## Alternatives considered

- **Voice with its own brain** (current state): fast in simple conversation, but it diverges from the agent. Rejected.
- **Voice for dictation only** (transcribe and type): no spoken answers. Rejected, because it does not serve the intended use.

## Success criterion

Switching between speaking and typing keeps the same conversation and the same decisions. After "fix that", the session has the referent and the instruction, and it knows which answer was already spoken.
