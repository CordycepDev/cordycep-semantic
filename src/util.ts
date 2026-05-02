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
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return content;
	return content.slice(end + 4).replace(/^\s*\n/, "");
}

export function topFolder(vaultPath: string): string {
	const i = vaultPath.indexOf("/");
	return i < 0 ? "(root)" : vaultPath.slice(0, i);
}
