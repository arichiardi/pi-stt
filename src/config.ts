/**
 * Configuration for /stt-live.
 *
 * Named by provider. Each entry in the `providers` map is keyed by a pi
 * provider name (openai, llama.cpp, or a models.json key) and holds the
 * realtime voice settings for that provider: model, voice, and VAD.
 *
 * The active entry is pi's settings.json `defaultProvider`, matched against
 * the map keys. Falls back to the first key.
 *
 * stt.json format:
 * {
 *   "providers": {
 *     "openai":    { "model": "gpt-realtime-2.1-mini", "voice": "marin", "vad": { "engine": "off" } },
 *     "llama.cpp": { "model": "qwen2.5-omni-7b", "vad": { "engine": "webrtc_fvad" } }
 *   }
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// VAD
// ---------------------------------------------------------------------------

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

export const DEFAULT_VAD: VadSettings = {
	engine: "off",
	mode: "aggressive",
	onsetMs: 60,
	hangoverMs: 700,
	prefillMs: 450,
	commitResponse: true,
};

/** VAD defaults per provider (static). Overridable in the entry. */
export function vadDefaultsForProvider(provider: string): VadSettings {
	if (provider === "openai") return { ...DEFAULT_VAD, engine: "off" };
	return { ...DEFAULT_VAD, engine: "webrtc_fvad" };
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

// ---------------------------------------------------------------------------
// Audio constants
// ---------------------------------------------------------------------------

export const SAMPLE_RATE = 24_000;
/** Duration of each frame sent/consumed. 20 ms is the Opus frame size. */
export const FRAME_MS = 20;

// ---------------------------------------------------------------------------
// Provider entry types
// ---------------------------------------------------------------------------

/** Realtime voice settings for one provider (keyed by provider name). */
export interface SttEntry {
	/** Realtime model ID sent to the provider. */
	model: string;
	/** Voice spoken by the realtime model. */
	voice: VoiceName;
	/** Client-side VAD settings. */
	vad: VadSettings;
	/** Start muted (f9 unmutes). */
	muteOnStart: boolean;
}

export interface SttConfig {
	/** Provider name to voice settings. Key = pi provider name. */
	providers: Record<string, SttEntry>;
}

export interface ResolvedProvider {
	/** HTTP(S) base URL, e.g. "https://api.openai.com/v1". */
	baseUrl: string;
	/** API key for Authorization header. undefined for no-auth providers. */
	apiKey: string | undefined;
	/** Human-readable credential source for status display. */
	source: string;
}

export const DEFAULT_PROVIDER: SttEntry = {
	model: "gpt-realtime-2.1-mini",
	voice: "marin",
	vad: DEFAULT_VAD,
	muteOnStart: false,
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * pi agent root: `PI_CODING_AGENT_DIR` or `~/.config/pi/agent`.
 */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".config", "pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "ar-llm", "stt.json");
}

// ---------------------------------------------------------------------------
// Config load/save
// ---------------------------------------------------------------------------

export function loadConfig(): SttConfig {
	const path = settingsPath();
	if (!existsSync(path)) return { providers: { openai: { ...DEFAULT_PROVIDER, vad: { ...DEFAULT_VAD } } } };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SttConfig>;
		if (!raw.providers || Object.keys(raw.providers).length === 0) {
			return { providers: { openai: { ...DEFAULT_PROVIDER, vad: { ...DEFAULT_VAD } } } };
		}
		const providers: Record<string, SttEntry> = {};
		for (const [name, e] of Object.entries(raw.providers)) {
			providers[name] = {
				model: e.model || DEFAULT_PROVIDER.model,
				voice: VOICES.includes(e.voice as VoiceName) ? e.voice! : DEFAULT_PROVIDER.voice,
				vad: normalizeVad(e.vad),
				muteOnStart: typeof e.muteOnStart === "boolean" ? e.muteOnStart : false,
			};
		}
		return { providers };
	} catch {
		return { providers: { openai: { ...DEFAULT_PROVIDER, vad: { ...DEFAULT_VAD } } } };
	}
}

