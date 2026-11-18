/**
 * Realtime session V2 (`/v1/realtime`).
 *
 * Mirrors the Codex realtime design. Conscious divergences (ADR 0004):
 * 1. Auth: API key (`OPENAI_API_KEY`) instead of ChatGPT + `intent=quicksilver`.
 * 2. Transport: WebSocket PCM16 instead of WebRTC (Node has no native helper).
 */

import type { VoiceSettings } from "./config.ts";
import { openRealtimeSocket, type OpenSocketOptions, type TransportInfo, type VoiceSocket } from "./socket.ts";

export type VoiceEvent =
	| { kind: "ready" }
	| { kind: "audio"; pcm: Buffer; itemId?: string }
	| { kind: "user_transcript"; text: string }
	| { kind: "assistant_transcript"; text: string; final: boolean }
	| { kind: "speech_started" }
	| { kind: "speech_stopped" }
	| { kind: "background_agent"; callId: string; prompt: string }
	| { kind: "remain_silent"; callId: string }
	| { kind: "response_done" }
	| { kind: "error"; message: string; dialectHint: boolean }
	| { kind: "other"; type: string };

/** V2 tools. Names and descriptions are fixed by the Realtime API. */
export const BACKGROUND_AGENT_TOOL = "background_agent";
export const REMAIN_SILENT_TOOL = "remain_silent";

const BACKGROUND_AGENT_DESCRIPTION =
	"Send a user request to the background agent. Use this as the default action. Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. If the background agent is idle, this starts a new task and returns the final result to the user. If the background agent is already working on a task, this sends the request as guidance to steer that previous task. If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later.";
const REMAIN_SILENT_DESCRIPTION =
	"Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. This tool has no user-visible effect.";

/** Input transcription model for V2. */
export const INPUT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** PCM16 mono rate (24 kHz). */
const PCM_RATE = 24_000;

/**
 * Normalizes a raw GA API event (`response.output_audio.*`).
 * Beta names are no longer sent: V2 uses only the GA format.
 */
export function parseRealtimeEvent(raw: unknown): VoiceEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const event = raw as Record<string, any>;
	const type = typeof event.type === "string" ? event.type : "";
	if (!type) return null;

	switch (type) {
		case "session.created":
		case "session.updated":
			return { kind: "ready" };

		case "response.output_audio.delta":
			return {
				kind: "audio",
				pcm: Buffer.from(String(event.delta ?? ""), "base64"),
				itemId: typeof event.item_id === "string" ? event.item_id : undefined,
			};

		case "conversation.item.input_audio_transcription.completed":
			return { kind: "user_transcript", text: String(event.transcript ?? "").trim() };

		case "response.output_audio_transcript.delta":
			return { kind: "assistant_transcript", text: String(event.delta ?? ""), final: false };

		case "response.output_audio_transcript.done":
			return { kind: "assistant_transcript", text: String(event.transcript ?? ""), final: true };

		case "input_audio_buffer.speech_started":
			return { kind: "speech_started" };

		case "input_audio_buffer.speech_stopped":
			return { kind: "speech_stopped" };

		case "response.done":
			return { kind: "response_done" };

		case "error": {
			const message = String(event.error?.message ?? event.message ?? "erro realtime");
			// Wrong-payload hints are reported, not silently fixed.
			const dialectHint = /unknown (parameter|field)|not supported|invalid (value|type)|audio.*(format|config)/i.test(message);
			return { kind: "error", message, dialectHint };
		}

		case "response.function_call_arguments.done": {
			const name = String(event.name ?? "");
			const callId = String(event.call_id ?? "");
			if (name === REMAIN_SILENT_TOOL) return { kind: "remain_silent", callId };
			if (name !== BACKGROUND_AGENT_TOOL) return { kind: "other", type };
			let prompt = "";
			try {
				const args = JSON.parse(String(event.arguments ?? "{}"));
				prompt = String(args.prompt ?? "").trim();
			} catch {
				return { kind: "error", message: "argumentos inválidos em background_agent", dialectHint: false };
			}
			if (!prompt) return { kind: "error", message: "background_agent sem pedido", dialectHint: false };
			return { kind: "background_agent", callId, prompt };
		}

		default:
			return { kind: "other", type };
	}
}

/** Session instructions = backend_prompt (+ startup context). */
export function buildInstructions(backendPrompt: string, startupContext = ""): string {
	return startupContext.trim() ? `${backendPrompt.trim()}\n\n${startupContext.trim()}` : backendPrompt.trim();
}

/**
 * `session.update` payload for V2 (conversational mode).
 * `model` goes in the URL.
 */
