/** Offline tests for voice previews: cache, API error, and request format. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePreview, previewPath, PREVIEW_MODEL } from "../src/previews.ts";

const pcmResponse = (bytes: number[], status = 200) =>
	new Response(Buffer.from(bytes), { status });

test("generates the preview once, caches it, and does not call the API again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-"));
	const calls: { url: string; body: any; auth: string | null }[] = [];
	const fetchImpl = async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("Authorization") });
		return pcmResponse([1, 2, 3, 4]);
	};
	const p1 = await ensurePreview("marin", "k-test", { dir, fetchImpl });
	const p2 = await ensurePreview("marin", "k-test", { dir, fetchImpl });
	assert.equal(p1, previewPath("marin", dir));
	assert.equal(p1, p2);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url.endsWith("/audio/speech"), true);
	assert.equal(calls[0].body.model, PREVIEW_MODEL);
	assert.equal(calls[0].body.voice, "marin");
	assert.equal(calls[0].body.response_format, "pcm");
	assert.equal(calls[0].auth, "Bearer k-test");
	assert.deepEqual([...readFileSync(p1)], [1, 2, 3, 4]);
	assert.deepEqual(readdirSync(dir), ["marin.pcm"]);
});

test("HTTP API error becomes a clear exception and leaves no cache", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-"));
	const fetchImpl = async () => new Response("voice not supported", { status: 400 });
	await assert.rejects(ensurePreview("cedar", "k", { dir, fetchImpl }), /cedar.*HTTP 400/);
	assert.equal(existsSync(previewPath("cedar", dir)), false);
	assert.deepEqual(readdirSync(dir), []);
});

test("empty response is rejected", async () => {
	const dir = mkdtempSync(join(tmpdir(), "vp-"));
	const fetchImpl = async () => pcmResponse([]);
	await assert.rejects(ensurePreview("ash", "k", { dir, fetchImpl }), /returned empty audio/);
});
