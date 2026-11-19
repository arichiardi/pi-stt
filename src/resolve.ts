/**
 * Generic resolution of optional runtime dependencies (`ws`, `@ozymandiasthegreat/vad`).
 *
 * pi loads this extension from an extensions directory, and its global launcher is
 * a bin symlink (for example `~/.node/bin/pi` -> `.../pi-coding-agent/dist/cli.js`).
 * `createRequire` resolves `node_modules` from the literal path it is given, so the
 * raw bin path and the `node` executable do not see the package's dependencies.
 *
 * The candidate bases below are all derived from runtime values. No absolute path is
 * hardcoded:
 *   - `process.argv[1]` and `process.execPath`
 *   - the symlink target of each (dereferenced with `realpathSync`)
 *   - this module's own URL (the extensions tree is a sibling of pi's node_modules)
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Base paths whose `node_modules` chain may contain the dependency. */
export function moduleCandidates(): string[] {
	const raw = [process.argv[1], process.execPath].filter((p): p is string => Boolean(p));
	const bases: string[] = [];
	for (const path of raw) {
		bases.push(path);
		try {
			// Dereference the global bin symlink into the package that ships the module.
			bases.push(realpathSync(path));
		} catch {
			// not a symlink; keep the raw path
		}
	}
	// The extension module URL: pi's extensions node_modules is a sibling of pi's.
	try {
		bases.push(fileURLToPath(import.meta.url));
	} catch {
		// not an ES module context
	}
	return bases;
}

/** `require` the module through each candidate base. Throws if none resolve. */
export function requireDependency(name: string): unknown {
	let lastError: unknown;
	for (const base of moduleCandidates()) {
		try {
			return createRequire(base)(name);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`module not found: ${name} (${(lastError as Error)?.message ?? "no candidate"}`);
}

/**
 * Load a module as ESM (`import()` resolves relative to this file, covering the
 * sibling case), then fall back to `requireDependency`. Returns the raw namespace.
 */
export async function importDependency(name: string): Promise<any> {
	try {
		return await import(name);
	} catch {
		// fall through to the require fallbacks
	}
	return requireDependency(name);
}
