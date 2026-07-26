import { App, TFile } from "obsidian";

// In-memory wikilink graph built from Obsidian's resolved-link index. This is
// the graph-native counterpart to the semantic backend: it answers relational
// / multi-hop questions ("how does A connect to B", "what's within N link hops
// of X") that vector similarity can't, using the human-authored [[wikilinks]]
// as edges.
//
// Cheap to rebuild (a few thousand notes = a handful of in-memory Maps), so we
// build on demand rather than caching + invalidating on every vault edit.
export interface LinkGraph {
	// Undirected adjacency — a link in EITHER direction connects two notes for
	// the purposes of "are these related / how far apart are they".
	adj: Map<string, Set<string>>;
	// Directed forward links (src → notes it links TO). Used to label the
	// direction of each edge in a rendered path.
	forward: Map<string, Set<string>>;
}

// A single step in a connection path: the note plus how the previous note
// reached it (forward = prev links to this; back = this links to prev).
export interface PathStep {
	path: string;
	// Direction of the edge FROM the previous step TO this one. The first step
	// (the origin) has direction "start".
	direction: "start" | "forward" | "back" | "both";
}

function addEdge(g: LinkGraph, from: string, to: string) {
	if (!g.forward.has(from)) g.forward.set(from, new Set());
	g.forward.get(from)!.add(to);
	if (!g.adj.has(from)) g.adj.set(from, new Set());
	if (!g.adj.has(to)) g.adj.set(to, new Set());
	g.adj.get(from)!.add(to);
	g.adj.get(to)!.add(from);
}

// Build the graph from metadataCache.resolvedLinks. Only markdown targets are
// kept as nodes — attachments (images/PDFs) would create meaningless bridges
// between otherwise-unrelated notes that happen to embed the same image.
export function buildLinkGraph(app: App): LinkGraph {
	const g: LinkGraph = { adj: new Map(), forward: new Map() };
	const resolved = app.metadataCache.resolvedLinks ?? {};
	const isMd = (p: string) => p.endsWith(".md");
	for (const [src, targets] of Object.entries(resolved)) {
		if (!isMd(src)) continue;
		for (const target of Object.keys(targets as Record<string, number>)) {
			if (!isMd(target) || target === src) continue;
			addEdge(g, src, target);
		}
	}
	return g;
}

// Direction of the edge between two adjacent notes, from `from`'s perspective.
export function edgeDirection(
	g: LinkGraph,
	from: string,
	to: string
): "forward" | "back" | "both" | "none" {
	const f = g.forward.get(from)?.has(to) ?? false;
	const b = g.forward.get(to)?.has(from) ?? false;
	if (f && b) return "both";
	if (f) return "forward";
	if (b) return "back";
	return "none";
}

// N-hop breadth-first neighborhood of a single note. Returns path → hop
// distance (1..depth), excluding the start note itself. Each note is recorded
// at its SHORTEST hop distance.
export function nHopNeighbors(
	g: LinkGraph,
	start: string,
	depth: number
): Map<string, number> {
	const out = new Map<string, number>();
	if (depth < 1) return out;
	let frontier: string[] = [start];
	const visited = new Set<string>([start]);
	for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const nbr of g.adj.get(node) ?? []) {
				if (visited.has(nbr)) continue;
				visited.add(nbr);
				out.set(nbr, hop);
				next.push(nbr);
			}
		}
		frontier = next;
	}
	return out;
}

// Union N-hop neighborhood of several seed notes at once. A note reachable from
// multiple seeds keeps its smallest hop distance. Seeds themselves are excluded
// from the result.
export function subgraphNeighbors(
	g: LinkGraph,
	seeds: string[],
	depth: number
): Map<string, number> {
	const out = new Map<string, number>();
	const seedSet = new Set(seeds);
	for (const seed of seeds) {
		for (const [path, hop] of nHopNeighbors(g, seed, depth)) {
			if (seedSet.has(path)) continue;
			const prev = out.get(path);
			if (prev == null || hop < prev) out.set(path, hop);
		}
	}
	return out;
}

// Shortest wikilink path between two notes (inclusive of both endpoints),
// annotated with the direction of each edge. Returns null when no link path
// exists. BFS over the undirected graph — the first time we reach `to` is a
// shortest path.
export function shortestPath(g: LinkGraph, from: string, to: string): PathStep[] | null {
	if (from === to) return [{ path: from, direction: "start" }];
	if (!g.adj.has(from) || !g.adj.has(to)) return null;

	const parent = new Map<string, string>();
	const visited = new Set<string>([from]);
	// Head-index queue rather than Array.shift() — shift() is O(n) per call,
	// which makes BFS O(n^2) on a large connected vault. Advancing an index
	// keeps the whole search linear.
	const queue: string[] = [from];
	let head = 0;
	let found = false;
	while (head < queue.length) {
		const node = queue[head++];
		if (node === to) {
			found = true;
			break;
		}
		for (const nbr of g.adj.get(node) ?? []) {
			if (visited.has(nbr)) continue;
			visited.add(nbr);
			parent.set(nbr, node);
			queue.push(nbr);
		}
	}
	if (!found) return null;

	// Reconstruct from `to` back to `from`, then reverse.
	const chain: string[] = [];
	let cur: string | undefined = to;
	while (cur != null) {
		chain.push(cur);
		cur = parent.get(cur);
	}
	chain.reverse();

	const steps: PathStep[] = [{ path: chain[0], direction: "start" }];
	for (let i = 1; i < chain.length; i++) {
		const dir = edgeDirection(g, chain[i - 1], chain[i]);
		steps.push({ path: chain[i], direction: dir === "none" ? "both" : dir });
	}
	return steps;
}

// Convenience: does a markdown file with this path exist in the vault?
export function resolveFile(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}
