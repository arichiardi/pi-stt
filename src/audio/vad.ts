/**
 * Client side VAD (Voice Activity Detection).
 *
 * Decides the turn boundary on the client when the server has no VAD of its own
 * (llama.cpp `/v1/realtime` reports `turn_detection: null`). Each 20 ms capture
 * frame enters the `SpeechGate`; the gate emits `speechStarted` and
 * `speechEnded`. `speechEnded` triggers `input_audio_buffer.commit` in the session.
 *
 * Primary engine: `@ozymandiasthegreat/vad` (libfvad, WebRTC VAD GMM, WASM).
 * Backup engine: RMS gate in pure TS, no dependency. The primary engine falls
 * back to the backup with a warning if the WASM does not load. Never locks the mic.
 *
 * Credits (reference, nothing embedded):
 * - `earendil-works/pi-voice` `src/vad.ts`: shape of `SpeechGate`, fail-open.
 * - `sfgartland/better-pi-voice` `src/backends/pause-detector.ts`: RMS logic.
 *
 * Layout note: this file lives in `src/audio/vad.ts` next to
 * `src/audio.ts`. Both coexist; imports use an explicit `.ts` extension.
 */

import { SAMPLE_RATE, FRAME_MS, type VadEngine, type VadMode } from "../config.ts";
import { rmsLevel, BYTES_PER_SAMPLE } from "../audio.ts";

export type { VadEngine, VadMode };

/** Native rate of WebRTC VAD (libfvad accepts 8/16/32/48 kHz). We score at 16 kHz. */
export const VAD_RATE = 16_000;
/** Duration of one WebRTC VAD frame: 10 ms. */
const VAD_FRAME_MS = 10;

/** Samples in one capture frame (20 ms) at the capture rate (24 kHz). */
const CAPTURE_SAMPLES = Math.round((SAMPLE_RATE * FRAME_MS) / 1000);
/** Samples of one capture frame resampled to the VAD rate (16 kHz). */
const CAPTURE_SAMPLES_16 = Math.round(CAPTURE_SAMPLES * (VAD_RATE / SAMPLE_RATE));
/** Samples in one native VAD frame (10 ms at 16 kHz). */
const VAD_SAMPLES = Math.round((VAD_RATE * VAD_FRAME_MS) / 1000);
/** How many native VAD frames fit in one capture frame (320/160 = 2). */
export const SUBFRAMES_PER_CAPTURE = CAPTURE_SAMPLES_16 / VAD_SAMPLES;

export type GatePhase = "silent" | "speaking";

export type GateEvent = { type: "speechStarted" } | { type: "speechEnded" };

export interface PushResult {
	frames: Buffer[];
	events: GateEvent[];
}

/** One frame already resampled to the VAD rate (PCM16LE mono, `VAD_SAMPLES` samples). */
export interface FrameScorer {
	readonly kind: Exclude<VadEngine, "server">;
	/** true when the frame contains speech. Must be sync and fast. */
	score(frame16: Buffer): boolean;
	dispose?(): void;
}

/**
 * Resamples 24 kHz -> 16 kHz by linear interpolation, with a continuous tail
 * between calls. One capture frame (480 samples) becomes 320 samples. The
 * fractional phase and the previous sample persist between calls so the frame
 * boundary does not create discontinuities.
 */
export function createResampler16(captureRate: number = SAMPLE_RATE, vadRate: number = VAD_RATE) {
	const step = captureRate / vadRate; // 24000/16000 = 1.5
	let frac = 0; // fractional position inside the next input frame
	return function resample(pcm24: Buffer): Buffer {
		const n = Math.floor(pcm24.length / BYTES_PER_SAMPLE);
		if (n === 0) return Buffer.alloc(0);
		const out: number[] = [];
		let idx = frac;
		while (idx < n) {
			const i = Math.floor(idx);
			const t = idx - i;
			const a = pcm24.readInt16LE(i * BYTES_PER_SAMPLE);
			const b = i + 1 < n ? pcm24.readInt16LE((i + 1) * BYTES_PER_SAMPLE) : a;
			out.push(Math.round(a + t * (b - a)));
			idx += step;
		}
		frac = idx - n; // remainder for the next frame (0 when n is a multiple of step)
		const buf = Buffer.alloc(out.length * BYTES_PER_SAMPLE);
		for (let i = 0; i < out.length; i++) buf.writeInt16LE(out[i], i * BYTES_PER_SAMPLE);
		return buf;
	};
}

/** RMS gate in pure TS. Adaptive noise floor, dual thresholds with hysteresis. */
export class RmsScorer implements FrameScorer {
	readonly kind = "rms" as const;
	private readonly window: number[] = [];
	private readonly windowSize: number;
	private readonly startMargin: number;
	private readonly stopMargin: number;
	private readonly calibrationFrames: number;
	private frames = 0;
	private voiced = false;

