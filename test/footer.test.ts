/** Voice meter tests: perceptual scale, wave with history, fixed width. */
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./stub-hooks.mjs", import.meta.url);
const { createVoiceWidget, AutoGain, envelope, levelToUnit, meter, wave } = await import("../src/footer.ts");

test("typical speech (RMS 0.02-0.1) produces bars above the floor", () => {
	for (const rms of [0.02, 0.05, 0.1]) assert.ok(levelToUnit(rms) > 0.2, `rms ${rms}`);
});

test("silence stays at the floor and peak reaches the top", () => {
	assert.equal(levelToUnit(0), 0);
	assert.equal(levelToUnit(1), 1);
	assert.equal(meter(0), "▁▁▁▁▁▁▁▁▁▁");
});

test("wave has fixed width and shows history variation", () => {
	const bars = wave([0.1, 0.4, 0.9, 0.2, 0.6, 0.05].map(levelToUnit), 6);
	assert.equal([...bars].length, 6);
	assert.notEqual(new Set([...bars]).size, 1);
});

test("attack rises faster than release", () => {
	assert.ok(envelope(0, 1) - 0 > 0.5);
	assert.ok(1 - envelope(1, 0) < 0.5);
});

test("short history is left-padded with low bars", () => {
	assert.equal(wave([1], 6), "▁▁▁▁▁█");
});

test("auto gain fills the bar with a low mic and zeroes silence", () => {
	const gain = new AutoGain();
	let last = 0;
	for (let i = 0; i < 5; i++) last = gain.unit(0.004);
	assert.ok(last > 0.9, `got ${last}`);
	assert.equal(new AutoGain().unit(0.0005), 0);
});

test("widget discards old wave on mute and does not restore it on unmute", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let phase = "listening";
	let level = 0.04;
	const widget = createVoiceWidget(() => ({ phase, speaking: false, takeMicLevel: () => level }))(
		{ requestRender() {} }, { fg: (_color, text) => text },
	);
	try {
		t.mock.timers.tick(300);
		assert.match(widget.render(80).slice(1).join(""), /[▂-█]/);
		phase = "muted";
		level = 0;
		t.mock.timers.tick(30);
		phase = "listening";
		assert.doesNotMatch(widget.render(80).slice(1).join(""), /[▂-█]/);
	} finally { widget.dispose(); }
});

test("stop shortcut stays whole within the available width", () => {
	const widget = createVoiceWidget(() => ({ phase: "listening", speaking: false }))(
		{ requestRender() {} }, { fg: (_color, text) => text },
	);
	try {
		const header = widget.render(60)[0];
		assert.ok(header.length <= 60, `header occupies ${header.length} columns`);
		assert.ok(header.endsWith("/stt-live stop"));
	} finally { widget.dispose(); }
});

test("mic and bars share a row with a visible floor on silence", () => {
	const widget = createVoiceWidget(() => ({ phase: "listening", speaking: false }))(
		{ requestRender() {} }, { fg: (_color, text) => text },
	);
	try {
		const rows = widget.render(80);
		assert.equal(rows.length, 2);
		assert.match(rows[1], /mic  ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁/);
	} finally { widget.dispose(); }
});