export function saveConfig(config: SttConfig): void {
	mkdirSync(join(agentDir(), "ar-llm"), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Active provider resolution
// ---------------------------------------------------------------------------

/**
 * Reads pi's settings.json to find the user's defaultProvider.
 */
export function piSettingsDefaultProvider(): string | undefined {
	const path = join(agentDir(), "settings.json");
	if (!existsSync(path)) return undefined;
	try {
		const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const dp = settings.defaultProvider;
		return typeof dp === "string" && dp ? dp : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Determines which provider is active.
 * Matches pi's defaultProvider against the map keys. Falls back to first key.
 */
export function activeProviderName(config: SttConfig): string {
	const dp = piSettingsDefaultProvider();
	if (dp && config.providers[dp]) return dp;
	return Object.keys(config.providers)[0];
}

export function activeProvider(config: SttConfig): SttEntry {
	return config.providers[activeProviderName(config)];
}

// ---------------------------------------------------------------------------
// Provider resolution (baseUrl + credential)
// ---------------------------------------------------------------------------

function readAuthJson(): Record<string, unknown> {
	const path = join(agentDir(), "auth.json");
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function readModelsJson(): Record<string, unknown> {
	const path = join(agentDir(), "models.json");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return (raw.providers ?? {}) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Resolves a $ENV_VAR style apiKey string from models.json. */
function resolveEnvInterpolation(value: string, env: NodeJS.ProcessEnv): string {
	if (value.startsWith("$")) {
		const varName = value.slice(1);
		return env[varName]?.trim() || "";
	}
	return value;
}

/**
 * Resolves a provider name to a baseUrl and apiKey.
 *
 * - "openai": hardcoded base, env/auth.json credential.
 * - "llama.cpp": from auth.json llama.cpp credential env.LLAMA_BASE_URL.
 * - other: from models.json providers[name].
 */
export function resolveProvider(name: string, env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
	// STT_API_KEY overrides all providers.
	const sttKey = env.STT_API_KEY?.trim();

	const auth = readAuthJson();

	if (name === "openai") {
		const baseUrl = "https://api.openai.com/v1";
		if (sttKey) return { baseUrl, apiKey: sttKey, source: "STT_API_KEY" };
		const fromEnv = env.OPENAI_API_KEY?.trim() || env.PI_VOICE_API_KEY?.trim();
		if (fromEnv) return { baseUrl, apiKey: fromEnv, source: "env" };
		const entry = (auth["openai"] ?? auth["openai-codex"]) as { key?: unknown; apiKey?: unknown } | undefined;
		const key = entry?.key ?? entry?.apiKey;
		if (typeof key === "string" && key.trim()) return { baseUrl, apiKey: key.trim(), source: "auth.json" };
		return { baseUrl, apiKey: undefined, source: "missing" };
	}

	if (name === "llama.cpp") {
		const entry = auth["llama.cpp"] as { key?: unknown; env?: Record<string, unknown> } | undefined;
		const serverUrl = (entry?.env?.LLAMA_BASE_URL as string)?.trim() || "http://127.0.0.1:8080";
		const normalized = serverUrl.replace(/\/+$/, "");
		const baseUrl = `${normalized}/v1`;
		if (sttKey) return { baseUrl, apiKey: sttKey, source: "STT_API_KEY" };
		const key = entry?.key;
		if (typeof key === "string" && key.trim()) return { baseUrl, apiKey: key.trim(), source: "auth.json" };
		const envKey = env.LLAMA_API_KEY?.trim();
		if (envKey) return { baseUrl, apiKey: envKey, source: "LLAMA_API_KEY" };
		return { baseUrl, apiKey: "local", source: "llama.cpp (no key)" };
	}

	// Custom provider from models.json.
	const models = readModelsJson();
	const providerDef = models[name] as Record<string, unknown> | undefined;
	if (!providerDef) {
		return { baseUrl: "", apiKey: sttKey || undefined, source: `models.json: missing "${name}"` };
	}
	const baseUrl = (providerDef.baseUrl as string)?.replace(/\/+$/, "") || "";
	if (sttKey) return { baseUrl, apiKey: sttKey, source: "STT_API_KEY" };
	const rawKey = providerDef.apiKey as string | undefined;
	if (rawKey) {
		const resolved = resolveEnvInterpolation(rawKey, env);
		if (resolved) return { baseUrl, apiKey: resolved, source: `models.json:${name}` };
	}
	// Also check auth.json for this provider name.
	const authEntry = auth[name] as { key?: unknown } | undefined;
	if (typeof authEntry?.key === "string" && authEntry.key.trim()) {
		return { baseUrl, apiKey: authEntry.key.trim(), source: `auth.json:${name}` };
	}
	return { baseUrl, apiKey: undefined, source: `models.json:${name} (no key)` };
}

// ---------------------------------------------------------------------------
// Provider listing (for /stt-provider picker)
// ---------------------------------------------------------------------------

/** Lists all providers the user has configured (auth.json + models.json). */
export function listAvailableProviders(): string[] {
	const names = new Set<string>();
	const auth = readAuthJson();
	for (const key of Object.keys(auth)) names.add(key);
	const models = readModelsJson();
	for (const key of Object.keys(models)) names.add(key);
	// Built-in providers that pi supports.
	names.add("openai");
	names.add("llama.cpp");
	return [...names].sort();
}
