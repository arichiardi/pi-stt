/**
 * Configuration for /stt-live.
 *
 * Exposes the Realtime settings (`model`, `voice`, input/output devices) and
 * resolves the credential in precedence order.
 *
 * Divergence from the Codex design: it authenticates with `CodexAuth` (ChatGPT)
 * and uses `intent=quicksilver`. Here we use the public `/v1/realtime` API with
 * `OPENAI_API_KEY`, the only path available outside the Codex product.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** v1 catalog of Realtime API voices. */
export const VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"marin",
	"cedar",
	"sage",
	"shimmer",
	"verse",
] as const;

export type VoiceName = (typeof VOICES)[number];

/** Client-side VAD engine. `off` keeps the server VAD (OpenAI). */
export type VadEngine = "webrtc_fvad" | "rms" | "off";
/** WebRTC VAD (libfvad) aggressiveness; ignored by the `rms` engine. */
export type VadMode = "normal" | "low_bitrate" | "aggressive" | "very_aggressive";

export interface VadSettings {
	/** Client-side speech detection engine. */
	engine: VadEngine;
	/** WebRTC VAD aggressiveness. */
	mode: VadMode;
	/** Continuous speech for these ms to open a turn. */
	onsetMs: number;
	/** Silence for these ms to close the turn (commit point). */
	hangoverMs: number;
	/** Pre-roll (ms) kept to not lose the first syllable. */
	prefillMs: number;
	/** Send `response.create` after `commit`. */
	commitResponse: boolean;
}

export const VAD_ENGINES: readonly VadEngine[] = ["webrtc_fvad", "rms", "off"];
export const VAD_MODES: readonly VadMode[] = ["normal", "low_bitrate", "aggressive", "very_aggressive"];

export interface VoiceSettings {
	/** Voice spoken by the realtime model. */
	voice: VoiceName;
	/** Realtime model; mini gives realtime voice at lower cost. */
	model: string;
	/** ALSA input name/device (`arecord -D`). */
	inputDevice?: string;
	/** ALSA output name/device (`aplay -D`). */
	outputDevice?: string;
	/** Start muted (f9 unmutes). */
	muteOnStart: boolean;
	/** Client-side VAD: turn boundary decided in the client. */
	vad: VadSettings;
}

export const DEFAULT_VAD: VadSettings = {
	engine: "off",
	mode: "aggressive",
	onsetMs: 60,
	hangoverMs: 700,
	prefillMs: 450,
	commitResponse: true,
};

export const DEFAULT_SETTINGS: VoiceSettings = {
	voice: "marin",
	model: "gpt-realtime-2.1-mini",
	inputDevice: undefined,
	outputDevice: undefined,
	muteOnStart: false,
	vad: DEFAULT_VAD,
};

export const SAMPLE_RATE = 24_000;
/** Duration of each frame sent/consumed. 20 ms is the Opus frame size. */
export const FRAME_MS = 20;

/**
 * pi agent root: `PI_CODING_AGENT_DIR` or `~/.config/pi/agent`. Follows the
 * pattern of the other `@ar-llm` packages (pi-plan-mode, pi-dir-providers). The
 * package config files live in `<agentDir>/ar-llm/`.
 */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".config", "pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "ar-llm", "stt.json");
}

export function loadSettings(): VoiceSettings {
	const path = settingsPath();
	if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VoiceSettings> & { vad?: Partial<VadSettings> };
		const settings: VoiceSettings = { ...DEFAULT_SETTINGS, ...raw };
		if (!VOICES.includes(settings.voice)) settings.voice = DEFAULT_SETTINGS.voice;
		settings.vad = normalizeVad(raw.vad);
		return settings;
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** Merge and clamp the VAD settings. Out-of-range values fall back to the default. */
export function normalizeVad(raw?: Partial<VadSettings>): VadSettings {
	const base = { ...DEFAULT_VAD };
	if (!raw) return base;
	if (raw.engine && VAD_ENGINES.includes(raw.engine)) base.engine = raw.engine;
	if (raw.mode && VAD_MODES.includes(raw.mode)) base.mode = raw.mode;
	base.onsetMs = clamp(raw.onsetMs, base.onsetMs, 20, 200);
	base.hangoverMs = clamp(raw.hangoverMs, base.hangoverMs, 200, 2000);
	base.prefillMs = clamp(raw.prefillMs, base.prefillMs, 0, 1000);
	if (typeof raw.commitResponse === "boolean") base.commitResponse = raw.commitResponse;
	return base;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export function saveSettings(settings: VoiceSettings): void {
	mkdirSync(join(agentDir(), "ar-llm"), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}

/**
 * API credential. Precedence: `OPENAI_API_KEY` → `PI_VOICE_API_KEY` →
 * the `openai` entry in `<agentDir>/auth.json` (the same file pi uses).
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env.OPENAI_API_KEY || env.PI_VOICE_API_KEY;
	if (fromEnv?.trim()) return fromEnv.trim();

	const authPath = join(agentDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		for (const provider of ["openai", "openai-codex"]) {
			const entry = auth[provider] as { key?: unknown; apiKey?: unknown } | undefined;
			const key = entry?.key ?? entry?.apiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		}
	} catch {
		// unreadable file: treat as missing
	}
	return undefined;
}

export const API_BASE = "https://api.openai.com/v1";
