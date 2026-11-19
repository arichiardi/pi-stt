/**
 * Config tests: ar-llm file path and VAD normalization.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { agentDir, settingsPath, normalizeVad, normalizeVadEngine, loadConfig, DEFAULT_VAD, DEFAULT_PROVIDER } from "../src/config.ts";

test("agentDir follows PI_CODING_AGENT_DIR", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";
	try {
		assert.equal(agentDir(), "/tmp/pi-agent-test");
		assert.equal(settingsPath(), join("/tmp/pi-agent-test", "ar-llm", "stt.json"));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});

test("default engine is off (OpenAI keeps server VAD)", () => {
	assert.equal(DEFAULT_VAD.engine, "server");
	assert.equal(DEFAULT_PROVIDER.vad.engine, "server");
});

test("normalizeVad merges on top of defaults", () => {
	const v = normalizeVad({ engine: "fvad", onsetMs: 40 });
	assert.equal(v.engine, "fvad");
	assert.equal(v.onsetMs, 40);
	assert.equal(v.hangoverMs, DEFAULT_VAD.hangoverMs);
	assert.equal(v.prefillMs, DEFAULT_VAD.prefillMs);
	assert.equal(v.commitResponse, DEFAULT_VAD.commitResponse);
});

test("normalizeVad clamps ranges and rejects invalid engine", () => {
	const v = normalizeVad({ engine: "nonsense" as never, onsetMs: 9999, hangoverMs: 0, prefillMs: -5 });
	assert.equal(v.engine, DEFAULT_VAD.engine, "invalid engine falls back to default");
	assert.equal(v.onsetMs, 200);
	assert.equal(v.hangoverMs, 200);
	assert.equal(v.prefillMs, 0);
});

test("normalizeVad with no input returns defaults", () => {
	assert.deepEqual(normalizeVad(), DEFAULT_VAD);
});

test("loadConfig keeps voice in list, falls back to first when absent", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(`${tmpdir()}/pi-stt-voices-`);
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		mkdirSync(join(dir, "ar-llm"), { recursive: true });
		writeFileSync(join(dir, "ar-llm", "stt.json"), JSON.stringify({ providers: { p: { model: "m", voice: "nope", voices: ["female", "male"], language: "en", prompt: "  Be terse.  " } } }));
		const cfg = loadConfig();
		assert.deepEqual(cfg.providers.p!.voices, ["female", "male"]);
		assert.equal(cfg.providers.p!.voice, "female");
		assert.equal(cfg.providers.p!.language, "en");
		assert.equal(cfg.providers.p!.prompt, "  Be terse.  ");
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizeVadEngine maps legacy aliases and rejects junk", () => {
	assert.equal(normalizeVadEngine("off"), "server");
	assert.equal(normalizeVadEngine("webrtc_fvad"), "fvad");
	assert.equal(normalizeVadEngine("fvad"), "fvad");
	assert.equal(normalizeVadEngine("server"), "server");
	assert.equal(normalizeVadEngine("nonsense"), undefined);
});
