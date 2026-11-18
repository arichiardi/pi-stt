# Changelog

All notable changes to this project are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Realtime voice sessions over `/v1/realtime` (OpenAI Realtime), the `/stt-live` mode.
- Client-side VAD for self-hosted `/v1/realtime` servers (llama.cpp, `turn_detection: null`).
  Engines: `webrtc_fvad` (libfvad WASM), `rms` fallback, `off` (server VAD). Tunable
  `onsetMs`/`hangoverMs`/`prefillMs` and `commitResponse`. Fail-open on scorer failure.

### Planned
- Transcription agent tools (audio file / voice note transcription on demand).

### Changed
- Command `/voice` → `/stt-live` (links to the `pi-stt` package, conveys realtime).
  Subcommands unchanged: `start`, `stop`, `mute`, `unmute`, `settings`, `status`.

## [0.1.0] - 2026-11-18

Initial release of this fork.

### Notes
- Started from a fork of [`pi-voice-realtime`](https://github.com/IgorGuariroba/pi-voice-realtime)
  by [@IgorGuariroba](https://github.com/IgorGuariroba) (MIT).
- Renamed the package to `@ar-llm/pi-stt` and broadened the scope to speech-to-text.
