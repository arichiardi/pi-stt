/**
 * Regression: the microphone sent audio while the WebSocket was still in
 * CONNECTING, and `send()` threw an exception that took pi down.
 * Run: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/
 *
 * The fake socket reproduces `ws`: `send()` throws outside the OPEN state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROVIDER } from "../src/config.ts";
import { RealtimeSession, type VoiceEvent } from "../src/realtime.ts";
import type { OpenSocketOptions, VoiceSocket } from "../src/socket.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function fakeTransport() {
	const sent: string[] = [];
	let readyState = CONNECTING;
	let closeCalls = 0;
	let handlers!: OpenSocketOptions["handlers"];

	const socket: VoiceSocket = {
		transport: { impl: "ws", authMode: "header" },
		isOpen: () => readyState === OPEN,
		send(data: string) {
			if (readyState !== OPEN) {
				throw new Error(`WebSocket is not open: readyState ${readyState} (CONNECTING)`);
			}
			sent.push(data);
		},
		close() {
			closeCalls += 1;
			readyState = CLOSED;
		},
	};

	return {
		sent,
		get closeCalls() {
			return closeCalls;
		},
		openSocket: async (options: OpenSocketOptions) => {
			handlers = options.handlers;
			return socket;
		},
		open() {
			readyState = OPEN;
			handlers.onOpen();
		},
		/** The socket becomes CLOSED before the close event arrives. */
		drop() {
			readyState = CLOSED;
		},
		message(event: Record<string, unknown>) {
			handlers.onMessage(JSON.stringify(event));
		},
		error(message: string) {
			handlers.onError(new Error(message));
		},
	};
}

/** Network events are async: run one event loop turn before firing `open`. */
const tick = () => new Promise((r) => setImmediate(r));

function makeSession(transport: ReturnType<typeof fakeTransport>, overrides: { onClose?: (r: string) => void } = {}) {
	const events: VoiceEvent[] = [];
	const session = new RealtimeSession({
		apiKey: "test-key", baseUrl: "https://api.openai.com/v1",
		settings: DEFAULT_PROVIDER,
		dialect: "ga",
		openSocket: transport.openSocket,
		onEvent: (event) => events.push(event),
		onClose: overrides.onClose,
	});
	return { session, events };
}

const audio = Buffer.alloc(960);

test("connect resolves only when session.updated arrives, not on socket creation", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);

	let resolved = false;
	const connecting = session.connect().then(() => (resolved = true));

	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "must not be ready before opening");

	await tick();
	transport.open();
	transport.message({ type: "session.created" });
	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "session.created is not an applied configuration");

	transport.message({ type: "session.updated" });
	await connecting;
	assert.equal(resolved, true);
	assert.equal(transport.sent.length, 1, "exatamente um session.update");
});

test("audio before ready is discarded without throwing or sending", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	void session.connect().catch(() => {});

	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(transport.sent.length, 0);
});

test("audio after ready is sent", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	session.appendAudio(audio);
	assert.equal(transport.sent.length, 2);
	assert.match(transport.sent[1], /input_audio_buffer.append/);
});

test("erro antes de pronto rejeita connect e bloqueia envios", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();

	transport.error("handshake recusado");
	await assert.rejects(connecting, /handshake recusado/);
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(transport.sent.length, 0);
});

test("server config error before ready rejects connect", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();

	await tick();
	transport.open();
	transport.message({ type: "error", error: { message: "unknown parameter: audio" } });
	await assert.rejects(connecting, /unknown parameter/);
});

test("close during connection rejects connect without throwing", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	const connecting = session.connect();
	await new Promise((r) => setImmediate(r));

	assert.doesNotThrow(() => session.close());
	await assert.rejects(connecting);
	assert.doesNotThrow(() => session.appendAudio(audio));
});

test("send failure after ready ends voice without throwing", async () => {
	const transport = fakeTransport();
	let closeReason: string | undefined;
	let closeCount = 0;
	const { session } = makeSession(transport, {
		onClose: (reason) => {
			closeCount += 1;
			closeReason = reason;
		},
	});
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;

	// Simulate the socket dropping to CLOSED before the close event arrived.
	transport.drop();
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.doesNotThrow(() => session.appendAudio(audio));
	assert.equal(closeCount, 1, "closes exactly once");
	assert.ok(closeReason);
});

