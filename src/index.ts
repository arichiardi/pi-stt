/**
 * /stt-live - voice conversation mode, mirroring the Codex CLI /voice.
 *
 * Flow:
 *   /stt-live  → opens a full-duplex realtime session (mic open, server VAD).
 *   You speak → the voice model replies and, for any work, calls
 *   `background_agent` (ADR 0002). The request becomes a normal pi turn:
 *   `<realtime_delegation><input>…</input></realtime_delegation>`.
 *   Progress and result return as `[BACKEND] …`, then
 *   `function_call_output` and a spoken reply.
 *
 * Commands: /stt-live [start|stop|mute|unmute|settings|status]
 *           /stt-provider - switch the active profile.
 * Shortcut: f9 - mute/unmute the microphone.
 *
 * Supports multiple providers: openai, llama.cpp, and any models.json entry
 * that exposes /v1/realtime.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text } from "@earendil-works/pi-tui";
import type { ChildProcess } from "node:child_process";
import { BYTES_PER_SAMPLE, Player, Recorder, rmsLevel } from "./audio.ts";
import { SAMPLE_RATE, type VadEngine, type VadMode } from "./config.ts";
import {
	SpeechGate,
	createScorer as loadScorer,
	type FrameScorer,
	type GateEvent,
	type SpeechGateOptions,
} from "./audio/vad.ts";
import { ensurePreview, playPreviewFile } from "./previews.ts";
import { openEchoAudio, EchoCleanup, type EchoAudio } from "./echo.ts";
import { VOICES, VAD_ENGINES, VAD_MODES, loadConfig, saveConfig, activeProvider, activeProviderName, resolveProvider, listAvailableProviders, normalizeVadEngine, type SttConfig, type SttEntry } from "./config.ts";
import {
	HANDOFF_COMPLETE_ACK,
	STEER_ACK,
	finalAnswerText,
	unwrapDelegation,
	wrapDelegation,
} from "./delegation.ts";
import { END_INSTRUCTIONS, START_INSTRUCTIONS, backendPrompt } from "./prompts.ts";
import { buildStartupContext } from "./startup-context.ts";
import { createVoiceWidget, statusText, type VoiceViewState } from "./footer.ts";
import { RealtimeSession, buildInstructions, type RealtimeSessionOptions, type VoiceEvent } from "./realtime.ts";

const WIDGET_KEY = "voice";
const STATUS_KEY = "voice";
const TRANSCRIPT_ENTRY = "voice-transcript";

/** External dependencies (socket, AEC, microphone, player). Injectable for tests. */
export interface VoiceDeps {
	openSocket?: RealtimeSessionOptions["openSocket"];
	openEcho: () => Promise<EchoAudio>;
	createPlayer: (...args: ConstructorParameters<typeof Player>) => Player;
	createRecorder: (...args: ConstructorParameters<typeof Recorder>) => Recorder;
	/** Build the VAD scorer. Injectable; the default loads libfvad (WASM). */
	createScorer: (engine: VadEngine, mode: VadMode, onWarn: (message: string) => void) => Promise<FrameScorer | null>;
	/** Build the gate. Injectable; the default uses `SpeechGate`. */
	createGate: (options: SpeechGateOptions) => SpeechGate;
}

const DEFAULT_DEPS: VoiceDeps = {
	openEcho: () => openEchoAudio(),
	createPlayer: (backend, onError) => new Player(backend, onError),
	createRecorder: (handlers) => new Recorder(handlers),
	createScorer: (engine, mode, onWarn) => loadScorer(engine, mode, onWarn),
	createGate: (options) => new SpeechGate(options),
};

