// Test stub for @earendil-works/pi-tui: only what is needed to import index.ts without the real UI.
export class Text {
	constructor(text) {
		this.text = text;
	}
}
export class SelectList {
	constructor(items) {
		this.items = items;
	}
}
export const truncateToWidth = (s) => s;
export const visibleWidth = (s) => String(s).length;
