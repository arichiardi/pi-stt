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
 * Shortcut: f9 - mute/unmute the microphone.
 *
 * Needs OPENAI_API_KEY (or PI_VOICE_API_KEY, or openai in <agentDir>/auth.json):
 * the transport is `/v1/realtime`, with an API key instead of ChatGPT auth.
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
import {
	VOICES,
	loadSettings,
	resolveApiKey,
	saveSettings,
	type VoiceName,
	type VoiceSettings,
} from "./config.ts";
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
	let settings: VoiceSettings = loadSettings();
	let session: RealtimeSession | undefined;
	let recorder: Recorder | undefined;
	let player: Player | undefined;
	/** VAD gate for the current session (null when the engine is off). */
	let gate: SpeechGate | undefined;
	/** Label for `/stt-live status`: `<engine> · <wasm status>`. */
	let vadLabel = "off";
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
		vadLabel = "off";
		const oldEcho = echoAudio;
		echoAudio = undefined;
		if (oldEcho) echoCleanup.add(oldEcho);
		void echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC; limpeza será tentada novamente", "warning"));
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
		if (reason) ctx.ui.notify(`voz encerrada: ${reason}`, "warning");
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
		ctx.ui.notify(muted ? "microfone mutado (f9)" : "microfone ativo (f9)", "info");
	}

	async function start(ctx: ExtensionContext) {
		if (active()) {
			ctx.ui.notify("sessão de voz já está ativa — /stt-live stop para encerrar", "info");
			return;
		}
		const apiKey = resolveApiKey();
		if (!apiKey) {
			ctx.ui.notify(
				"sem credencial: rode /login openai (ou defina OPENAI_API_KEY)",
				"error",
			);
			return;
		}

		settings = loadSettings();
		muted = settings.muteOnStart;
		view = { phase: "starting", speaking: false };
		micSum = 0;
		micCount = 0;
		micLast = 0;
		micLastAt = 0;
		outSchedule = [];
		playhead = 0;
		gate = undefined;
		vadLabel = "off";

		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, createVoiceWidget(() => ({ ...view, takeMicLevel, outLevelAt })), {
				placement: "aboveEditor",
			});
		}

		const onEvent = (event: VoiceEvent) => handleEvent(event, ctx);

		// Show "connecting" until the session is configured; open the mic only after.
		setStatus(ctx);

		// realtime_start goes in `instructions` (V2); the API rejects a `developer` item.
		const instructions = buildInstructions(
			`${backendPrompt(process.env.USER || process.env.USERNAME)}\n\n${START_INSTRUCTIONS}`,
			buildStartupContext(ctx.sessionManager.getBranch(), ctx.cwd),
		);
		const current = new RealtimeSession({
			apiKey,
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
				ctx.ui.notify(`falha ao abrir voz: ${(error as Error).message}`, "error");
			}
			return;
		}
		// /stt-live stop (or a failure) during connect already ended this session.
		if (session !== current) return;

		try {
			if (settings.inputDevice || settings.outputDevice) {
				throw new Error("AEC usa os dispositivos padrão PulseAudio/PipeWire; remova inputDevice/outputDevice de voice.json");
			}
			const routes = await deps.openEcho();
			if (session !== current) {
				echoCleanup.add(routes);
				await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar AEC de sessão cancelada", "warning"));
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
				? `${settings.vad.engine} · ${scorer.kind === "webrtc_fvad" ? "wasm" : "rms"}`
				: "off";
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
					ctx.ui.notify(`microfone: ${error.message}`, "error");
					if (session === current) teardown("falha no microfone", ctx);
				},
			});
			recorder.setMuted(muted);
			recorder.start(routes.capture);
		} catch (error) {
			if (session !== current) return;
			teardown(`falha ao iniciar áudio: ${(error as Error).message}`, ctx);
			return;
		}

		view = { ...view, phase: muted ? "muted" : "listening" };
		setStatus(ctx);
		ctx.ui.notify(
			muted
				? "Voz conectada (mutado). f9 desmuta, /stt-live stop encerra."
				: "Conversa por voz iniciada. f9 muda, /stt-live stop encerra.",
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
				const hint = event.dialectHint ? " — payload rejeitado pela API; verifique o formato da sessão" : "";
				ctx.ui.notify(`voz: ${event.message}${hint}`, "error");
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
			session?.functionCallOutput(callId, `não consegui iniciar a tarefa: ${(error as Error).message}`);
			session?.createResponse();
		}
	}

	// ------------------------------------------------------------------ commands

	pi.registerCommand("stt-live", {
		description: "Real-time voice conversation with the agent (start | stop | mute | settings)",
		getArgumentCompletions: (prefix) =>
			["start", "stop", "mute", "unmute", "settings", "status"]
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
						await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC", "warning"));
						ctx.ui.notify("nenhuma sessão de voz ativa", "info");
						return;
					}
					teardown(undefined, ctx);
					ctx.ui.notify("voz encerrada", "info");
					return;
				case "mute":
				case "unmute":
					if (!active()) {
						ctx.ui.notify("a voz não está ativa", "info");
						return;
					}
					if ((action === "mute") !== muted) toggleMute(ctx);
					return;
				case "status": {
					const key = resolveApiKey();
					ctx.ui.notify(
						[
							`estado: ${active() ? view.phase : "inativa"}`,
							`voz: ${settings.voice}`,
							`modelo: ${settings.model}`,
							`credencial: ${key ? "ok" : "ausente"}`,
							`transporte: ${session?.transport?.impl ?? "-"} · auth: ${session?.transport?.authMode ?? "-"} · protocolo: realtime V2`,
							`vad: ${vadLabel}${gate ? ` · gate: ${gate.phase}` : ""}`,
							`saída: ${player ? "aberta" : "fechada"} · entrada: ${recorder ? "aberta" : "fechada"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				case "settings":
					await openSettings(ctx);
					return;
				default:
					ctx.ui.notify(`/stt-live ${action}: use start, stop, mute, unmute, settings ou status`, "warning");
			}
		},
	});

	async function openSettings(ctx: ExtensionCommandContext) {
		const choice = await pickVoice(ctx);
		if (!choice) return;
		settings = { ...settings, voice: choice as VoiceName };
		saveSettings(settings);
		ctx.ui.notify(
			`voz definida para ${choice} — vale para a próxima sessão (/stt-live stop e /stt-live)`,
			"info",
		);
	}

	/**
	 * Voice picker with preview: moving the cursor plays the voice sample
	 * (generated once and cached). Enter confirms, Esc cancels.
	 */
	function pickVoice(ctx: ExtensionCommandContext): Promise<VoiceName | undefined> {
		return ctx.ui.custom<VoiceName | undefined>((_tui, theme, _kb, done) => {
			let current: ChildProcess | undefined;
			let seq = 0;
			let warned = false;

			const stopPlayback = () => {
				current?.kill();
				current = undefined;
			};

			const preview = async (voice: VoiceName) => {
				const mine = ++seq;
				stopPlayback();
				const key = resolveApiKey();
				if (!key) {
					if (!warned) ctx.ui.notify("prévia indisponível: credencial OpenAI ausente", "warning");
					warned = true;
					return;
				}
				try {
					const path = await ensurePreview(voice, key);
					if (mine !== seq) return; // cursor already moved
					current = playPreviewFile(path);
				} catch (error) {
					if (!warned) ctx.ui.notify(String((error as Error).message ?? error), "warning");
					warned = true;
				}
			};

			const list = new SelectList(
				VOICES.map((v) => ({ value: v, label: v, description: v === settings.voice ? "atual" : undefined })),
				VOICES.length,
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("dim", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			const initial = Math.max(0, VOICES.indexOf(settings.voice));
			list.setSelectedIndex(initial);
			list.onSelectionChange = (item) => void preview(item.value as VoiceName);
			list.onSelect = (item) => {
				stopPlayback();
				done(item.value as VoiceName);
			};
			list.onCancel = () => {
				stopPlayback();
				done(undefined);
			};

			return {
				render: (width: number) => [
					theme.fg("accent", `Voz da conversa (atual: ${settings.voice}) — ↑↓ ouvir prévia · enter escolhe · esc cancela`),
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
		description: "Voz: mutar/desmutar microfone",
		handler: async (ctx) => {
			if (!active()) {
				ctx.ui.notify("voz inativa — use /stt-live para iniciar", "info");
				return;
			}
			toggleMute(ctx);
		},
	});

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
		const prefix = data.role === "user" ? "🎙️ você" : "🔊 agente";
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
		session.backendItem(`o agente precisa de uma decisão no terminal: ${event.title ?? event.kind}`);
		session.createResponse();
		refresh();
		setStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (session) {
			session.developerText(END_INSTRUCTIONS);
			teardown(undefined, ctx);
		}
		await echoCleanup.flush().catch(() => ctx.ui.notify("falha ao liberar módulo AEC no shutdown", "warning"));
	});
}
