/**
 * Voice session view in the terminal.
 *
 * Status line for the voice session, with the pi agent as the subject:
 *   voice ● speaking              f9 mute    /stt-live stop
 *   mic ▅▆▇▅▃▂   pi ▁▂▃▅▇█
 *
 * Uses `setWidget` above the editor (animated, redraws each frame) plus `setStatus`
 * in the native footer, which still shows tokens/git/model.
 */

import type { Component, TUI, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VoicePhase = "starting" | "listening" | "muted" | "speaking" | "working" | "stopping";

export interface VoiceViewState {
	phase: VoicePhase;
	/** Peak mic RMS since the last read, 0..1 (consumed by the wave). */
	takeMicLevel?: () => number;
	/** RMS, 0..1, of the agent audio playing at time `at` (ms epoch). */
	outLevelAt?: (at: number) => number;
	/** Agent speech in progress. */
	speaking: boolean;
	/** Last recognized transcript (user or agent). */
	caption?: string;
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_MS = 30;
/** Bars per wave. */
const BARS = 10;
/** Meter floor (dB). Background noise stays below; typical speech rises to ~-20 dB. */
const FLOOR_DB = -55;
/** Meter ceiling (dB). Above this the bar is full. */
const CEIL_DB = -12;
/** Mic picked up (measured with user speech): noise ~-48..-43 dB, typical speech -45..-30 dB, peak ~-22 dB. */
const MIC_FLOOR_DB = -48;
const MIC_CEIL_DB = -28;
/** Fast rise (attack) and soft fall (release) so the bar does not jitter. */
const ATTACK = 0.75;
const RELEASE = 0.15;
/** Auto gain: minimum reference, peak decay per tick, and noise gate (RMS). */
const REF_MIN = 0.003;
const PEAK_DECAY = 0.985;
const GATE = 0.0015;

/** Maps linear RMS (0..1) to 0..1 on a log, perceptual scale. */
export function levelToUnit(level: number): number {
	return dbToUnit(level, FLOOR_DB, CEIL_DB);
}

/** Same log scale, with the mic floor and ceiling. */
export function micLevelToUnit(level: number): number {
	return dbToUnit(level, MIC_FLOOR_DB, MIC_CEIL_DB);
}

function dbToUnit(level: number, floorDb: number, ceilDb: number): number {
	if (!(level > 0)) return 0;
	const db = 20 * Math.log10(level);
	return Math.max(0, Math.min(1, (db - floorDb) / (ceilDb - floorDb)));
}

/**
 * Auto gain: normalizes by the recent peak, with slow decay.
 * The mic captures much less than the agent output; without this the bar stays low.
 * Below `gate` is silence.
 */
export class AutoGain {
	private peak = REF_MIN;
	unit(level: number): number {
		if (!(level > GATE)) {
			this.peak = Math.max(REF_MIN, this.peak * PEAK_DECAY);
			return 0;
		}
		this.peak = Math.max(level, this.peak * PEAK_DECAY, REF_MIN);
		return Math.min(1, level / this.peak);
	}
}

/** Smooths a level with fast attack and slow release. */
export function envelope(prev: number, target: number): number {
	const k = target > prev ? ATTACK : RELEASE;
	return prev + (target - prev) * k;
}

/**
 * Wave in two rows (16 levels): the top row fills only after the bottom row is full.
 * Returns [topRow, bottomRow], both `width` columns wide, newest on the right.
 */
export function waveRows(history: readonly number[], width: number): [string, string] {
	const start = Math.max(0, history.length - width);
	const pad = width - (history.length - start);
	let top = " ".repeat(pad);
	let bottom = " ".repeat(pad);
	for (let i = start; i < history.length; i++) {
		const total = Math.round(Math.max(0, Math.min(1, history[i])) * 16);
		const low = Math.min(8, total);
		const high = Math.max(0, total - 8);
		bottom += low === 0 ? " " : BLOCKS[low - 1];
		top += high === 0 ? " " : BLOCKS[high - 1];
	}
	return [top, bottom];
}

/** One bar per sample (0..1), newest on the right; pads the left with `▁`. */
export function wave(history: readonly number[], width: number): string {
	const start = Math.max(0, history.length - width);
	let out = BLOCKS[0].repeat(width - (history.length - start));
	for (let i = start; i < history.length; i++) {
		out += BLOCKS[Math.min(BLOCKS.length - 1, Math.round(history[i] * (BLOCKS.length - 1)))];
	}
	return out;
}

export function meter(level: number, width = BARS): string {
	return wave(Array.from({ length: width }, () => levelToUnit(level)), width);
}

function phaseLabel(state: VoiceViewState): string {
	switch (state.phase) {
		case "starting":
			return "connecting";
		case "listening":
			return "listening";
		case "muted":
			return "muted";
		case "speaking":
			return "speaking";
		case "working":
			return "delegated";
		case "stopping":
			return "stopping";
	}
}

export function statusText(state: VoiceViewState, theme: Theme): string {
	const dot = state.phase === "muted" ? theme.fg("dim", "○") : theme.fg("accent", "●");
	const caption = state.caption ? theme.fg("dim", ` ${truncateToWidth(state.caption, 60)}`) : "";
	return `${theme.fg("muted", "voice")} ${dot} ${theme.fg("dim", phaseLabel(state))}${caption}`;
}

class VoiceWidget implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly micHistory: number[] = [];
	private readonly outHistory: number[] = [];
	private micEnv = 0;
	private outEnv = 0;
	private readonly state: () => VoiceViewState;
	private readonly tui: TUI;
	private readonly theme: Theme;

	constructor(state: () => VoiceViewState, tui: TUI, theme: Theme) {
		this.state = state;
		this.tui = tui;
		this.theme = theme;
		this.timer = setInterval(() => {
			const s = this.state();
			const mic = s.takeMicLevel?.() ?? 0;
			// Maps absolute dB: normalizing by peak (AutoGain) flattens everything to a full bar.
			const micTarget = s.phase === "muted" ? 0 : micLevelToUnit(mic);
			const outTarget = s.speaking ? levelToUnit(s.outLevelAt?.(Date.now()) ?? 0) : 0;
			if (s.phase === "muted") {
				this.micHistory.length = 0;
				this.micEnv = 0;
			} else {
				this.micEnv = envelope(this.micEnv, micTarget);
			}
			this.outEnv = envelope(this.outEnv, outTarget);
			push(this.micHistory, this.micEnv);
			push(this.outHistory, this.outEnv);
			this.tui.requestRender();
		}, WAVE_MS);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		const state = this.state();
		const theme = this.theme;
		const dot = state.phase === "muted" ? theme.fg("dim", "○") : theme.fg("accent", "●");
		const label = theme.fg(state.phase === "muted" ? "dim" : "muted", ` ${phaseLabel(state)}`);

		const left = `${theme.fg("muted", "voice")} ${dot}${label}`;
		const hintMute = state.phase === "muted" ? "f9 unmute" : "f9 mute";
		const right =
			theme.fg("dim", hintMute) + theme.fg("muted", "   ") + theme.fg("dim", "/stt-live stop");
		const pad = " ".repeat(Math.max(1, width - 2 - visibleWidth(left) - visibleWidth(right)));

		const micMuted = state.phase === "muted";
		// Separate bars show the recent speech history.
		const micBars = wave(micMuted ? [] : this.micHistory, BARS).split("").join(" ");
		const mic = `${theme.fg("muted", "mic")}  ${theme.fg(micMuted ? "dim" : "accent", micBars)}`;
		const out = state.speaking
			? `    ${theme.fg("muted", "pi")}  ${theme.fg("accent", wave(this.outHistory, BARS).split("").join(" "))}`
			: "";
		const detail = `  ${mic}${out}`;
		const captionWidth = Math.max(0, width - visibleWidth(detail) - 3);
		const caption = state.caption && captionWidth > 0
			? theme.fg("dim", `   ${truncateToWidth(state.caption, captionWidth)}`)
			: "";

		return [
			truncateToWidth(`  ${left}${pad}${right}`, width),
			truncateToWidth(`${detail}${caption}`, width),
		];
	}
}

function push(history: number[], value: number): void {
	history.push(value);
	if (history.length > BARS) history.shift();
}

export function createVoiceWidget(state: () => VoiceViewState) {
	return (tui: TUI, theme: Theme): Component & { dispose?(): void } =>
		new VoiceWidget(state, tui, theme);
}