test("session dialect reaches the handshake", async () => {
	const seen: Array<string | undefined> = [];
	const session = new RealtimeSession({
		apiKey: "test-key", baseUrl: "https://api.openai.com/v1",
		settings: DEFAULT_PROVIDER,
		dialect: "ga",
		openSocket: async (options: OpenSocketOptions) => {
			seen.push(options.dialect);
			throw new Error("stopped on purpose");
		},
		onEvent: () => {},
	});
	await assert.rejects(session.connect(), /stopped on purpose/);
	assert.deepEqual(seen, ["ga"]);
});

async function readySession() {
	const transport = fakeTransport();
	const { session, events } = makeSession(transport);
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;
	return { transport, session, events };
}

test("barge-in truncates emitted audio and does not send response.cancel", async () => {
	const { transport } = await readySession();
	// 48 000 bytes of PCM16 at 24 kHz = 1000 ms of audio.
	transport.message({ type: "response.output_audio.delta", item_id: "item_9", delta: Buffer.alloc(48_000).toString("base64") });
	transport.message({ type: "input_audio_buffer.speech_started" });
	const truncate = transport.sent.map((s) => JSON.parse(s)).find((e) => e.type === "conversation.item.truncate");
	assert.deepEqual(truncate, { type: "conversation.item.truncate", item_id: "item_9", content_index: 0, audio_end_ms: 1000 });
	assert.ok(!transport.sent.some((s) => s.includes("response.cancel")), "o servidor cancela sozinho (interrupt_response)");
});

test("barge-in with no emitted audio does not truncate", async () => {
	const { transport } = await readySession();
	const before = transport.sent.length;
	transport.message({ type: "input_audio_buffer.speech_started" });
	assert.equal(transport.sent.length, before);
});

test("response.create while active is deferred until response.done (queue of 1)", async () => {
	const { transport, session } = await readySession();
	transport.message({ type: "response.created" });
	const before = transport.sent.length;
	session.createResponse();
	assert.equal(transport.sent.length, before, "does not create a parallel response");
	transport.message({ type: "response.done" });
	const next = transport.sent.slice(before).map((s) => JSON.parse(s));
	assert.deepEqual(next, [{ type: "response.create" }]);
});

test("function_call_output e item [BACKEND] seguem o formato esperado", async () => {
	const { transport, session } = await readySession();
	const before = transport.sent.length;
	session.functionCallOutput("call_1", "ok");
	session.backendItem("resultado");
	const [out, backend] = transport.sent.slice(before).map((s) => JSON.parse(s));
	assert.deepEqual(out, { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "ok" } });
	assert.equal(backend.item.role, "user");
	assert.equal(backend.item.content[0].text, "[BACKEND] resultado");
});

test("commit envia input_audio_buffer.commit so quando pronto", async () => {
	const transport = fakeTransport();
	const { session } = makeSession(transport);
	void session.connect().catch(() => {});
	session.commit();
	assert.equal(transport.sent.length, 0, "nada antes de pronto");
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	session.commit();
	const events = transport.sent.map((s) => JSON.parse(s));
	assert.deepEqual(events.at(-1), { type: "input_audio_buffer.commit" });
});

test("commitAndRespond envia commit e response.create nessa ordem", async () => {
	const { transport, session } = await readySession();
	const before = transport.sent.length;
	session.commitAndRespond();
	const sent = transport.sent.slice(before).map((s) => JSON.parse(s));
	assert.deepEqual(sent, [{ type: "input_audio_buffer.commit" }, { type: "response.create" }]);
});

test("commitAndRespond com commitResponse=false envia so o commit", async () => {
	const transport = fakeTransport();
	const events: VoiceEvent[] = [];
	const session = new RealtimeSession({
		apiKey: "test-key", baseUrl: "https://api.openai.com/v1",
		settings: { ...DEFAULT_PROVIDER, vad: { ...DEFAULT_PROVIDER.vad, engine: "rms", commitResponse: false } },
		openSocket: transport.openSocket,
		onEvent: (e) => events.push(e),
	});
	const connecting = session.connect();
	await tick();
	transport.open();
	transport.message({ type: "session.updated" });
	await connecting;
	const before = transport.sent.length;
	session.commitAndRespond();
	const sent = transport.sent.slice(before).map((s) => JSON.parse(s));
	assert.deepEqual(sent, [{ type: "input_audio_buffer.commit" }]);
});
