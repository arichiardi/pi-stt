/**
 * Realtime prompts copied from the Codex realtime templates.
 * Same text = same delegation policy. Update alongside the source.
 */
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();

/** Voice model policy (backend_prompt.md). `{{ user_first_name }}` is substituted. */
export function backendPrompt(userFirstName = "there"): string {
	return read("backend.md").replace("{{ user_first_name }}", userFirstName);
}

/** Developer message at conversation start (realtime_start.md). */
export const START_INSTRUCTIONS = read("start.md");

/** Developer message at close (realtime_end.md). */
export const END_INSTRUCTIONS = read("end.md");
