/**
 * VAD gate tests: state machine (onset, hangover, pre-roll),
 * 24->16 kHz resampler, RMS scorer, fail-open, off engine.
 * WASM (libfvad) is injected; nothing here loads WASM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RmsScorer,
	SpeechGate,
	SUBFRAMES_PER_CAPTURE,
	createResampler16,
	createScorer,
	type FrameScorer,
} from "../src/audio/vad.ts";
import { FRAME_BYTES } from "../src/audio.ts";

/** 20 ms capture frame with a marker at the start (to compare bytes). */
function markerFrame(index: number): Buffer {
	const frame = Buffer.alloc(FRAME_BYTES);
	frame.writeInt16LE(index, 0);
	return frame;
}

/** 20 ms capture frame: 220 Hz sine tone at the given amplitude. */
function toneFrame(amplitude: number, samples = 480): Buffer {
	const frame = Buffer.alloc(samples * 2);
	const value = Math.round(amplitude * 32767);
	for (let i = 0; i < samples; i++) {
		const s = Math.round(value * Math.sin((2 * Math.PI * 220 * i) / 24000));
		frame.writeInt16LE(s, i * 2);
	}
	return frame;
}

/** Silent capture frame. */
function silentFrame(samples = 480): Buffer {
	return Buffer.alloc(samples * 2);
}

/**
 * Scripted scorer: each capture frame consumes SUBFRAMES_PER_CAPTURE
 * score calls; the label for frame i is `labels[i]`. Ignores the content.
 */
function scriptedScorer(labels: boolean[]): FrameScorer {
	let calls = 0;
	return {
		kind: "rms",
		score(): boolean {
			const idx = Math.floor(calls / SUBFRAMES_PER_CAPTURE);
			calls++;
			return labels[idx] ?? false;
		},
	};
}

function gateFor(labels: boolean[], opts: { onsetMs?: number; hangoverMs?: number; prefillMs?: number } = {}) {
	return new SpeechGate({
		scorer: scriptedScorer(labels),
		onsetMs: opts.onsetMs ?? 40,
		hangoverMs: opts.hangoverMs ?? 100,
		prefillMs: opts.prefillMs ?? 0,
	});
}

test("onset: precisa de N frames falados para abrir o turno", () => {
	const gate = gateFor([true, true], { onsetMs: 40 }); // onsetFrames = 2
	const first = gate.push(markerFrame(0));
	assert.deepEqual(first.events, [], "um frame falado nao abre");
	const second = gate.push(markerFrame(1));
	assert.deepEqual(second.events, [{ type: "speechStarted" }], "o segundo frame abre");
});

test("onset: um clique isolado nunca abre o turno", () => {
	const gate = gateFor([false, true, false, false], { onsetMs: 60 }); // onsetFrames = 3
	for (let i = 0; i < 4; i++) {
		const result = gate.push(markerFrame(i));
		assert.equal(result.events.filter((e) => e.type === "speechStarted").length, 0);
	}
});

test("hangover: 5 frames silenciosos mantem aberto, o 6o fecha (uma vez)", () => {
	// speaking, hangoverFrames = 5 (hangoverMs = 100)
	const gate = new SpeechGate({
		scorer: scriptedScorer([true, false, false, false, false, false, false]),
		onsetMs: 20,
		hangoverMs: 100,
		prefillMs: 0,
	});
	gate.push(markerFrame(0)); // opens
	let ended = 0;
	for (let i = 1; i < 7; i++) {
		const result = gate.push(markerFrame(i));
		ended += result.events.filter((e) => e.type === "speechEnded").length;
	}
	assert.equal(ended, 1, "fecha exatamente uma vez");
});

test("hangover: fala durante a janela reinicia a contagem", () => {
	const gate = new SpeechGate({
		scorer: scriptedScorer([true, false, false, false, true, false, false, false, false, false, false, false]),
		onsetMs: 20,
		hangoverMs: 100, // 5 frames
		prefillMs: 0,
	});
	gate.push(markerFrame(0)); // opens
	const closes: number[] = [];
	for (let i = 1; i < 12; i++) {
		const result = gate.push(markerFrame(i));
		if (result.events.some((e) => e.type === "speechEnded")) closes.push(i);
	}
	// Speech on frame 4 restarts the count; the 5 frame window closes on frame 10 (4+1+5).
	assert.deepEqual(closes, [10], "fecha so depois de 5 frames de silencio apos a ultima fala");
});

test("pre-roll + contiguidade: nenhuma palavra perdida no inicio", () => {
	const gate = new SpeechGate({
		scorer: scriptedScorer([false, false, true, true]),
		onsetMs: 20,
		hangoverMs: 100,
		prefillMs: 2000, // covers the whole silent prefix
	});
	const input = [markerFrame(0), markerFrame(1), markerFrame(2), markerFrame(3)];
	const out: Buffer[] = [];
	for (const frame of input) {
		const { frames } = gate.push(frame);
		out.push(...frames);
	}
	assert.deepEqual(
		Buffer.concat(out),
		Buffer.concat(input),
		"saida concatena exatamente o prefixo de entrada",
	);
});

test("nenhum frame e encaminhado depois de speechEnded", () => {
	const gate = new SpeechGate({
		scorer: scriptedScorer([true, false, false, false, false, false]),
		onsetMs: 20,
		hangoverMs: 40, // 2 frames
		prefillMs: 0,
	});
	gate.push(markerFrame(0)); // opens
	for (let i = 1; i <= 3; i++) gate.push(markerFrame(i)); // closes on frame 3
	const after = gate.push(markerFrame(4));
	assert.deepEqual(after.frames, [], "nada apos o commit point");
});

