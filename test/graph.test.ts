import type { App } from "obsidian";
import {
	buildLinkGraph,
	edgeDirection,
	nHopNeighbors,
	subgraphNeighbors,
	shortestPath,
} from "../src/graph";

// ---- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string) {
	if (cond) passed++;
	else failures.push(msg);
}
function eq(actual: unknown, expected: unknown, msg: string) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	ok(a === e, `${msg}\n    expected: ${e}\n    actual:   ${a}`);
}
// Normalize a hop Map to a sorted [path,hop][] for stable comparison.
function hops(m: Map<string, number>): [string, number][] {
	return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]));
}
function pathIds(steps: { path: string; direction: string }[] | null): string[] | null {
	return steps ? steps.map((s) => s.path) : null;
}
function dirs(steps: { path: string; direction: string }[] | null): string[] | null {
	return steps ? steps.map((s) => s.direction) : null;
}

// ---- fixture ----------------------------------------------------------------
// Forward links (src → target). Includes: a mutual link (A↔B), a hub (E),
// a self-link (A→A, must be ignored), a non-md target (A→img.png, ignored),
// and a disconnected component (G↔? just G→H).
const resolvedLinks: Record<string, Record<string, number>> = {
	"A.md": { "B.md": 1, "E.md": 1, "img.png": 3, "A.md": 1 },
	"B.md": { "A.md": 1, "C.md": 1 },
	"C.md": { "D.md": 1 },
	"E.md": { "D.md": 1 },
	"G.md": { "H.md": 1 },
};
const fakeApp = { metadataCache: { resolvedLinks } } as unknown as App;
const g = buildLinkGraph(fakeApp);

// ---- buildLinkGraph ---------------------------------------------------------
ok(!g.adj.has("img.png"), "non-md target must be filtered out of the graph");
ok(!(g.adj.get("A.md")?.has("A.md") ?? false), "self-link must be ignored");
eq(
	[...(g.adj.get("A.md") ?? [])].sort(),
	["B.md", "E.md"],
	"A undirected neighbors = B, E"
);
eq(
	[...(g.adj.get("D.md") ?? [])].sort(),
	["C.md", "E.md"],
	"D reachable from C and E (undirected, even though D has no outgoing links)"
);

// ---- edgeDirection ----------------------------------------------------------
eq(edgeDirection(g, "A.md", "B.md"), "both", "A<->B is mutual");
eq(edgeDirection(g, "A.md", "E.md"), "forward", "A->E is forward from A");
eq(edgeDirection(g, "E.md", "A.md"), "back", "E->A is a backlink from E's view");
eq(edgeDirection(g, "A.md", "C.md"), "none", "A and C are not directly linked");

// ---- nHopNeighbors ----------------------------------------------------------
eq(hops(nHopNeighbors(g, "A.md", 0)), [], "depth 0 = no neighbors");
eq(hops(nHopNeighbors(g, "A.md", 1)), [["B.md", 1], ["E.md", 1]], "A 1-hop = B,E");
eq(
	hops(nHopNeighbors(g, "A.md", 2)),
	[["B.md", 1], ["C.md", 2], ["D.md", 2], ["E.md", 1]],
	"A 2-hop adds C,D at hop 2 (D via the shorter E path)"
);
eq(hops(nHopNeighbors(g, "Z.md", 3)), [], "neighbors of a note not in the graph = empty");

// ---- subgraphNeighbors ------------------------------------------------------
eq(
	hops(subgraphNeighbors(g, ["A.md", "C.md"], 1)),
	[["B.md", 1], ["D.md", 1], ["E.md", 1]],
	"seeds A+C, 1-hop union excludes seeds; keeps min hop"
);

// ---- shortestPath -----------------------------------------------------------
eq(pathIds(shortestPath(g, "A.md", "A.md")), ["A.md"], "path to self = just self");
eq(dirs(shortestPath(g, "A.md", "A.md")), ["start"], "self path has only the start step");

eq(
	pathIds(shortestPath(g, "A.md", "D.md")),
	["A.md", "E.md", "D.md"],
	"A->D shortest is the 2-hop E path, not the 3-hop B->C path"
);
eq(
	dirs(shortestPath(g, "A.md", "D.md")),
	["start", "forward", "forward"],
	"A->E->D edges are both forward"
);
eq(
	dirs(shortestPath(g, "D.md", "A.md")),
	["start", "back", "back"],
	"reverse path D->E->A edges read as backlinks"
);

eq(shortestPath(g, "A.md", "Z.md"), null, "path to a nonexistent note = null");
eq(shortestPath(g, "A.md", "G.md"), null, "path across disconnected components = null");
eq(pathIds(shortestPath(g, "G.md", "H.md")), ["G.md", "H.md"], "path within the small component");

// ---- report -----------------------------------------------------------------
if (failures.length) {
	console.error(`\n✗ ${failures.length} FAILED, ${passed} passed\n`);
	for (const f of failures) console.error("  ✗ " + f + "\n");
	process.exitCode = 1;
} else {
	console.log(`✓ all ${passed} graph assertions passed`);
}
