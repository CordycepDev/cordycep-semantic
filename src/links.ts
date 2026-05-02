import { App, TFile, CachedMetadata } from "obsidian";

export interface LinkContext {
	linkedPaths: Set<string>;
	aliases: string[];
	title: string;
}

// Forward links: notes the given file explicitly links to (resolved by Obsidian).
// Backlinks: notes that explicitly link to this file.
// Aliases: declared in the file's YAML frontmatter (`aliases:`).
export function getLinkContext(app: App, file: TFile): LinkContext {
	const cache = app.metadataCache;
	const linked = new Set<string>();

	const resolved = cache.resolvedLinks?.[file.path] ?? {};
	for (const target of Object.keys(resolved)) linked.add(target);

	for (const [src, targets] of Object.entries(cache.resolvedLinks ?? {})) {
		if ((targets as Record<string, number>)[file.path]) linked.add(src);
	}

	const meta: CachedMetadata | null = cache.getFileCache(file);
	const fm = meta?.frontmatter ?? {};
	const aliases = normalizeAliases(fm.aliases);

	return {
		linkedPaths: linked,
		aliases,
		title: file.basename,
	};
}

function normalizeAliases(raw: unknown): string[] {
	if (!raw) return [];
	if (typeof raw === "string") return [raw.trim()].filter((s) => s.length > 0);
	if (Array.isArray(raw)) {
		return raw
			.filter((v): v is string => typeof v === "string")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	return [];
}

// Build the query text used for "find related to this note" — leads with
// title + aliases so the embedding picks up linkage cues, then the body.
export function buildContextualQuery(ctx: LinkContext, body: string, maxBodyChars = 1500): string {
	const lead: string[] = [ctx.title];
	if (ctx.aliases.length) lead.push(`Aliases: ${ctx.aliases.join(", ")}`);
	const head = lead.join("\n");
	const trimmed = body.slice(0, maxBodyChars);
	return `${head}\n\n${trimmed}`;
}