test("dois turnos em um gate: abre, fecha, abre", () => {
	const labels = [
		true, // 0 opens
		true, // 1
		false, false, false, false, false, false, // 2..7 close (hangover 100ms = 5)
		true, true, true, // 8..10 opens again
	];
	const gate = new SpeechGate({ scorer: scriptedScorer(labels), onsetMs: 40, hangoverMs: 100, prefillMs: 0 });
	const events: string[] = [];
	for (let i = 0; i < labels.length; i++) {
		for (const e of gate.push(markerFrame(i)).events) events.push(e.type);
	}
	assert.deepEqual(events, ["speechStarted", "speechEnded", "speechStarted"]);
});

test("reset() a meio do turno limpa pre-roll e estado; nenhum evento no reset", () => {
	const gate = new SpeechGate({
		scorer: scriptedScorer([false, true, true]),
		onsetMs: 20,
		hangoverMs: 100,
		prefillMs: 2000,
	});
	gate.push(markerFrame(0)); // pre-roll builds up
	gate.reset();
	assert.equal(gate.phase, "silent");
	const after = gate.push(markerFrame(1));
	// On opens on the first spoken frame; the pre-reset frame (index 0) does not leak.
	assert.equal(after.frames.length, 1, "so o frame atual abre o turno");
	assert.equal(after.frames[0].readInt16LE(0), 1, "pre-roll pre-reset nao vaza");
	assert.deepEqual(after.events, [{ type: "speechStarted" }]);
});

test("fail-open: pontuador que lanca => encaminha tudo, avisa uma vez", () => {
	let warns = 0;
	const boom: FrameScorer = {
		kind: "rms",
		score(): boolean {
			throw new Error("boom");
		},
	};
	const gate = new SpeechGate({ scorer: boom, onsetMs: 40, hangoverMs: 100, prefillMs: 0, onWarn: () => warns++ });
	const a = gate.push(markerFrame(0));
	const b = gate.push(markerFrame(1));
	assert.deepEqual(a.frames.length, 1, "frame encaminhado");
	assert.deepEqual(b.frames.length, 1, "frame encaminhado (fail-open)");
	assert.deepEqual(a.events, []);
	assert.equal(warns, 1, "um unico aviso");
});

test("motor off: passa-tudo, zero eventos, stream byte-identico", async () => {
	const scorer = await createScorer("off", "aggressive");
	assert.equal(scorer, null);
	const gate = new SpeechGate({ scorer: null, onsetMs: 40, hangoverMs: 100, prefillMs: 0 });
	const input = [markerFrame(0), markerFrame(1), markerFrame(2)];
	const out: Buffer[] = [];
	const events: number = 0;
	for (const frame of input) {
		const r = gate.push(frame);
		out.push(...r.frames);
		assert.equal(r.events.length, 0);
	}
	assert.equal(events, 0);
	assert.deepEqual(Buffer.concat(out), Buffer.concat(input));
});

test("createScorer rms devolve RmsScorer; loader que lanca cai para RMS com aviso", async () => {
	const rms = await createScorer("rms", "aggressive");
	assert.equal(rms?.kind, "rms");
	// Injected loader that throws => RMS fallback with a warning (deterministic, no WASM)
	let warned = "";
	const boom = async () => {
		throw new Error("no wasm");
	};
	const primary = await createScorer("webrtc_fvad", "aggressive", (m) => (warned = m), boom);
	assert.equal(primary?.kind, "rms", "fallback RMS quando o loader lanca");
	assert.match(warned, /WASM/);
});

test("RMS: silencia nao e falada, senoide alta e falada apos calibracao", () => {
	const scorer = new RmsScorer({ calibrationFrames: 4 });
	for (let i = 0; i < 4; i++) assert.equal(scorer.score(silentFrame(160)), false, "calibracao silenciosa");
	// Calibration done: silence stays non-speech
	assert.equal(scorer.score(silentFrame(160)), false);
	// A loud sine tone opens
	assert.equal(scorer.score(toneFrame(0.3, 160)), true, "tom alto deve ser falado");
});

test("RMS: histerese, limiar de inicio acima do limiar de paragem", () => {
	const scorer = new RmsScorer({ calibrationFrames: 2, startMargin: 0.05, stopMargin: 0.01 });
	for (let i = 0; i < 2; i++) scorer.score(silentFrame(160));
	// Mid level above startMargin opens
	assert.equal(scorer.score(toneFrame(0.3, 160)), true);
});

test("remostador 24->16: 480 amostras viram 320; cauda continua entre chamadas", () => {
	const resample = createResampler16(24000, 16000);
	const frame = toneFrame(0.3, 480);
	const first = resample(frame);
	assert.equal(first.length / 2, 320, "um frame de captura vira 320 amostras a 16 kHz");
	const second = resample(frame);
	assert.equal(second.length / 2, 320, "o segundo frame vira 320 amostras");
});

test("remostador preserva um sinal constante (nivel medio)", () => {
	const resample = createResampler16(24000, 16000);
	const frame = Buffer.alloc(480 * 2);
	for (let i = 0; i < 480; i++) frame.writeInt16LE(1000, i * 2);
	const out = resample(frame);
	for (let i = 0; i < out.length / 2; i++) assert.equal(out.readInt16LE(i * 2), 1000);
});
