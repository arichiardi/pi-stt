# ADR 0003 - Why we forked pi-voice-realtime

**Status:** accepted.

## Context

`pi-voice-realtime` is an MIT-licensed Pi extension by @IgorGuariroba. It gives
Pi a full-duplex realtime voice session and the delegation handoff. We wanted
three things it does not provide:

1. A published package under the `@ar-llm` npm scope, with the standard agent
   config layout (`$PI_CODING_AGENT_DIR/ar-llm/*.json`).
2. Client-side VAD, so the extension works against self-hosted `/v1/realtime`
   servers (for example llama.cpp) that report `turn_detection: null`.
3. A path to transcription agent tools (audio file, voice note) outside a live
   session.

Forking, not contributing upstream, keeps the `@ar-llm` packaging and the extra
roadmap independent of the upstream release cycle.

## Decision

- Keep `pi-voice-realtime` as the upstream base. Preserve the MIT LICENSE and the
  attribution in the README "Origin and attribution" section.
- Ship under `@ar-llm/pi-stt`.
- Adopt the agent config path used by the other `@ar-llm` packages.
- Add client-side VAD and, later, transcription tools on top of the upstream core.

## Consequences

- Positive: independent packaging, config convention, and roadmap.
- Negative: we carry a fork. Upstream fixes must be merged by hand.
- The upstream README and ADRs stay the source of truth for the design and
  provenance of the shared code.
