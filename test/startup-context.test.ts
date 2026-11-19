/**
 * Startup context (realtime_context.rs): budget and chronological order.
 * Run: node --test --experimental-strip-types ~/.pi/agent/extensions/voice/tests/startup-context.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStartupContext, recentTurns } from "../src/startup-context.ts";

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("ignores entries that are not user or agent text", () => {
	const turns = recentTurns([
		{ type: "model_change" },
		msg("user", "oi"),
		msg("toolResult", "output"),
		msg("assistant", [{ type: "toolCall", name: "bash" }, { type: "text", text: "pronto" }]),
	]);
	assert.deepEqual(turns, [
		{ role: "USER", text: "oi" },
		{ role: "ASSISTANT", text: "pronto" },
	]);
});

test("respects the budget and keeps chronological order of recent turns", () => {
	const branch = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? "assistant" : "user", `turno ${i} ` + "x".repeat(2000)));
	const context = buildStartupContext(branch, "/w", 1_000);
	assert.ok(context.length / 4 <= 1_050, "within budget (with header slack)");
	assert.ok(context.includes("turno 49"), "o mais recente entra");
	assert.ok(!context.includes("turno 0 "), "o mais antigo sai");
	const lines = context.split("\n").filter((l) => /turno \d+/.test(l));
	const numbers = lines.map((l) => Number(/turno (\d+)/.exec(l)![1]));
	assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
});

test("with no turns, still reports the working directory", () => {
	const context = buildStartupContext([], "/w");
	assert.match(context, /Working directory: \/w/);
	assert.ok(!context.includes("Recent turns"));
});
