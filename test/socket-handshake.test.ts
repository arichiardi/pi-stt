/**
 * Regression: the handshake sent `OpenAI-Beta: realtime=v1` even on the GA dialect.
 * The API rejects it with "The Realtime Beta API is no longer supported".
 * Run: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandshakeHeaders, buildSubprotocols } from "../src/socket.ts";

test("GA: handshake does not send beta header", () => {
	const headers = buildHandshakeHeaders("test-key", "ga");
	assert.equal(headers.Authorization, "Bearer test-key");
	assert.equal("OpenAI-Beta" in headers, false);
});

test("beta: keeps beta header for the legacy endpoint", () => {
	const headers = buildHandshakeHeaders("test-key", "beta");
	assert.equal(headers["OpenAI-Beta"], "realtime=v1");
});

test("GA subprotocol does not use openai-beta.realtime-v1", () => {
	const protocols = buildSubprotocols("secret", "ga");
	assert.deepEqual(protocols, ["realtime", "openai-insecure-api-key.secret"]);
});

test("beta subprotocol keeps the legacy marker", () => {
	assert.ok(buildSubprotocols("secret", "beta").includes("openai-beta.realtime-v1"));
});
