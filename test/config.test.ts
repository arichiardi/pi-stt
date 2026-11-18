/**
 * Config tests: ar-llm file path and VAD normalization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { agentDir, settingsPath, normalizeVad, DEFAULT_VAD, DEFAULT_SETTINGS } from "../src/config.ts";

test("agentDir segue PI_CODING_AGENT_DIR", () => {
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

test("engine default e off (OpenAI mantem server VAD)", () => {
	assert.equal(DEFAULT_VAD.engine, "off");
	assert.equal(DEFAULT_SETTINGS.vad.engine, "off");
});

test("normalizeVad mescla por cima dos defaults", () => {
	const v = normalizeVad({ engine: "webrtc_fvad", onsetMs: 40 });
	assert.equal(v.engine, "webrtc_fvad");
	assert.equal(v.onsetMs, 40);
	assert.equal(v.hangoverMs, DEFAULT_VAD.hangoverMs);
	assert.equal(v.prefillMs, DEFAULT_VAD.prefillMs);
	assert.equal(v.commitResponse, DEFAULT_VAD.commitResponse);
});

test("normalizeVad limita gamas e rejeita engine invalida", () => {
	const v = normalizeVad({ engine: "nonsense" as never, onsetMs: 9999, hangoverMs: 0, prefillMs: -5 });
	assert.equal(v.engine, DEFAULT_VAD.engine, "engine invalida cai no default");
	assert.equal(v.onsetMs, 200);
	assert.equal(v.hangoverMs, 200);
	assert.equal(v.prefillMs, 0);
});

test("normalizeVad sem entrada devolve defaults", () => {
	assert.deepEqual(normalizeVad(), DEFAULT_VAD);
});
