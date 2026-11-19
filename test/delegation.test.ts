/**
 * Offline tests of the voice/agent contract (same format as the handoff).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HANDOFF_COMPLETE_ACK,
	STEER_ACK,
	delegationTranscript,
	finalAnswerText,
	unwrapDelegation,
	wrapDelegation,
} from "../src/delegation.ts";

test("delegation produces the envelope", () => {
	assert.equal(
		wrapDelegation("run the tests"),
		"<realtime_delegation>\n  <input>run the tests</input>\n</realtime_delegation>",
	);
});

test("envelope round-trips", () => {
	const input = "fix the parser bug in ~/.pi/agent/extensions/voice/audio.ts";
	assert.equal(unwrapDelegation(wrapDelegation(input)), input);
});

test("XML characters survive the round-trip", () => {
	const input = 'compare <a> & <b> with "x" and <input>';
	const wrapped = wrapDelegation(input);
	assert.ok(wrapped.includes("&lt;a&gt;"));
	assert.equal(unwrapDelegation(wrapped), input);
});

test("transcript delta accompanies the delegation", () => {
	const wrapped = wrapDelegation("continue", "user: and now?\nassistant: okay");
	assert.equal(delegationTranscript(wrapped), "user: and now?\nassistant: okay");
	assert.ok(wrapped.indexOf("<input>") < wrapped.indexOf("<transcript_delta>"));
});

test("normal text is not a delegation", () => {
	assert.equal(unwrapDelegation("just a question"), undefined);
	assert.equal(unwrapDelegation("<realtime_delegation>\n  no input\n</realtime_delegation>"), undefined);
	assert.equal(delegationTranscript("no transcript"), undefined);
});

test("final answer ignores thinking and tool blocks", () => {
	const messages = [
		{ role: "user", content: "run the tests" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I will run them" },
				{ type: "text", text: "I ran the tests, all passed." },
				{ type: "toolCall", id: "1", name: "bash", arguments: {} },
			],
		},
	];
	assert.equal(finalAnswerText(messages), "I ran the tests, all passed.");
});

test("final answer uses the last assistant message", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "toolResult", content: [{ type: "text", text: "output" }] },
		{ role: "assistant", content: [{ type: "text", text: "second" }] },
	];
	assert.equal(finalAnswerText(messages), "second");
});

test("empty final answer returns undefined", () => {
	assert.equal(finalAnswerText([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }]), undefined);
	assert.equal(finalAnswerText([{ role: "user", content: "nothing" }]), undefined);
	assert.equal(finalAnswerText([]), undefined);
});

test("V2 return texts", () => {
	assert.equal(HANDOFF_COMPLETE_ACK, "Background agent finished. Use the preceding [BACKEND] messages as the result.");
	assert.equal(STEER_ACK, "This was sent to steer the previous background agent task.");
});

test("source transcript_tail_flush appears in the envelope", () => {
	const text = wrapDelegation("hi", undefined, "transcript_tail_flush");
	assert.ok(text.includes("<source>transcript_tail_flush</source>"));
	assert.equal(unwrapDelegation(text), "hi");
});
