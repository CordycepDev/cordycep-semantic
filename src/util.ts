export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
	let h: number | null = null;
	const wrapped = (...args: unknown[]) => {
		if (h !== null) window.clearTimeout(h);
		h = window.setTimeout(() => {
			h = null;
			fn(...args);
		}, ms);
	};
	return wrapped as unknown as T;
}

export function stripFrontmatter(content: string): string {
	// Opening fence must be a full line: "---" optionally followed by trailing
	// whitespace, then a newline.
	const open = /^---\s*\r?\n/.exec(content);
	if (!open) return content;
	const bodyStart = open[0].length;
	// Closing fence must also be a FULL line (anchored with /^...$/m). Using a
	// substring match (e.g. indexOf("\n---")) would wrongly truncate on body
	// horizontal rules or notes beginning with "---\ntext".
	const close = /^---\s*$/m.exec(content.slice(bodyStart));
	if (!close) return content;
	const end = bodyStart + close.index + close[0].length;
	return content.slice(end).replace(/^\s*\n/, "");
}

export function topFolder(vaultPath: string): string {
	const i = vaultPath.indexOf("/");
	return i < 0 ? "(root)" : vaultPath.slice(0, i);
}
