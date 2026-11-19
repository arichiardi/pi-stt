/**
 * WebSocket transport for the voice session.
 *
 * Uses the `ws` library with an `Authorization` header (primary path).
 * Falls back to Node's global `WebSocket` with an ephemeral client secret
 * (OpenAI only). The mode used is shown in `/stt-live status`.
 *
 * The `baseUrl` is provider-specific: derived from the profile's provider
 * (openai, llama.cpp, models.json custom). The WebSocket URL is built by
 * swapping http(s) to ws(s) and appending /realtime?model=...
 */


export type AuthMode = "header" | "ephemeral-subprotocol";
export type SocketImpl = "ws" | "global-websocket";

export interface TransportInfo {
	impl: SocketImpl;
	authMode: AuthMode;
}

export interface SocketHandlers {
	onOpen(): void;
	onMessage(data: string): void;
	onClose(code: number, reason: string): void;
	onError(error: Error): void;
}

export interface VoiceSocket {
	readonly transport: TransportInfo;
	/** true only in the OPEN state. */
	isOpen(): boolean;
	send(data: string): void;
	close(): void;
}

/** WebSocket.OPEN is 1 in both implementations. */
const WS_OPEN = 1;

interface WsLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(event: string, listener: (...args: any[]) => void): void;
}

type WsCtor = new (
	url: string,
	options: { headers: Record<string, string> },
) => WsLike;

/** Load `ws` with a dynamic import. jiti resolves it from the extension's node_modules. */
async function loadWs(): Promise<WsCtor | undefined> {
	try {
		const mod: any = await import("ws");
		const ctor = mod?.default?.default ?? mod?.default ?? mod?.WebSocket ?? mod;
		if (typeof ctor === "function") return ctor as WsCtor;
	} catch {
		// ws is not installed; the caller falls back to the global WebSocket
	}
	return undefined;
}

/** Converts an HTTP(S) baseUrl to a WebSocket URL for /realtime. */
export function wsUrlFromBase(baseUrl: string, model: string): string {
	const ws = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
	return `${ws}/realtime?model=${encodeURIComponent(model)}`;
}

/** True if the baseUrl is OpenAI's hosted API. */
function isOpenAI(baseUrl: string): boolean {
	return baseUrl.includes("api.openai.com");
}

async function mintEphemeralKey(baseUrl: string, apiKey: string, model: string): Promise<string> {
	const attempts = [
		{ url: `${baseUrl}/realtime/client_secrets`, body: { session: { type: "realtime", model } } },
		{ url: `${baseUrl}/realtime/sessions`, body: { model } },
	];
	let lastError = "";
	for (const attempt of attempts) {
		const response = await fetch(attempt.url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(attempt.body),
		});
		if (!response.ok) {
			lastError = `${attempt.url} -> HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
			continue;
		}
		const payload = (await response.json()) as Record<string, any>;
		const value =
			payload.value ??
			payload.client_secret?.value ??
			payload.client_secret ??
			payload.session?.client_secret?.value;
		if (typeof value === "string" && value) return value;
		lastError = `${attempt.url} -> response without client secret`;
	}
	throw new Error(`failed to obtain client secret: ${lastError}`);
}

export type SocketDialect = "ga" | "beta";

/**
 * Handshake headers. GA (/v1/realtime) accepts only Authorization.
 */
export function buildHandshakeHeaders(apiKey: string, dialect: SocketDialect): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	if (dialect === "beta") headers["OpenAI-Beta"] = "realtime=v1";
	return headers;
}

/** Subprotocols for the headerless path (ephemeral client secret). */
export function buildSubprotocols(secret: string, dialect: SocketDialect): string[] {
	const protocols = ["realtime", `openai-insecure-api-key.${secret}`];
	if (dialect === "beta") protocols.push("openai-beta.realtime-v1");
	return protocols;
}

export interface OpenSocketOptions {
	apiKey: string;
	model: string;
	baseUrl: string;
	dialect?: SocketDialect;
	handlers: SocketHandlers;
}

export async function openRealtimeSocket(options: OpenSocketOptions): Promise<VoiceSocket> {
	const url = wsUrlFromBase(options.baseUrl, options.model);
	const Ws = await loadWs();
	const dialect = options.dialect ?? "ga";

	if (Ws) {
		const socket = new Ws(url, {
			headers: buildHandshakeHeaders(options.apiKey, dialect),
		});
		socket.on("open", () => options.handlers.onOpen());
		socket.on("message", (data: unknown) => options.handlers.onMessage(String(data)));
		socket.on("close", (code: number, reason: Buffer | string) =>
			options.handlers.onClose(code, String(reason ?? "")),
		);
		socket.on("error", (error: Error) => options.handlers.onError(error));
		return {
			transport: { impl: "ws", authMode: "header" },
			isOpen: () => socket.readyState === WS_OPEN,
			send: (data) => socket.send(data),
			close: () => socket.close(),
		};
	}

	// Global WebSocket fallback: requires an ephemeral client secret (OpenAI only).
	if (!isOpenAI(options.baseUrl)) {
		throw new Error(
			"ws module not available. This provider needs Authorization header auth, " +
			"which the global WebSocket cannot send. Update pi (it bundles ws), " +
			"or use an OpenAI provider (ephemeral-key subprotocol auth).",
		);
	}

	const secret = await mintEphemeralKey(options.baseUrl, options.apiKey, options.model);
	const socket = new WebSocket(url, buildSubprotocols(secret, dialect));
	socket.addEventListener("open", () => options.handlers.onOpen());
	socket.addEventListener("message", (event: MessageEvent) => options.handlers.onMessage(String(event.data)));
	socket.addEventListener("close", (event: CloseEvent) => options.handlers.onClose(event.code, event.reason));
	socket.addEventListener("error", () => options.handlers.onError(new Error("realtime WebSocket error")));
	return {
		transport: { impl: "global-websocket", authMode: "ephemeral-subprotocol" },
		isOpen: () => socket.readyState === WS_OPEN,
		send: (data) => socket.send(data),
		close: () => socket.close(),
	};
}
