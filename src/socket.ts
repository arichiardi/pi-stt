/**
 * WebSocket transport for the voice session.
 *
 * Mirrors the Codex realtime design: uses the `ws` library with an `Authorization` header. The
 * `OpenAI-Beta: realtime=v1` header is sent only in the beta dialect (legacy endpoint).
 *
 * `ws` is not resolvable by `import("ws")` from the extension directory,
 * but it is by `createRequire(process.argv[1])` - the pi entrypoint, which owns
 * the `node_modules` where it lives. If that resolution fails (running outside
 * pi, altered install), we fall back to the Node global `WebSocket`, which does not accept
 * headers: in that case the API key is swapped for an ephemeral client secret sent
 * in a subprotocol. The mode used is shown in `/stt-live status`.
 */

import { createRequire } from "node:module";
import { API_BASE } from "./config.ts";

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
	/** true only in the OPEN state. `send()` outside it throws (`ws` and global WebSocket). */
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

/** Load `ws` from the pi node_modules. */
export function loadWs(): WsCtor | undefined {
	const candidates = [process.argv[1], process.execPath].filter(Boolean) as string[];
	for (const candidate of candidates) {
		try {
			const resolved = createRequire(candidate)("ws") as WsCtor | { default: WsCtor };
			const ctor = (resolved as { default?: WsCtor }).default ?? (resolved as WsCtor);
			if (typeof ctor === "function") return ctor;
		} catch {
			// try the next one
		}
	}
	return undefined;
}

async function mintEphemeralKey(apiKey: string, model: string): Promise<string> {
	const attempts = [
		{ url: `${API_BASE}/realtime/client_secrets`, body: { session: { type: "realtime", model } } },
		{ url: `${API_BASE}/realtime/sessions`, body: { model } },
	];
	let lastError = "";
	for (const attempt of attempts) {
		const response = await fetch(attempt.url, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(attempt.body),
		});
		if (!response.ok) {
			lastError = `${attempt.url} → HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
			continue;
		}
		const payload = (await response.json()) as Record<string, any>;
		const value =
			payload.value ??
			payload.client_secret?.value ??
			payload.client_secret ??
			payload.session?.client_secret?.value;
		if (typeof value === "string" && value) return value;
		lastError = `${attempt.url} → resposta sem client secret`;
	}
	throw new Error(`não foi possível obter client secret: ${lastError}`);
}

export type SocketDialect = "ga" | "beta";

/**
 * Handshake headers. GA (`/v1/realtime`) accepts only Authorization: the
 * `OpenAI-Beta` header makes the API reject with "The Realtime Beta API is no longer supported".
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
	dialect?: SocketDialect;
	handlers: SocketHandlers;
}

export async function openRealtimeSocket(options: OpenSocketOptions): Promise<VoiceSocket> {
	const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`;
	const Ws = loadWs();
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

	const secret = await mintEphemeralKey(options.apiKey, options.model);
	const socket = new WebSocket(url, buildSubprotocols(secret, dialect));
	socket.addEventListener("open", () => options.handlers.onOpen());
	socket.addEventListener("message", (event: MessageEvent) => options.handlers.onMessage(String(event.data)));
	socket.addEventListener("close", (event: CloseEvent) => options.handlers.onClose(event.code, event.reason));
	socket.addEventListener("error", () => options.handlers.onError(new Error("erro no WebSocket realtime")));
	return {
		transport: { impl: "global-websocket", authMode: "ephemeral-subprotocol" },
		isOpen: () => socket.readyState === WS_OPEN,
		send: (data) => socket.send(data),
		close: () => socket.close(),
	};
}
