/**
 * Voice <-> agent bridge: the text contract used in the handoff.
 *
 * Delegated turn input:
 *   <realtime_delegation>
 *     <input>request</input>
 *     <transcript_delta>…</transcript_delta>
 *   </realtime_delegation>
 */

import type { TextContent } from "@earendil-works/pi-ai";

const OPEN_TAG = "<realtime_delegation>";
const CLOSE_TAG = "</realtime_delegation>";

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Source of the delegated turn. */
export type DelegationSource = "handoff" | "transcript_tail_flush";

/** Builds the delegated turn from user speech (`context/realtime_delegation.rs`). */
export function wrapDelegation(input: string, transcriptDelta?: string, source: DelegationSource = "handoff"): string {
	const lines = [OPEN_TAG];
	if (source === "transcript_tail_flush") lines.push("  <source>transcript_tail_flush</source>");
	lines.push(`  <input>${escapeXml(input.trim())}</input>`);
	if (transcriptDelta?.trim()) {
		lines.push(`  <transcript_delta>${escapeXml(transcriptDelta.trim())}</transcript_delta>`);
	}
	lines.push(CLOSE_TAG);
	return lines.join("\n");
}

/** Extracts the request from a delegated turn; `undefined` if this is not a delegation. */
export function unwrapDelegation(text: string): string | undefined {
	const body = text.trim();
	if (!body.startsWith(OPEN_TAG) || !body.endsWith(CLOSE_TAG)) return undefined;
	const match = body.match(/<input>([\s\S]*?)<\/input>/);
	if (!match) return undefined;
	return unescapeXml(match[1]).trim();
}

/** Transcript excerpt that accompanies the delegation (optional). */
export function delegationTranscript(text: string): string | undefined {
	const match = text.match(/<transcript_delta>([\s\S]*?)<\/transcript_delta>/);
	if (!match) return undefined;
	return unescapeXml(match[1]).trim() || undefined;
}

/**
 * Last assistant text in a run, ignoring reasoning blocks.
 * Matches the FinalAnswer phase that is spoken aloud: reasoning and
 * commentary are never read aloud.
 */
export function finalAnswerText(
	messages: readonly { role: string; content: unknown }[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim() || undefined;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((block): block is TextContent => (block as TextContent)?.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

/** `background_agent` return when the task finishes (V2, `REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT`). */
export const HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";

/** `background_agent` return when the request steers an active task (`REALTIME_V2_STEER_ACKNOWLEDGEMENT`). */
export const STEER_ACK = "This was sent to steer the previous background agent task.";