export function buildSessionUpdate(
	settings: VoiceSettings,
	instructions: string,
): Record<string, unknown> {
	return {
		type: "session.update",
		session: {
			type: "realtime",
			instructions,
			output_modalities: ["audio"],
			audio: {
				input: {
					format: { type: "audio/pcm", rate: PCM_RATE },
					noise_reduction: { type: "near_field" },
					transcription: { model: INPUT_TRANSCRIPTION_MODEL },
					// Active client VAD => the server detects no boundaries. Without this,
					// server_vad + client commit create double boundaries (R2).
					turn_detection: settings.vad && settings.vad.engine !== "off" ? null : {
						type: "server_vad",
						interrupt_response: true,
						create_response: true,
						silence_duration_ms: 500,
					},
				},
				output: { format: { type: "audio/pcm", rate: PCM_RATE }, voice: settings.voice },
			},
			tools: [
				{
					type: "function",
					name: BACKGROUND_AGENT_TOOL,
					description: BACKGROUND_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							prompt: {
								type: "string",
								description: "The user request to delegate to the background agent.",
							},
						},
						required: ["prompt"],
						additionalProperties: false,
					},
				},
				{
					type: "function",
					name: REMAIN_SILENT_TOOL,
					description: REMAIN_SILENT_DESCRIPTION,
					parameters: { type: "object", properties: {}, additionalProperties: false },
				},
			],
			tool_choice: "auto",
		},
	};
}

/** Developer item injected at start (realtime_start.md). */
export function developerItem(text: string): Record<string, unknown> {
	return {
		type: "conversation.item.create",
		item: { type: "message", role: "developer", content: [{ type: "input_text", text }] },
	};
}

export interface RealtimeSessionOptions {
	apiKey: string;
	settings: VoiceSettings;
	/** Full instructions (backend prompt + startup context). */
	instructions: string;
	/** Developer item sent after `session.updated` (session start). */
	startItem?: string;
	/** Socket opener. Default: `openRealtimeSocket`; injectable for tests. */
	openSocket?: (options: OpenSocketOptions) => Promise<VoiceSocket>;
	onEvent: (event: VoiceEvent) => void;
	/** Called only after ready. Failures before that are rejected by `connect()`. */
	onClose?: (reason: string) => void;
}

/** Max time for the socket to open and the session to be configured. */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Lifecycle:
 *   idle → connecting → configuring (session.update sent, awaits session.updated)
 *        → ready → closed (terminal)
 * Nothing is sent outside `configuring`/`ready`, and `send` never throws outward.
 */
type SessionState = "idle" | "connecting" | "configuring" | "ready" | "closed";

export class RealtimeSession {
	private socket: VoiceSocket | undefined;
	private state: SessionState = "idle";
	private setup: { resolve: () => void; reject: (error: Error) => void } | undefined;
	/** A model response is in progress (response.created … response.done). */
	private responseActive = false;
	/** A `response.create` was requested while a response was active (queue of 1). */
	private createPending = false;
	/** Output audio of the current response, to truncate on barge-in. */
	private outputAudio: { itemId: string; audioEndMs: number } | undefined;
	private readonly options: RealtimeSessionOptions;

	constructor(options: RealtimeSessionOptions) {
		this.options = options;
	}

	get transport(): TransportInfo | undefined {
		return this.socket?.transport;
	}

	/** Resolves only when `session.updated` arrives. Rejects on error, close, or timeout. */
	connect(): Promise<void> {
		if (this.state !== "idle") return Promise.reject(new Error("sessão realtime já iniciada"));
		this.state = "connecting";
		const ready = new Promise<void>((resolve, reject) => {
			this.setup = { resolve, reject };
		});
		ready.catch(() => {});
		const timer = setTimeout(() => this.failSetup(new Error("tempo esgotado ao conectar na voz")), CONNECT_TIMEOUT_MS);
		void this.open().catch((error: Error) => this.failSetup(error));
		return ready.finally(() => clearTimeout(timer));
	}

	private async open(): Promise<void> {
		const openSocket = this.options.openSocket ?? openRealtimeSocket;
		const socket = await openSocket({
			apiKey: this.options.apiKey,
			model: this.options.settings.model,
			dialect: "ga",
			handlers: {
				onOpen: () => {
					if (this.state !== "connecting") return;
					this.state = "configuring";
					this.send(buildSessionUpdate(this.options.settings, this.options.instructions));
				},
				onMessage: (data) => this.handleMessage(data),
				onClose: (code, reason) => {
					const why = `conexão realtime encerrada (${code}${reason ? `: ${reason}` : ""})`;
					this.socket = undefined;
					if (this.state === "connecting" || this.state === "configuring") {
						this.failSetup(new Error(why));
					} else if (this.state === "ready") {
						this.state = "closed";
						this.options.onClose?.(why);
					}
				},
				onError: (error) => {
					if (this.state === "ready") {
						this.options.onEvent({ kind: "error", message: error.message, dialectHint: false });
					} else {
						this.failSetup(error);
					}
				},
			},
		});
		this.socket = socket;
		if (this.state === "closed") this.closeSocket();
	}