export default function (pi: ExtensionAPI, overrides: Partial<VoiceDeps> = {}) {
	const deps: VoiceDeps = { ...DEFAULT_DEPS, ...overrides };
	let config: SttConfig = loadConfig();
	/** Provider name for the running session (key in the providers map). */
	let providerName = activeProviderName(config);
	/** Active entry (derived from config + providerName). */
	let settings: SttEntry = config.providers[providerName];
	/** Resolved provider info for the active session. */
	let resolvedBaseUrl = "";
	let resolvedSource = "";
	let session: RealtimeSession | undefined;
	let recorder: Recorder | undefined;
	let player: Player | undefined;
	/** VAD gate for the current session (null when the engine is off). */
	let gate: SpeechGate | undefined;
	/** Label for `/stt-live status`: `<engine> · <wasm status>`. */
	let vadLabel = "server";
	let echoAudio: EchoAudio | undefined;
	const echoCleanup = new EchoCleanup();
	let muted = false;
	let speaking = false;
	/** `background_agent` call in progress; the result is returned when the pi run ends. */
	let activeCall: string | undefined;
	/** A pi run is in progress (agent_start → agent_end). */
	let agentRunning = false;
	let view: VoiceViewState = { phase: "listening", speaking: false };
	/** Average microphone level since the last waveform sample. */
	// Mean RMS of the 20 ms frames received since the last waveform tick (30 ms).
	let micSum = 0;
	let micCount = 0;
	let micLast = 0;
	let micLastAt = 0;
	/** Agent audio segments, with the time they should play. */
	let outSchedule: Array<{ at: number; level: number }> = [];
	/** Time (ms epoch) when the already queued audio finishes playing. */
	let playhead = 0;
	let speakingTimer: ReturnType<typeof setTimeout> | undefined;
	// The widget animates on its own (60 ms timer calling tui.requestRender);
	// here we only update state. The footer updates through setStatus().
	const refresh = () => {};

	const setPhase = (phase: VoiceViewState["phase"]) => {
		view = { ...view, phase, speaking };
		refresh();
	};

	const active = () => Boolean(session);

	const caption = (text: string | undefined) => {
		view = { ...view, caption: text ? text.replace(/\s+/g, " ").slice(0, 120) : undefined };
		refresh();
	};

	const takeMicLevel = () => {
		// With a 30 ms tick and 20 ms frames, some ticks bring no new frame: keep the last level instead of zeroing (avoids flicker).
		if (micCount) micLast = micSum / micCount;
		micSum = 0;
		micCount = 0;
		// Tolerate ticks without a frame, but do not freeze the waveform if capture stops.
		return Date.now() - micLastAt < 150 ? micLast : 0;
	};

	/** Highest level among segments that should already be playing at `at`. */
	const outLevelAt = (at: number) => {
		let level = 0;
		while (outSchedule.length && outSchedule[0].at <= at) level = Math.max(level, outSchedule.shift()!.level);
		return level;
	};

	const scheduleOutput = (pcm: Buffer) => {
		const bytesPerMs = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;
		const segment = Math.floor(bytesPerMs * 60) & ~1;
		let at = Math.max(Date.now(), playhead);
		for (let off = 0; off < pcm.length; off += segment) {
			const chunk = pcm.subarray(off, Math.min(pcm.length, off + segment));
			outSchedule.push({ at, level: rmsLevel(chunk) });
			at += chunk.length / bytesPerMs;
		}
		playhead = at;
	};

	/** End "speaking" only after the queued audio finished playing locally. */
	const endSpeakingWhenPlayed = (ctx: ExtensionContext) => {
		if (speakingTimer) clearTimeout(speakingTimer);
		speakingTimer = setTimeout(() => {
			speakingTimer = undefined;
			speaking = false;
			outSchedule = [];
			view = {
				...view,
				phase: activeCall ? "working" : muted ? "muted" : "listening",
				speaking: false,
			};
			refresh();
			setStatus(ctx);
		}, Math.max(0, playhead - Date.now()) + 100);
	};

	const setStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, statusText(view, ctx.ui.theme));
	};

	/**
	 * Consolidated speech enters the pi history without triggering a turn (`sendMessage`
	 * without `triggerTurn`), written as a TranscriptSegment into the model context.
	 * The display uses the persisted entry next to it.
	 */
	function recordTranscript(role: "user" | "agent", text: string) {
		if (!text.trim()) return;
		pi.appendEntry(TRANSCRIPT_ENTRY, { role, text });
		caption(text);
		if (role === "user") {
			pi.sendMessage(
				{ customType: "voice-speech", content: `[USER] ${text.trim()}`, display: false },
				agentRunning ? { deliverAs: "nextTurn" } : undefined,
			);
		}
	}

	function teardown(reason: string | undefined, ctx: ExtensionContext) {
		session?.close();
		session = undefined;
		recorder?.stop();
		recorder = undefined;
		player?.dispose();
		player = undefined;
		gate?.dispose();
		gate = undefined;
		vadLabel = "server";
		const oldEcho = echoAudio;
		echoAudio = undefined;
		if (oldEcho) echoCleanup.add(oldEcho);
		void echoCleanup.flush().catch(() => ctx.ui.notify("failed to release AEC module; cleanup will be retried", "warning"));
		speaking = false;
		activeCall = undefined;
		if (speakingTimer) clearTimeout(speakingTimer);
		speakingTimer = undefined;
		outSchedule = [];
		playhead = 0;
		micSum = 0;
		micCount = 0;
		micLast = 0;
		micLastAt = 0;
		view = { phase: "listening", speaking: false };
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (reason) ctx.ui.notify(`voice session ended: ${reason}`, "warning");
	}

	function toggleMute(ctx: ExtensionContext) {
		if (!active()) return;
		muted = !muted;
		// Mute only affects capture: playback of the reply continues.
		recorder?.setMuted(muted);
		// Drop the pre-mute pre-roll so audio does not leak after unmute (R6).
		gate?.reset();
		micSum = 0;
		micCount = 0;
		micLast = 0;
		micLastAt = 0;
		view = { ...view, phase: muted ? "muted" : speaking ? "speaking" : "listening", speaking };
		refresh();
		setStatus(ctx);
		ctx.ui.notify(muted ? "microphone muted (f9)" : "microphone active (f9)", "info");
	}

	async function start(ctx: ExtensionContext) {
		if (active()) {
			ctx.ui.notify("voice session already active — /stt-live stop to end it", "info");
			return;
		}

		// Reload config to pick up any provider changes.
		config = loadConfig();
		providerName = activeProviderName(config);
		settings = config.providers[providerName];

		const resolved = resolveProvider(providerName);
		if (!resolved.apiKey) {
			ctx.ui.notify(
				`no credential for provider "${providerName}" (source: ${resolved.source})`,
				"error",
			);
			return;
		}
		if (!resolved.baseUrl) {
			ctx.ui.notify(
				`provider "${providerName}" has no baseUrl: add it in models.json`,
				"error",
			);
			return;
		}

		resolvedBaseUrl = resolved.baseUrl;
		resolvedSource = resolved.source;
		muted = settings.muteOnStart;
		view = { phase: "starting", speaking: false };
		micSum = 0;
		micCount = 0;
		micLast = 0;
		micLastAt = 0;
		outSchedule = [];
		playhead = 0;
		gate = undefined;
		vadLabel = "server";

		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, createVoiceWidget(() => ({ ...view, takeMicLevel, outLevelAt })), {
				placement: "aboveEditor",
			});
		}

		const onEvent = (event: VoiceEvent) => handleEvent(event, ctx);

		// Show "connecting" until the session is configured; open the mic only after.
		setStatus(ctx);

		// realtime_start goes in `instructions` (V2); the API rejects a `developer` item.
		// A provider `prompt` replaces the built-in persona; startup context is appended.
		const basePrompt = settings.prompt?.trim()
			? settings.prompt.trim()
			: `${backendPrompt(process.env.USER || process.env.USERNAME)}\n\n${START_INSTRUCTIONS}`;
		const instructions = buildInstructions(basePrompt, buildStartupContext(ctx.sessionManager.getBranch(), ctx.cwd));
		const current = new RealtimeSession({
			apiKey: resolved.apiKey,
			baseUrl: resolved.baseUrl,
			settings,
			instructions,
			openSocket: deps.openSocket,
			onEvent,
			onClose: (reason) => {
				if (session === current) teardown(reason, ctx);
			},
		});
		session = current;

		try {
			await current.connect();
		} catch (error) {
			if (session === current) {
				teardown(undefined, ctx);
				ctx.ui.notify(`failed to open voice: ${(error as Error).message}`, "error");
			}
			return;
		}
		// /stt-live stop (or a failure) during connect already ended this session.
		if (session !== current) return;

		try {
			const routes = await deps.openEcho();
			if (session !== current) {
				echoCleanup.add(routes);
				await echoCleanup.flush().catch(() => ctx.ui.notify("failed to release AEC from cancelled session", "warning"));
				return;
			}
			echoAudio = routes;
			player = deps.createPlayer(routes.playback, (error) => {
				if (session === current) teardown(`player: ${error.message}`, ctx);
			});
			// VAD gate: decides the turn boundary. Engine off => null scorer (pass-through).
			const scorer = await deps.createScorer(settings.vad.engine, settings.vad.mode, (message) => {
				if (session === current) ctx.ui.notify(message, "warning");
			});
			if (session !== current) return;
			gate = deps.createGate({
				scorer,
				onsetMs: settings.vad.onsetMs,
				hangoverMs: settings.vad.hangoverMs,
				prefillMs: settings.vad.prefillMs,
				onWarn: (message) => {
					if (session === current) ctx.ui.notify(message, "warning");
				},
			});
			vadLabel = scorer
				? `${settings.vad.engine} · ${scorer.kind === "fvad" ? "wasm" : "rms"}`
				: "server";
			recorder = deps.createRecorder({
				onFrame: (frame) => {
					if (session !== current) return;
					if (gate) {
						const { frames, events } = gate.push(frame);
						for (const f of frames) current.appendAudio(f);
						for (const e of events) onGateEvent(e, current, ctx);
					} else {
						current.appendAudio(frame);
					}
					// The meter sees every frame, so the waveform animates during silence.
					micSum += rmsLevel(frame);
					micCount++;
					micLastAt = Date.now();
				},
				onError: (error) => {
					ctx.ui.notify(`microphone: ${error.message}`, "error");
					if (session === current) teardown("microphone failure", ctx);
				},
			});
			recorder.setMuted(muted);
			recorder.start(routes.capture);
		} catch (error) {
			if (session !== current) return;
			teardown(`failed to start audio: ${(error as Error).message}`, ctx);
			return;
		}

		view = { ...view, phase: muted ? "muted" : "listening" };
		setStatus(ctx);
		ctx.ui.notify(
			muted
				? "Voice connected (muted). f9 unmute, /stt-live stop to end."
				: "Voice session started. f9 mute, /stt-live stop to end.",
			"info",
		);
	}

	function speak() {
		// Model audio arrives through `response.output_audio.delta`; here we only mark the state.
		speaking = true;
		view = { ...view, phase: "speaking", speaking: true };
		refresh();
	}

	/**
	 * Client-side VAD gate events. With `turn_detection: null` the server does not
	 * send `speech_started`; the gate does local barge-in and commits at the end.
	 */
	function onGateEvent(event: GateEvent, current: RealtimeSession, ctx: ExtensionContext) {
		if (event.type === "speechStarted") {
			speaking = false;
			if (speakingTimer) clearTimeout(speakingTimer);
			speakingTimer = undefined;
			outSchedule = [];
			playhead = 0;
			if (!muted) player?.stop();
			view = { ...view, phase: "listening", speaking: false };
			refresh();
		} else {
			current.commitAndRespond();
		}
		setStatus(ctx);
	}

	function handleEvent(event: VoiceEvent, ctx: ExtensionContext) {
		switch (event.kind) {
			case "ready":
				// Informational: `start()` only moves to "listening" after connect() resolves.
				break;

			case "audio":
				if (muted) break;
				player?.write(event.pcm);
				scheduleOutput(event.pcm);
				if (speakingTimer) {
					clearTimeout(speakingTimer);
					speakingTimer = undefined;
				}
				if (!speaking) speak();
				break;

			case "speech_started":
				// Barge-in: the server cancels the reply (interrupt_response); the session truncates the audio.
				speaking = false;
				if (speakingTimer) clearTimeout(speakingTimer);
				speakingTimer = undefined;
				outSchedule = [];
				playhead = 0;
				player?.stop();
				view = { ...view, phase: "listening", speaking: false };
				refresh();
				break;

			case "speech_stopped":
				view = { ...view, phase: activeCall ? "working" : "listening" };
				refresh();
				break;

			case "user_transcript":
				recordTranscript("user", event.text);
				break;

			case "assistant_transcript":
				if (event.final) recordTranscript("agent", event.text);
				break;

			case "background_agent":
				handoff(event.callId, event.prompt, ctx);
				break;

			case "remain_silent":
				// No visible effect and no reply (noop request).
				session?.functionCallOutput(event.callId, "");
				break;

			case "response_done":
				// Generation ended, but audio may still be playing: keep the waveform running to the end.
				endSpeakingWhenPlayed(ctx);
				break;

			case "error": {
				const hint = event.dialectHint ? " — payload rejected by the API; check session format" : "";
				ctx.ui.notify(`voice: ${event.message}${hint}`, "error");
				break;
			}
		}
		setStatus(ctx);
	}

	/**
	 * `background_agent` (handoff output, V2):
	 * - idle: start the turn; the result returns at the end of the run;
	 * - agent running: steer the active task, with an immediate ack.
	 */
	function handoff(callId: string, prompt: string, ctx: ExtensionContext) {
		const turn = wrapDelegation(prompt);
		if (activeCall) {
			// Steer: the original call completes at the end of the run; this one gets only the ack.
			pi.sendUserMessage(turn, { deliverAs: "steer" });
			session?.functionCallOutput(callId, STEER_ACK);
			session?.createResponse();
			return;
		}
		activeCall = callId;
		view = { ...view, phase: "working" };
		refresh();
		setStatus(ctx);
		try {
			if (ctx.isIdle()) pi.sendUserMessage(turn);
			else pi.sendUserMessage(turn, { deliverAs: "steer" });
		} catch (error) {
			activeCall = undefined;
			session?.functionCallOutput(callId, `I could not start the task: ${(error as Error).message}`);
			session?.createResponse();
		}
	}

	// ------------------------------------------------------------------ commands

	pi.registerCommand("stt-live", {
		description: "Real-time voice conversation with the agent (start | stop | mute | settings)",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "mute", "unmute", "status"]
				.filter((option) => option.startsWith(prefix))
				.map((option) => ({ value: option, label: option })),
		handler: async (args, ctx) => {
			const action = (args || "").trim().toLowerCase();
			switch (action) {
				case "":
				case "start":
					await start(ctx);
					return;
				case "stop":
					if (!active()) {
						await echoCleanup.flush().catch(() => ctx.ui.notify("failed to release AEC module", "warning"));
						ctx.ui.notify("no active voice session", "info");
						return;
					}
					teardown(undefined, ctx);
					ctx.ui.notify("voice session stopped", "info");
					return;
				case "mute":
				case "unmute":
					if (!active()) {
						ctx.ui.notify("voice is not active", "info");
						return;
					}
					if ((action === "mute") !== muted) toggleMute(ctx);
					return;
				case "status": {
				const resolved = resolveProvider(providerName);
					const current = activeProvider(config);
					ctx.ui.notify(
						[
							`status: ${active() ? view.phase : "inactive"}`,
							`provider: ${providerName}`,
							`voice: ${current.voice}`,
							`model: ${current.model}`,
							`credential: ${resolved.apiKey ? `ok (${resolved.source})` : "missing"}`,
							`base url: ${resolved.baseUrl || "(none)"}`,
							`transport: ${session?.transport?.impl ?? "-"} · auth: ${session?.transport?.authMode ?? "-"} · protocol: realtime V2`,
							`vad: ${vadLabel}${gate ? ` · gate: ${gate.phase}` : ""}`,
							`output: ${player ? "open" : "closed"} · input: ${recorder ? "open" : "closed"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(`/stt-live ${action}: use start, stop, mute, unmute, or status (see /stt-settings)`, "warning");
			}
		},
	});

	/** Merge a patch into the active provider entry and persist. */
	function updateProvider(patch: Partial<SttEntry>): void {
		const merged: SttEntry = { ...settings, ...patch };
		settings = merged;
		config = { ...config, providers: { ...config.providers, [providerName]: merged } };
		saveConfig(config);
	}

	/** Active settings as lines (used by /stt-settings with no args). */
	function settingsLines(): string[] {
		const v = settings.vad;
		return [
			`provider: ${providerName}`,
			`voice: ${settings.voice}`,
			`language: ${settings.language ?? "(auto)"}`,
			`model: ${settings.model}`,
			`prompt: ${settings.prompt?.trim() ? `custom (${settings.prompt.trim().length} chars)` : "(default persona)"}`,
			`vad: ${v.engine} · mode: ${v.mode} · onset ${v.onsetMs}ms · hangover ${v.hangoverMs}ms · prefill ${v.prefillMs}ms`,
		];
	}

	// ------------------------------------------------------------------ settings

	pi.registerCommand("stt-settings", {
		description: "Voice settings: show | voice | language <code> | model <id> | vad [engine|mode <m>] | provider",
		getArgumentCompletions: (prefix) =>
			["voice", "language", "model", "vad", "provider"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ").trim();

			switch (sub) {
				case "": {
					ctx.ui.notify(
						[...settingsLines(), "", "use: voice | language <code> | model <id> | vad <engine> | vad mode <mode> | provider"].join("\n"),
						"info",
					);
					return;
				}
				case "voice": {
					const choice = await pickVoice(ctx);
					if (!choice) return;
					updateProvider({ voice: choice });
					ctx.ui.notify(`voice set to ${choice} - applies to the next session`, "info");
					return;
				}
				case "language": {
					if (!rest) {
						ctx.ui.notify(
							`language: ${settings.language ?? "(auto)"}\nuse: /stt-settings language <code> (e.g. en, pt, es, zh)\ncode list: ar da de el en es fi fr he it ja ko nl pl pt sv tr zh`,
							"info",
						);
						return;
					}
					const code = rest.toLowerCase();
					updateProvider({ language: code });
					ctx.ui.notify(`language set to ${code} - applies to the next session`, "info");
					return;
				}
				case "model": {
					if (!rest) {
						ctx.ui.notify(`current model: ${settings.model}\nuse: /stt-settings model <id>`, "info");
						return;
					}
					updateProvider({ model: rest });
					ctx.ui.notify(`model set to ${rest} for provider "${providerName}" - applies to the next session`, "info");
					return;
				}
				case "vad": {
					const arg = (parts[1] || "").toLowerCase();
					if (!arg) {
						ctx.ui.notify(
							`vad: ${settings.vad.engine} · mode: ${settings.vad.mode}\nuse: /stt-settings vad <engine> | vad mode <mode>`,
							"info",
						);
						return;
					}
					if (arg === "mode") {
						const mode = (parts[2] || "").toLowerCase() as VadMode;
						if (!VAD_MODES.includes(mode)) {
							ctx.ui.notify(`vad mode must be: ${VAD_MODES.join(", ")}`, "warning");
							return;
						}
						updateProvider({ vad: { ...settings.vad, mode } });
						ctx.ui.notify(`vad mode set to ${mode} - applies to the next session`, "info");
						return;
					}
					const engine = normalizeVadEngine(arg);
					if (!engine) {
						ctx.ui.notify(`vad engine must be: ${VAD_ENGINES.join(", ")}`, "warning");
						return;
					}
					updateProvider({ vad: { ...settings.vad, engine } });
					ctx.ui.notify(
						`vad engine set to ${engine} - applies to the next session${
							active() ? " (stop the session to apply)" : ""
						}`,
						"info",
					);
					return;
				}
				case "provider": {
					await pickProvider(ctx);
					return;
				}
				default:
					ctx.ui.notify(`/stt-settings ${sub}: use voice, language, model, vad, provider, or run /stt-settings to show`, "warning");
			}
		},
	});

	/**
	 * Voice picker with preview: moving the cursor plays the voice sample
	 * (generated once and cached). Enter confirms, Esc cancels.
	 */
	function pickVoice(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const voiceList = settings.voices ?? [...VOICES];
		return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
			let current: ChildProcess | undefined;
			let seq = 0;
			let warned = false;

			const stopPlayback = () => {
				current?.kill();
				current = undefined;
			};

			const preview = async (voice: string) => {
				const mine = ++seq;
				stopPlayback();
				// Voice preview uses the OpenAI TTS endpoint; only valid for OpenAI-hosted providers.
				const resolved = resolveProvider(providerName);
				if (!resolved.apiKey || !resolved.baseUrl.includes("api.openai.com")) {
					if (!warned) ctx.ui.notify("preview unavailable: voice preview is OpenAI-only", "warning");
					warned = true;
					return;
				}
				try {
					const path = await ensurePreview(voice, resolved.apiKey);
					if (mine !== seq) return; // cursor already moved
					current = playPreviewFile(path);
				} catch (error) {
					if (!warned) ctx.ui.notify(String((error as Error).message ?? error), "warning");
					warned = true;
				}
			};

			const list = new SelectList(
				voiceList.map((v) => ({ value: v, label: v, description: v === settings.voice ? "current" : undefined })),
				voiceList.length,
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			const initial = Math.max(0, voiceList.indexOf(settings.voice));
			list.setSelectedIndex(initial);
			list.onSelectionChange = (item) => void preview(item.value as string);
			list.onSelect = (item) => {
				stopPlayback();
				done(item.value as string);
			};
			list.onCancel = () => {
				stopPlayback();
				done(undefined);
			};

			return {
				render: (width: number) => [
					theme.fg("accent", `Conversation voice (current: ${settings.voice}) — ↑↓ preview · enter select · esc cancel`),
					...list.render(width),
				],
				handleInput: (data: string) => list.handleInput(data),
				invalidate: () => list.invalidate?.(),
				dispose: () => {
					seq++;
					stopPlayback();
				},
			};
		});
	}

	pi.registerShortcut("f9", {
		description: "Voice: mute/unmute microphone",
		handler: async (ctx) => {
			if (!active()) {
				ctx.ui.notify("voice inactive — use /stt-live to start", "info");
				return;
			}
			toggleMute(ctx);
		},
	});

	/** Provider picker: choose the active provider (key in stt.json providers). */
	async function pickProvider(ctx: ExtensionCommandContext): Promise<void> {
		const names = Object.keys(config.providers);
		if (names.length === 0) {
			ctx.ui.notify("no providers configured in stt.json", "warning");
			return;
		}
		if (names.length === 1) {
			const p = config.providers[names[0]!];
			ctx.ui.notify(`only one provider: "${names[0]}" (model: ${p.model})`, "info");
			return;
		}
		const selected = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
			const list = new SelectList(
				names.map((name) => {
					const p = config.providers[name]!;
					const desc = `model: ${p.model} · vad: ${p.vad.engine}`;
					return { value: name, label: name, description: name === providerName ? "active (current)" : desc };
				}),
				Math.min(names.length, 8),
				{
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("dim", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			);
			const idx = Math.max(0, names.indexOf(providerName));
			list.setSelectedIndex(idx);
			list.onSelect = (item) => done(item.value as string);
			list.onCancel = () => done(undefined);
			return {
				render: (width: number) => [
					theme.fg("accent", "Select provider — enter switch · esc cancel"),
					...list.render(width),
				],
				handleInput: (data: string) => list.handleInput(data),
					invalidate: () => list.invalidate?.(),
					dispose: () => {},
			};
		});
		if (!selected) return;
		if (active()) {
			ctx.ui.notify(
				`provider set to "${selected}" — stop the current session first (/stt-live stop)`,
				"warning",
			);
			return;
		}
		providerName = selected;
		settings = config.providers[selected]!;
		const resolved = resolveProvider(providerName);
		ctx.ui.notify(
			`active provider: "${providerName}" (model: ${settings.model}) — base: ${resolved.baseUrl || "(none)"}`,
			"info",
		);
	}

	// ------------------------------------------------------------------ events

	// Hide the delegation XML in the transcript, showing only the spoken request.
	pi.registerMarkdownTransformer((markdown) => {
		const unwrapped = unwrapDelegation(markdown);
		if (unwrapped === undefined) return markdown;
		return `🎙️ ${unwrapped}`;
	});

	pi.registerEntryRenderer(TRANSCRIPT_ENTRY, (entry, _options, theme) => {
		const data = (entry as { data?: { role?: string; text?: string } }).data;
		if (!data?.text) return undefined;
		const prefix = data.role === "user" ? "🎙️ you" : "🔊 agent";
		return new Text(`${theme.fg("dim", prefix)} ${data.text}`, 0, 0);
	});

	pi.on("agent_start", () => {
		agentRunning = true;
	});

	pi.on("agent_end", async (event, ctx) => {
		agentRunning = false;
		if (!session || !activeCall) return;
		const callId = activeCall;
		activeCall = undefined;
		// Result as a [BACKEND] item; then the call completion.
		const answer = finalAnswerText(event.messages);
		if (answer) session.backendItem(answer);
		session.functionCallOutput(callId, HANDOFF_COMPLETE_ACK);
		session.createResponse();
		view = { ...view, phase: muted ? "muted" : "listening" };
		refresh();
		setStatus(ctx);
	});

	// A decision request (permission prompt, error, confirmation) is announced by voice.
	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!session) return;
		session.backendItem(`the agent needs a decision in the terminal: ${event.title ?? event.kind}`);
		session.createResponse();
		refresh();
		setStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (session) {
			session.developerText(END_INSTRUCTIONS);
			teardown(undefined, ctx);
		}
		await echoCleanup.flush().catch(() => ctx.ui.notify("failed to release AEC module on shutdown", "warning"));
	});
}
