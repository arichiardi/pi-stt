/**
 * Voice previews for the `/stt-live settings` picker.
 *
 * Generates a short sample per voice via `/v1/audio/speech` (PCM 24 kHz mono,
 * the same format as the player) and caches it under `<agentDir>/voice/previews/`.
 * Generation runs only the first time a voice is heard; after that it reads from disk.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { playBackend } from "./audio.ts";
import { agentDir } from "./config.ts";

const TTS_API_BASE = "https://api.openai.com/v1";

export const PREVIEW_MODEL = "gpt-4o-mini-tts";
export const PREVIEW_TEXT = "Hi, I am your voice assistant. This is how I sound.";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function previewDir(): string {
	return join(agentDir(), "voice", "previews");
}

export function previewPath(voice: string, dir: string = previewDir()): string {
	return join(dir, `${voice}.pcm`);
}

/**
 * Ensures the voice sample exists on disk and returns the path.
 * Writes a temp file and renames it, so the cache is never half written.
 * Throws (with the API message) if the voice cannot be generated.
 */
export async function ensurePreview(
	voice: string,
	apiKey: string,
	opts: { dir?: string; fetchImpl?: FetchLike } = {},
): Promise<string> {
	const dir = opts.dir ?? previewDir();
	const path = previewPath(voice, dir);
	if (existsSync(path)) return path;

	const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
	const res = await fetchImpl(`${TTS_API_BASE}/audio/speech`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: PREVIEW_MODEL,
			voice,
			input: PREVIEW_TEXT,
			response_format: "pcm",
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`voice preview ${voice} unavailable (HTTP ${res.status}) ${detail.slice(0, 200)}`);
	}
	const pcm = Buffer.from(await res.arrayBuffer());
	if (pcm.length === 0) throw new Error(`voice preview ${voice} returned empty audio`);

	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, pcm);
	renameSync(tmp, path);
	return path;
}

/**
 * Plays a PCM file through the output backend. Returns the process so the
 * caller can stop it when the cursor moves to another voice.
 */
export function playPreviewFile(path: string, platform: NodeJS.Platform = process.platform): ChildProcess {
	const backend = playBackend(platform);
	const child = spawn(backend.command, backend.args, { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin?.on("error", () => {});
	child.on("error", () => {});
	createReadStream(path).pipe(child.stdin!);
	return child;
}
