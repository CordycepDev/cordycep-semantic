import { App, TFile, CachedMetadata } from "obsidian";
import type { QueryResult } from "./client";
import type { SortMode } from "./settings";

export type LinkKind = "forward" | "back" | "mutual" | "none";

export interface LinkContext {
	forwardPaths: Set<string>;  // notes the active file links TO
	backPaths: Set<string>;     // notes that link TO the active file
	linkedPaths: Set<string>;   // union of forward + back (sort/grouping convenience)
	aliases: string[];
	title: string;
}

// Forward links: notes the given file explicitly links to (resolved by Obsidian).
// Backlinks: notes that explicitly link to this file.
// Aliases: declared in the file's YAML frontmatter (`aliases:`).
export function getLinkContext(app: App, file: TFile): LinkContext {
	const cache = app.metadataCache;
	const forward = new Set<string>();
	const back = new Set<string>();

	const resolved = cache.resolvedLinks?.[file.path] ?? {};
	for (const target of Object.keys(resolved)) forward.add(target);

	for (const [src, targets] of Object.entries(cache.resolvedLinks ?? {})) {
		if ((targets as Record<string, number>)[file.path]) back.add(src);
	}

	const linked = new Set<string>([...forward, ...back]);

	const meta: CachedMetadata | null = cache.getFileCache(file);
	const fm = meta?.frontmatter ?? {};
	const aliases = normalizeAliases(fm.aliases);

	return {
		forwardPaths: forward,
		backPaths: back,
		linkedPaths: linked,
		aliases,
		title: file.basename,
	};
}

export function classifyLink(path: string | null, ctx: { forwardPaths: Set<string>; backPaths: Set<string> }): LinkKind {
	if (!path) return "none";
	const f = ctx.forwardPaths.has(path);
	const b = ctx.backPaths.has(path);
	if (f && b) return "mutual";
	if (f) return "forward";
	if (b) return "back";
	return "none";
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

export interface MergeOptions {
	linkedPaths: Set<string>;
	sortMode: SortMode;
	linkBoost: number;
	limit: number;
	app?: App; // needed for "recent" sort to read mtimes
}

// Merge linked + semantic results by vault path. Linked-only entries keep
// their placeholder score (0). Linked entries also present in semantic
// results adopt the semantic snippet + score. Sorting is governed by
// MergeOptions.sortMode.
export function mergeLinkedAndSemantic(
	semantic: QueryResult[],
	linked: QueryResult[],
	opts: MergeOptions
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
	merged.sort((a, b) => compare(a, b, opts));
	return merged.slice(0, opts.limit);
}

function compare(a: QueryResult, b: QueryResult, opts: MergeOptions): number {
	const aLinked = a.vaultPath ? opts.linkedPaths.has(a.vaultPath) : false;
	const bLinked = b.vaultPath ? opts.linkedPaths.has(b.vaultPath) : false;
	const aBoosted = a.score + (aLinked ? opts.linkBoost : 0);
	const bBoosted = b.score + (bLinked ? opts.linkBoost : 0);

	switch (opts.sortMode) {
		case "score":
			return bBoosted - aBoosted;
		case "linked-then-name": {
			if (aLinked !== bLinked) return aLinked ? -1 : 1;
			return a.displayName.localeCompare(b.displayName);
		}
		case "recent":
			return mtime(opts.app, b) - mtime(opts.app, a);
		case "linked-then-score":
		default: {
			if (aLinked !== bLinked) return aLinked ? -1 : 1;
			return bBoosted - aBoosted;
		}
	}
}

function mtime(app: App | undefined, r: QueryResult): number {
	if (!app || !r.vaultPath) return 0;
	const f = app.vault.getAbstractFileByPath(r.vaultPath);
	return f instanceof TFile ? f.stat.mtime : 0;
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