	private handleMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		const type = (parsed as { type?: unknown } | null)?.type;

		if (type === "response.created") this.responseActive = true;
		if (type === "response.done") this.onResponseFinished();

		if (this.state === "configuring" && type === "session.updated") {
			this.state = "ready";
			if (this.options.startItem) this.send(developerItem(this.options.startItem));
			this.setup?.resolve();
		}

		// Barge-in: `interrupt_response` cancels on the server; here we only truncate already emitted audio.
		if (type === "input_audio_buffer.speech_started") this.truncateOutputAudio();

		const event = parseRealtimeEvent(parsed);
		if (event?.kind === "audio" && event.itemId) {
			const ms = (event.pcm.length / 2 / PCM_RATE) * 1000;
			if (this.outputAudio?.itemId === event.itemId) this.outputAudio.audioEndMs += ms;
			else this.outputAudio = { itemId: event.itemId, audioEndMs: ms };
		}
		if (this.state === "configuring" && event?.kind === "error") {
			this.failSetup(new Error(event.message));
			return;
		}
		if (event) this.options.onEvent(event);
	}

	private onResponseFinished(): void {
		this.responseActive = false;
		this.outputAudio = undefined;
		if (this.createPending) {
			this.createPending = false;
			this.createResponse();
		}
	}

	private truncateOutputAudio(): void {
		const audio = this.outputAudio;
		this.outputAudio = undefined;
		if (!audio) return;
		this.send({
			type: "conversation.item.truncate",
			item_id: audio.itemId,
			content_index: 0,
			audio_end_ms: Math.floor(audio.audioEndMs),
		});
	}

	/** Sends an event. Returns false without throwing when no send is possible. */
	private send(event: Record<string, unknown>): boolean {
		const socket = this.socket;
		if (!socket || !socket.isOpen()) {
			this.fatal("conexão de voz não está aberta");
			return false;
		}
		try {
			socket.send(JSON.stringify(event));
			return true;
		} catch (error) {
			this.fatal(`falha ao enviar à voz: ${(error as Error).message}`);
			return false;
		}
	}

	private fatal(reason: string): void {
		if (this.state === "connecting" || this.state === "configuring") {
			this.failSetup(new Error(reason));
			return;
		}
		if (this.state !== "ready") return;
		this.state = "closed";
		this.closeSocket();
		this.options.onClose?.(reason);
	}

	private failSetup(error: Error): void {
		if (this.state !== "connecting" && this.state !== "configuring") return;
		this.state = "closed";
		this.closeSocket();
		this.setup?.reject(error);
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close();
		} catch {
			// already closed
		}
	}

	/** Sends audio only when ready. */
	appendAudio(frame: Buffer): void {
		if (this.state !== "ready") return;
		this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
	}

	/**
	 * Closes the user turn: sends `input_audio_buffer.commit` only when
	 * ready. Used by the client VAD gate at the commit point (end of speech).
	 */
	commit(): void {
		if (this.state !== "ready") return;
		this.send({ type: "input_audio_buffer.commit" });
	}

	/**
	 * Commits the turn and, if `vad.commitResponse`, requests the spoken response. Reuses
	 * the `createResponse` queue (one response at a time).
	 */
	commitAndRespond(): void {
		this.commit();
		if (this.options.settings.vad?.commitResponse) this.createResponse();
	}

	/**
	 * Requests a spoken response. If one is already in progress, it stays pending and is
	 * sent on `response.done` (response-create queue).
	 */
	createResponse(): void {
		if (this.state !== "ready") return;
		if (this.responseActive) {
			this.createPending = true;
			return;
		}
		this.responseActive = true;
		this.send({ type: "response.create" });
	}

	/** Result of a function call (`background_agent`, `remain_silent`). */
	functionCallOutput(callId: string, output: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: callId, output },
		});
	}

	/** Typed user text (same role as voice transcription). Used in E2E tests. */
	userText(text: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
		});
	}

	/** Developer message (conversation start/end, `realtime_start.md`/`realtime_end.md`). */
	developerText(text: string): void {
		if (this.state !== "ready") return;
		this.send(developerItem(text));
	}

	/** `[BACKEND] ` item: agent progress or result, read by the model as user. */
	backendItem(text: string): void {
		if (this.state !== "ready") return;
		this.send({
			type: "conversation.item.create",
			item: { type: "message", role: "user", content: [{ type: "input_text", text: `[BACKEND] ${text}` }] },
		});
	}

	/** User-requested close: does not trigger `onClose`. */
	close(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		this.closeSocket();
		this.setup?.reject(new Error("sessão de voz encerrada antes de ficar pronta"));
	}
}
