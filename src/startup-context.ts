/**
 * Realtime session startup context.
 *
 * Mirrors the Codex realtime design. At start, it assembles the recent thread
 * turns and the workspace, with a budget of 5300 tokens. Here the "thread" is
 * the active branch of the pi session. Tokens are estimated by characters / 4.
 */

export const STARTUP_CONTEXT_TOKEN_BUDGET = 5_300;
/** Per-turn cap. */
export const TURN_TOKEN_BUDGET = 400;

export interface BranchEntry {
	type: string;
	message?: { role?: string; content?: unknown };
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

function truncateToTokens(text: string, budget: number): string {
	const max = budget * 4;
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** user/assistant turns of the branch, oldest to newest, without tool blocks. */
export function recentTurns(branch: readonly BranchEntry[]): Array<{ role: "USER" | "ASSISTANT"; text: string }> {
	const turns: Array<{ role: "USER" | "ASSISTANT"; text: string }> = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(entry.message?.content);
		if (!text) continue;
		turns.push({ role: role === "user" ? "USER" : "ASSISTANT", text });
	}
	return turns;
}

/**
 * Builds the context block. Fills from the newest turn backward up to the
 * budget; then renders in chronological order.
 */
export function buildStartupContext(
	branch: readonly BranchEntry[],
	cwd: string,
	budget = STARTUP_CONTEXT_TOKEN_BUDGET,
): string {
	const header = [
		"Contexto desta sessão de voz (montado ao iniciar a conversa a partir dos turnos recentes do agente e do diretório de trabalho).",
		`Diretório de trabalho: ${cwd}`,
	];
	let remaining = budget - approxTokens(header.join("\n"));
	const picked: string[] = [];
	const turns = recentTurns(branch);
	for (let i = turns.length - 1; i >= 0 && remaining > 0; i--) {
		const turn = turns[i];
		const line = `[${turn.role}] ${truncateToTokens(turn.text, Math.min(TURN_TOKEN_BUDGET, remaining))}`;
		const cost = approxTokens(line);
		if (cost > remaining) break;
		picked.push(line);
		remaining -= cost;
	}
	if (picked.length === 0) return header.join("\n");
	return [...header, "Turnos recentes (do mais antigo ao mais recente):", ...picked.reverse()].join("\n");
}