	constructor(options: Partial<RmsScorer> = {}) {
		this.windowSize = options.windowSize ?? 100; // ~2 s of 20 ms frames
		this.startMargin = options.startMargin ?? 0.03;
		this.stopMargin = options.stopMargin ?? 0.015;
		this.calibrationFrames = options.calibrationFrames ?? 100;
	}

	score(frame16: Buffer): boolean {
		const level = rmsLevel(frame16);
		this.frames++;
		this.window.push(level);
		if (this.window.length > this.windowSize) this.window.shift();
		if (this.frames <= this.calibrationFrames) return false; // calibration phase
		const floor = this.noiseFloor();
		const startThreshold = floor + this.startMargin;
		const stopThreshold = floor + this.stopMargin;
		if (this.voiced) {
			if (level < stopThreshold) this.voiced = false;
		} else if (level > startThreshold) {
			this.voiced = true;
		}
		return this.voiced;
	}

	/** Low percentile of the window: the noise floor. */
	private noiseFloor(): number {
		if (this.window.length === 0) return 0;
		const sorted = [...this.window].sort((a, b) => a - b);
		const idx = Math.floor(sorted.length * 0.2);
		return sorted[Math.min(idx, sorted.length - 1)];
	}
}

/**
 * WebRTC VAD scorer (libfvad). Wraps the WASM instance. Kept alive per session;
 * never rebuilt per frame. `dispose()` frees the WASM when exposed.
 */
export class WebRtcScorer implements FrameScorer {
	readonly kind = "fvad" as const;
	private readonly vad: { processBuffer(buffer: Buffer | ArrayBufferView): number };
	private readonly voiceTag: number;
	readonly counters = { voiced: 0, silence: 0, error: 0 };

	constructor(vad: { processBuffer(buffer: Buffer | ArrayBufferView): number }, voiceTag: number) {
		this.vad = vad;
		this.voiceTag = voiceTag;
	}

	score(frame16: Buffer): boolean {
		const tag = this.vad.processBuffer(frame16);
		if (tag === this.voiceTag) {
			this.counters.voiced++;
			return true;
		}
		this.counters.silence++;
		return false;
	}

	dispose(): void {
		const free = (this.vad as { destroy?: () => void; free?: () => void }).destroy
			?? (this.vad as { free?: () => void }).free;
		free?.call(this.vad);
	}
}

/**
 * Loads `@ozymandiasthegreat/vad`. Tries the ESM import; falls back to
 * `createRequire` (the `src/socket.ts` pattern) against argv[1] and the executable.
 * Returns the raw namespace; never throws to the caller (the caller handles the failure).
 */
