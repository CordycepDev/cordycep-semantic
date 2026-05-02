import { App, TFile, CachedMetadata } from "obsidian";
import type { QueryResult } from "./client";

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

// Materialize each linked vault path as a synthetic QueryResult so the views
// can render explicit wikilinks alongside semantic neighbors.
export function linkedPathsAsResults(app: App, linkedPaths: Set<string>): QueryResult[] {
	const out: QueryResult[] = [];
	for (const p of linkedPaths) {
		const f = app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile && f.extension === "md") {
			out.push({
				vaultPath: f.path,
				displayName: f.basename,
				snippet: "",
				score: 0,
				rawSource: f.path,
			});
		}
	}
	return out;
}

// Merge linked + semantic results by vault path. Linked-only entries keep
// their placeholder score (0). Linked entries also present in semantic
// results adopt the semantic snippet + score. Sort: linked first, then
// semantic-only by score desc.
export function mergeLinkedAndSemantic(
	semantic: QueryResult[],
	linked: QueryResult[],
	linkedPaths: Set<string>,
	limit: number
): QueryResult[] {
	const byKey = new Map<string, QueryResult>();
	for (const r of semantic) {
		const key = r.vaultPath ?? r.rawSource;
		byKey.set(key, r);
	}
	for (const r of linked) {
		const key = r.vaultPath ?? r.rawSource;
		if (!byKey.has(key)) byKey.set(key, r);
	}
	const merged = Array.from(byKey.values());
	merged.sort((a, b) => {
		const aLinked = a.vaultPath ? linkedPaths.has(a.vaultPath) : false;
		const bLinked = b.vaultPath ? linkedPaths.has(b.vaultPath) : false;
		if (aLinked !== bLinked) return aLinked ? -1 : 1;
		return b.score - a.score;
	});
	return merged.slice(0, limit);
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
