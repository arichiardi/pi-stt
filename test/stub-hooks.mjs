// Resolution hook: maps the pi UI package to the test stub.
export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-tui") {
		return { url: new URL("./pi-tui-stub.mjs", import.meta.url).href, shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}