export async function loadVadModule(): Promise<any> {
	try {
		return await import("@ozymandiasthegreat/vad");
	} catch {
		// fall through to the fallbacks
	}
	const { createRequire } = await import("node:module");
	const bases = [process.argv[1], process.execPath].filter((b): b is string => Boolean(b));
	let lastError: unknown;
	for (const base of bases) {
		try {
			const req = createRequire(base);
			return req("@ozymandiasthegreat/vad");
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`VAD module not found: ${(lastError as Error)?.message ?? "import failed"}`);
}

/** Builds a `FrameScorer` for the requested engine. WASM failure falls back to RMS. */
export async function createScorer(
	engine: VadEngine,
	mode: VadMode,
	onWarn: (message: string) => void = () => {},
	loader: () => Promise<any> = loadVadModule,
): Promise<FrameScorer | null> {
	if (engine === "server") return null;
	if (engine === "rms") return new RmsScorer();
	try {
		const mod = await loader();
		// The default export is an async function that resolves to the VAD constructor.
		const VADCtor = typeof mod.default === "function" ? await mod.default() : mod.default;
		const vadMode = mod.VADMode?.[mode.toUpperCase()] ?? mod.VADMode?.AGGRESSIVE;
		const vad = new VADCtor(vadMode, VAD_RATE);
		const voiceTag = mod.VADEvent?.VOICE ?? 2;
		return new WebRtcScorer(vad, voiceTag);
	} catch (error) {
		onWarn(`VAD: WASM indisponivel (${(error as Error).message}); usando gate RMS`);
		return new RmsScorer();
	}
}

export interface SpeechGateOptions {
	scorer: FrameScorer | null;
	onsetMs: number;
	hangoverMs: number;
	prefillMs: number;
	captureRate?: number;
	vadRate?: number;
	onWarn?: (message: string) => void;
}

/**
 * State machine with hysteresis and pre-roll. Takes 20 ms capture frames. Scores
 * 10 ms sub-frames at 16 kHz. Forwards whole frames, byte identical. Emits
 * `speechStarted` with the pre-roll and `speechEnded` once. `push()` never
 * throws: a scorer exception turns on fail-open (forward everything, warn once).
 * The `server` engine (null scorer) is a pass-through with no events.
 */
export class SpeechGate {
	readonly onsetFrames: number;
	readonly hangoverFrames: number;
	readonly prefillFrames: number;
	private readonly scorer: FrameScorer | null;
	private readonly captureRate: number;
	private readonly vadRate: number;
	private readonly onWarn: (message: string) => void;
	private resample: (pcm24: Buffer) => Buffer;
	private readonly subFramesPerCapture: number;
	private state: GatePhase = "silent";
	private onset = 0;
	private hangover = 0;
	private prefill: Buffer[] = [];
	private failOpen = false;
	private warned = false;

	constructor(options: SpeechGateOptions) {
		this.scorer = options.scorer;
		this.captureRate = options.captureRate ?? SAMPLE_RATE;
		this.vadRate = options.vadRate ?? VAD_RATE;
		this.onWarn = options.onWarn ?? (() => {});
		this.onsetFrames = Math.max(1, Math.ceil(options.onsetMs / FRAME_MS));
		this.hangoverFrames = Math.max(0, Math.ceil(options.hangoverMs / FRAME_MS));
		this.prefillFrames = Math.max(0, Math.ceil(options.prefillMs / FRAME_MS));
		const captureSamples = Math.round((this.captureRate * FRAME_MS) / 1000);
		const captureSamples16 = Math.round(captureSamples * (this.vadRate / this.captureRate));
		const vadSamples = Math.round((this.vadRate * VAD_FRAME_MS) / 1000);
		this.subFramesPerCapture = Math.max(1, Math.round(captureSamples16 / vadSamples));
		this.resample = createResampler16(this.captureRate, this.vadRate);
	}

	get phase(): GatePhase {
		return this.state;
	}

	get wasmFallback(): boolean {
		return this.failOpen;
	}

	/** Labels a capture frame: any 10 ms sub-frame with speech means voiced. */
	private label(pcm24: Buffer): boolean {
		if (!this.scorer) return true; // engine server: not used (pass-through branch)
		const pcm16 = this.resample(pcm24);
		const bytesPerSub = (pcm16.length / this.subFramesPerCapture) | 0;
		let voiced = false;
		for (let i = 0; i < this.subFramesPerCapture; i++) {
			const sub = pcm16.subarray(i * bytesPerSub, (i + 1) * bytesPerSub);
			if (sub.length && this.scorer.score(sub)) voiced = true;
		}
		return voiced;
	}

	push(captureFrame: Buffer): PushResult {
		if (this.failOpen) return { frames: [captureFrame], events: [] };
		if (!this.scorer) return { frames: [captureFrame], events: [] }; // engine server

		let label: boolean;
		try {
			label = this.label(captureFrame);
		} catch (error) {
			this.failOpen = true;
			if (!this.warned) {
				this.warned = true;
				this.onWarn(`VAD: pontuador falhou (${(error as Error).message}); encaminhando todo o audio`);
			}
			return { frames: [captureFrame], events: [] };
		}

		if (this.state === "silent") {
			if (!label) {
				this.onset = 0;
				this.pushPrefill(captureFrame);
				return { frames: [], events: [] };
			}
			this.onset++;
			if (this.onset < this.onsetFrames) {
				this.pushPrefill(captureFrame);
				return { frames: [], events: [] };
			}
			const drained = this.drainPrefill();
			this.state = "speaking";
			this.hangover = this.hangoverFrames;
			this.onset = 0;
			return { frames: [...drained, captureFrame], events: [{ type: "speechStarted" }] };
		}

		// speaking
		if (label) {
			this.hangover = this.hangoverFrames;
			return { frames: [captureFrame], events: [] };
		}
		if (this.hangover > 0) {
			this.hangover--;
			return { frames: [captureFrame], events: [] };
		}
		this.state = "silent";
		this.onset = 0;
		this.prefill = [];
		return { frames: [], events: [{ type: "speechEnded" }] };
	}

	/** Clears pre-roll, counters, state, and the resampler tail. Keeps fail-open. */
	reset(): void {
		this.state = "silent";
		this.onset = 0;
		this.hangover = 0;
		this.prefill = [];
		this.resample = createResampler16(this.captureRate, this.vadRate);
	}

	private pushPrefill(frame: Buffer): void {
		if (this.prefillFrames === 0) return;
		this.prefill.push(frame);
		if (this.prefill.length > this.prefillFrames) this.prefill.shift();
	}

	private drainPrefill(): Buffer[] {
		const drained = this.prefill;
		this.prefill = [];
		return drained;
	}

	dispose(): void {
		this.scorer?.dispose?.();
	}
}
