import { ItemView, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	Simulation,
	SimulationLinkDatum,
	SimulationNodeDatum,
} from "d3-force";
import type CordycepSemanticPlugin from "./main";
import { debounce, stripFrontmatter, topFolder } from "./util";
import type { QueryResult } from "./client";
import { getLinkContext, buildContextualQuery, linkedPathsAsResults } from "./links";

export const GRAPH_VIEW_TYPE = "cordycep-semantic-graph";

interface GraphNode extends SimulationNodeDatum {
	id: string;             // vault path (or rawSource fallback)
	label: string;
	folder: string;
	ring: 0 | 1 | 2;
	weight: number;
	bestScore: number;      // strongest similarity to any predecessor
	linked: boolean;        // explicitly linked to/from the center note
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
	source: string | GraphNode;
	target: string | GraphNode;
	score: number;
	linked: boolean; // true when this edge corresponds to an actual Obsidian link
}

const DEFAULT_FOLDER_PALETTE: Record<string, string> = {
	"Walk of Life": "#7aa2f7",
	"Zen": "#9ece6a",
	"Academy": "#e0af68",
	"(root)": "#bb9af7",
};

function parseFolderPalette(raw: string): Record<string, string> {
	if (!raw.trim()) return DEFAULT_FOLDER_PALETTE;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, string>;
		}
	} catch {
		// fall through
	}
	return DEFAULT_FOLDER_PALETTE;
}

function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return `rgba(125,207,255,${alpha})`;
	const v = parseInt(m[1], 16);
	const r = (v >> 16) & 0xff;
	const g = (v >> 8) & 0xff;
	const b = v & 0xff;
	return `rgba(${r},${g},${b},${alpha})`;
}

export class NeighborhoodGraphView extends ItemView {
	private plugin: CordycepSemanticPlugin;
	private canvas!: HTMLCanvasElement;
	private statusEl!: HTMLElement;
	private currentPath: string | null = null;
	private debouncedRun: () => void;
	private detachActiveLeafChange: (() => void) | null = null;
	private detachFileOpen: (() => void) | null = null;
	private sim: Simulation<GraphNode, GraphLink> | null = null;
	private nodes: GraphNode[] = [];
	private links: GraphLink[] = [];
	private transform = { x: 0, y: 0, k: 1 };
	private hovered: GraphNode | null = null;
	private dragging: GraphNode | null = null;
	private resizeObserver: ResizeObserver | null = null;
	// Positions of nodes from the previous render, keyed by id. Lets nodes
	// that survive a navigation (especially the new center = node you just
	// clicked, and the old center) stay put instead of jolting around.
	private carriedPositions = new Map<string, { x: number; y: number }>();

	constructor(leaf: WorkspaceLeaf, plugin: CordycepSemanticPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.debouncedRun = debounce(
			() => void this.run(),
			this.plugin.settings.graphDebounceMs
		);
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Semantic neighborhood";
	}
	getIcon(): string {
		return "git-fork";
	}

	async onOpen() {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cordycep-graph-root");

		const header = root.createDiv({ cls: "cordycep-graph-header" });
		header.createEl("h4", { text: "Semantic neighborhood" });
		const headerRight = header.createDiv({ cls: "cordycep-header-controls" });
		const reset = headerRight.createEl("button", { cls: "cordycep-icon-btn", attr: { "aria-label": "Reset graph (clear accumulated nodes)" } });
		setIcon(reset, "trash-2");
		reset.addEventListener("click", () => this.resetGraph());
		const refresh = headerRight.createEl("button", { cls: "cordycep-icon-btn", attr: { "aria-label": "Refresh" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.run(true));

		this.statusEl = root.createDiv({ cls: "cordycep-graph-status" });

		const canvasWrap = root.createDiv({ cls: "cordycep-graph-canvas-wrap" });
		this.canvas = canvasWrap.createEl("canvas", { cls: "cordycep-graph-canvas" });
		this.attachCanvasInteractions();

		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(canvasWrap);

		const onActive = () => this.handleActiveChange();
		this.app.workspace.on("active-leaf-change", onActive);
		this.detachActiveLeafChange = () => this.app.workspace.off("active-leaf-change", onActive);

		const onFileOpen = () => this.handleActiveChange();
		this.app.workspace.on("file-open", onFileOpen);
		this.detachFileOpen = () => this.app.workspace.off("file-open", onFileOpen);

		this.handleActiveChange();
	}

	async onClose() {
		this.detachActiveLeafChange?.();
		this.detachFileOpen?.();
		this.resizeObserver?.disconnect();
		this.sim?.stop();
	}

	private resizeCanvas() {
		const wrap = this.canvas.parentElement!;
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = wrap.clientWidth * dpr;
		this.canvas.height = wrap.clientHeight * dpr;
		this.canvas.style.width = `${wrap.clientWidth}px`;
		this.canvas.style.height = `${wrap.clientHeight}px`;
		const ctx = this.canvas.getContext("2d")!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.draw();
	}

	private handleActiveChange() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.currentPath = null;
			this.setStatus("Open a markdown note.");
			this.nodes = [];
			this.links = [];
			this.draw();
			return;
		}
		if (file.path === this.currentPath) return;
		this.currentPath = file.path;
		this.setStatus("Loading…");
		this.debouncedRun();
	}

	private async run(force = false) {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return;
		if (!force && file.path !== this.currentPath) return;

		// Snapshot current node positions before we rebuild — nodes that
		// survive into the next graph will reuse these (no jolt).
		this.snapshotPositions();

		const t0 = performance.now();
		try {
			const raw = await this.app.vault.read(file);
			const body = stripFrontmatter(raw).trim();
			if (body.length < this.plugin.settings.minNoteChars) {
				this.setStatus(`Note shorter than ${this.plugin.settings.minNoteChars} chars — too small to graph.`);
				return;
			}
			const ctx = getLinkContext(this.app, file);
			const centerQuery = buildContextualQuery(ctx, body);
			const firstRing = await this.plugin.client.querySimilarFiles(
				centerQuery,
				this.plugin.settings.graphFirstRingN,
				file.path
			);
			// Include explicit wikilinks as first-ring nodes regardless of
			// whether they showed up in the semantic top-N.
			const linkedFirstRing = linkedPathsAsResults(this.app, ctx.linkedPaths)
				.filter((r) => r.vaultPath !== file.path);
			const firstFiltered = mergeBy(firstRing, linkedFirstRing);

			// Second-ring queries in parallel — use each first-ring node's
			// snippet as the query (we don't have the full body of those
			// notes without a vault read, but the snippet is "the most
			// salient chunk" and good enough for one more hop).
			const secondRingPromises = firstFiltered.map((n) =>
				this.plugin.client
					.query(n.snippet || n.displayName, this.plugin.settings.graphSecondRingM)
					.then(
						(rs) => ({ from: n, neighbors: rs }),
						() => ({ from: n, neighbors: [] as QueryResult[] })
					)
			);
			const secondRingByFirst = await Promise.all(secondRingPromises);

			const built = this.buildGraph(file.path, firstFiltered, secondRingByFirst, ctx.linkedPaths);
			this.mergeIntoAccumulated(file.path, built.newNodes, built.newLinks);
			this.layoutAndStart();
			const linkedCount = this.links.filter((l) => l.linked).length;
			const acc = this.plugin.settings.graphAccumulate ? " (accumulating)" : "";
			this.setStatus(
				`${this.nodes.length} nodes · ${this.links.length} edges (${linkedCount} linked)${acc} · ${Math.round(
					performance.now() - t0
				)}ms`
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.setStatus(`Error: ${msg}`);
		}
	}

	private buildGraph(
		centerPath: string,
		firstRing: QueryResult[],
		secondRing: { from: QueryResult; neighbors: QueryResult[] }[],
		centerLinkedPaths: Set<string>
	): { newNodes: GraphNode[]; newLinks: GraphLink[] } {
		const floor = this.plugin.settings.graphScoreFloor;
		const byId = new Map<string, GraphNode>();
		const links: GraphLink[] = [];

		const centerLabel = centerPath.split("/").pop()!.replace(/\.md$/, "");
		const center: GraphNode = {
			id: centerPath,
			label: centerLabel,
			folder: topFolder(centerPath),
			ring: 0,
			weight: 1,
			bestScore: 1,
			linked: false,
		};
		byId.set(center.id, center);

		for (const r of firstRing) {
			const id = r.vaultPath ?? r.rawSource;
			if (!id || id === centerPath) continue;
			const isLinked = r.vaultPath ? centerLinkedPaths.has(r.vaultPath) : false;
			// Drop sub-floor *semantic* edges, but always keep explicit links.
			if (r.score < floor && !isLinked) continue;
			let node = byId.get(id);
			if (!node) {
				node = {
					id,
					label: r.displayName,
					folder: r.vaultPath ? topFolder(r.vaultPath) : "(root)",
					ring: 1,
					weight: 0,
					bestScore: r.score,
					linked: isLinked,
				};
				byId.set(id, node);
			}
			if (r.score > node.bestScore) node.bestScore = r.score;
			if (isLinked) node.linked = true;
			node.weight += Math.max(r.score, isLinked ? 0.5 : 0);
			links.push({
				source: centerPath,
				target: id,
				score: r.score,
				linked: isLinked,
			});
		}

		// For second-ring edges we'd need each first-ring note's link set too,
		// which is N more metadataCache lookups (cheap — they're in-memory).
		const secondRingLinkedSets = new Map<string, Set<string>>();
		for (const { from } of secondRing) {
			if (!from.vaultPath) continue;
			const file = this.app.vault.getAbstractFileByPath(from.vaultPath);
			if (file instanceof TFile) {
				secondRingLinkedSets.set(from.vaultPath, getLinkContext(this.app, file).linkedPaths);
			}
		}

		for (const { from, neighbors } of secondRing) {
			const fromId = from.vaultPath ?? from.rawSource;
			if (!fromId || !byId.has(fromId)) continue;
			const fromLinkSet = from.vaultPath ? secondRingLinkedSets.get(from.vaultPath) : undefined;
			for (const r of neighbors) {
				if (r.score < floor) continue;
				const id = r.vaultPath ?? r.rawSource;
				if (!id || id === centerPath || id === fromId) continue;
				const edgeLinked = !!(r.vaultPath && fromLinkSet?.has(r.vaultPath));
				let node = byId.get(id);
				if (!node) {
					node = {
						id,
						label: r.displayName,
						folder: r.vaultPath ? topFolder(r.vaultPath) : "(root)",
						ring: 2,
						weight: 0,
						bestScore: r.score,
						linked: false,
					};
					byId.set(id, node);
				}
				if (r.score > node.bestScore) node.bestScore = r.score;
				node.weight += r.score * 0.5;
				if (!links.some((l) => sameEdge(l, fromId, id))) {
					links.push({
						source: fromId,
						target: id,
						score: r.score,
						linked: edgeLinked,
					});
				}
			}
		}

		return { newNodes: Array.from(byId.values()), newLinks: links };
	}

	private mergeIntoAccumulated(centerPath: string, newNodes: GraphNode[], newLinks: GraphLink[]) {
		// Accumulate mode: keep everything from previous renders. Off mode:
		// replace wholesale.
		if (!this.plugin.settings.graphAccumulate) {
			this.nodes = newNodes;
			this.links = newLinks;
			return;
		}

		const byId = new Map<string, GraphNode>();
		for (const n of this.nodes) byId.set(n.id, n);

		// Demote any existing center that isn't the new one.
		for (const n of byId.values()) {
			if (n.ring === 0 && n.id !== centerPath) n.ring = 1;
		}

		for (const incoming of newNodes) {
			const existing = byId.get(incoming.id);
			if (!existing) {
				byId.set(incoming.id, incoming);
				continue;
			}
			// Update score / linked / ring based on the new query, but keep
			// the existing position (x/y/fx/fy) so it doesn't move.
			if (incoming.bestScore > existing.bestScore) existing.bestScore = incoming.bestScore;
			if (incoming.linked) existing.linked = true;
			if (incoming.id === centerPath) existing.ring = 0;
			else if (existing.ring > incoming.ring) existing.ring = incoming.ring;
			existing.weight = Math.max(existing.weight, incoming.weight);
			// Update label (filename may have changed) + folder
			existing.label = incoming.label;
			existing.folder = incoming.folder;
		}

		// Merge links — drop dupes (sameEdge) but tolerate node references
		// from older renders by re-resolving to the live node objects.
		const existingLinks = this.links.filter((l) => {
			const sId = typeof l.source === "string" ? l.source : l.source.id;
			const tId = typeof l.target === "string" ? l.target : l.target.id;
			return byId.has(sId) && byId.has(tId);
		});
		for (const link of newLinks) {
			const sId = typeof link.source === "string" ? link.source : link.source.id;
			const tId = typeof link.target === "string" ? link.target : link.target.id;
			if (existingLinks.some((l) => sameEdge(l, sId, tId))) continue;
			existingLinks.push(link);
		}

		this.nodes = Array.from(byId.values());
		this.links = existingLinks;
	}

	resetGraph() {
		this.sim?.stop();
		this.nodes = [];
		this.links = [];
		this.carriedPositions.clear();
		this.transform = { x: 0, y: 0, k: 1 };
		this.draw();
		// Re-run for the active note from a clean slate.
		void this.run(true);
	}

	private snapshotPositions() {
		this.carriedPositions.clear();
		for (const n of this.nodes) {
			if (n.x != null && n.y != null) {
				this.carriedPositions.set(n.id, { x: n.x, y: n.y });
			}
		}
	}

	private applyCarriedPositions() {
		for (const n of this.nodes) {
			const prev = this.carriedPositions.get(n.id);
			if (!prev) continue;
			n.x = prev.x;
			n.y = prev.y;
			// Pin so the new simulation lays out only the *new* nodes around
			// them. Drag still works because the drag handler sets fx/fy
			// directly and clears them on release.
			n.fx = prev.x;
			n.fy = prev.y;
		}
	}

	private layoutAndStart() {
		this.sim?.stop();
		this.applyCarriedPositions();
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		this.sim = forceSimulation<GraphNode, GraphLink>(this.nodes)
			.force(
				"link",
				forceLink<GraphNode, GraphLink>(this.links)
					.id((d) => d.id)
					.distance((l) => 80 + (1 - l.score) * 120)
					.strength((l) => 0.3 + l.score * 0.4)
			)
			.force("charge", forceManyBody<GraphNode>().strength(-180))
			.force("center", forceCenter(w / 2, h / 2))
			.force("collide", forceCollide<GraphNode>().radius((d) => 8 + Math.sqrt(d.weight) * 4));

		this.sim.on("tick", () => this.draw());
		// Don't reset the pan/zoom on rebuild — keeps the camera steady
		// across navigations.
	}

	private draw() {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const colorLinked = this.plugin.settings.colorLinked;
		const colorSemantic = this.plugin.settings.colorSemantic;
		const colorCenter = this.plugin.settings.colorCenter;
		const colorBg = this.plugin.settings.colorBackground;
		const colorHover = this.plugin.settings.colorHoverRing;
		const colorLabel = this.plugin.settings.colorNodeLabel;
		const colorFallback = this.plugin.settings.colorFolderFallback;
		const folderPalette = parseFolderPalette(this.plugin.settings.folderPalette);

		ctx.fillStyle = colorBg;
		ctx.fillRect(0, 0, w, h);

		ctx.save();
		ctx.translate(this.transform.x, this.transform.y);
		ctx.scale(this.transform.k, this.transform.k);

		// Pass 1: edges
		for (const link of this.links) {
			const s = link.source as GraphNode;
			const t = link.target as GraphNode;
			if (s.x == null || t.x == null) continue;
			ctx.beginPath();
			ctx.moveTo(s.x, s.y!);
			ctx.lineTo(t.x, t.y!);
			if (link.linked) {
				ctx.setLineDash([]);
				ctx.lineWidth = 1.5 + link.score * 2.5;
				ctx.strokeStyle = hexToRgba(colorLinked, 0.6 + link.score * 0.35);
			} else {
				ctx.setLineDash([5, 4]);
				ctx.lineWidth = 0.5 + link.score * 1.5;
				ctx.strokeStyle = hexToRgba(colorSemantic, 0.25 + link.score * 0.45);
			}
			ctx.stroke();
			ctx.setLineDash([]);
		}

		// Pass 2: edge score labels at midpoints (only when zoomed in or hovered for less clutter)
		if (this.plugin.settings.showScores) {
			ctx.font = `10px var(--font-monospace)`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			for (const link of this.links) {
				const s = link.source as GraphNode;
				const t = link.target as GraphNode;
				if (s.x == null || t.x == null) continue;
				const mx = (s.x + (t.x ?? 0)) / 2;
				const my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
				const text = link.score.toFixed(2);
				const tw = ctx.measureText(text).width;
				ctx.fillStyle = hexToRgba(colorBg, 0.85);
				ctx.fillRect(mx - tw / 2 - 3, my - 7, tw + 6, 14);
				ctx.fillStyle = link.linked ? hexToRgba(colorLinked, 0.95) : hexToRgba(colorSemantic, 0.95);
				ctx.fillText(text, mx, my);
			}
		}

		// Pass 3: nodes
		for (const node of this.nodes) {
			if (node.x == null) continue;
			const r = node.ring === 0 ? 10 : 5 + Math.sqrt(node.weight) * 3;

			// Linked-to-center halo
			if (node.linked) {
				ctx.beginPath();
				ctx.arc(node.x, node.y!, r + 4, 0, Math.PI * 2);
				ctx.lineWidth = 2;
				ctx.strokeStyle = hexToRgba(colorLinked, 0.85);
				ctx.stroke();
			}

			ctx.beginPath();
			ctx.arc(node.x, node.y!, r, 0, Math.PI * 2);
			ctx.fillStyle = node.ring === 0 ? colorCenter : (folderPalette[node.folder] ?? colorFallback);
			ctx.fill();

			if (node === this.hovered) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = colorHover;
				ctx.stroke();
			}

			// Always-visible name + score (with link boost applied)
			const showScore = this.plugin.settings.showScores && node.ring !== 0;
			const boost = node.linked ? this.plugin.settings.linkBoost : 0;
			const displayedScore = Math.min(1.5, node.bestScore + boost);
			const labelText = showScore
				? `${node.label}  ${displayedScore.toFixed(2)}${boost > 0 ? "*" : ""}`
				: node.label;
			ctx.fillStyle = node === this.hovered ? colorHover : colorLabel;
			ctx.font = `${node.ring === 0 ? 13 : 11}px var(--font-interface)`;
			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			// Draw a subtle background pill behind the label so it's readable over edges
			const lw = ctx.measureText(labelText).width;
			ctx.fillStyle = hexToRgba(colorBg, 0.7);
			ctx.fillRect(node.x + r + 2, node.y! - 8, lw + 6, 16);
			ctx.fillStyle = node === this.hovered ? colorHover : colorLabel;
			ctx.fillText(labelText, node.x + r + 5, node.y!);
		}

		ctx.restore();
	}

	private attachCanvasInteractions() {
		const c = this.canvas;

		const toWorld = (px: number, py: number) => ({
			x: (px - this.transform.x) / this.transform.k,
			y: (py - this.transform.y) / this.transform.k,
		});

		const pickNode = (px: number, py: number): GraphNode | null => {
			const w = toWorld(px, py);
			for (let i = this.nodes.length - 1; i >= 0; i--) {
				const n = this.nodes[i];
				if (n.x == null) continue;
				const r = n.ring === 0 ? 10 : 5 + Math.sqrt(n.weight) * 3;
				const dx = w.x - n.x;
				const dy = w.y - (n.y ?? 0);
				if (dx * dx + dy * dy <= (r + 2) * (r + 2)) return n;
			}
			return null;
		};

		c.addEventListener("mousemove", (e) => {
			const rect = c.getBoundingClientRect();
			const px = e.clientX - rect.left;
			const py = e.clientY - rect.top;
			if (this.dragging && this.dragging.x != null) {
				const w = toWorld(px, py);
				this.dragging.fx = w.x;
				this.dragging.fy = w.y;
				this.sim?.alpha(0.4).restart();
			} else {
				const hit = pickNode(px, py);
				if (hit !== this.hovered) {
					this.hovered = hit;
					c.style.cursor = hit ? "pointer" : "default";
					c.title = hit ? hit.id : "";
					this.draw();
				}
			}
		});

		c.addEventListener("mousedown", (e) => {
			const rect = c.getBoundingClientRect();
			const hit = pickNode(e.clientX - rect.left, e.clientY - rect.top);
			if (hit) {
				this.dragging = hit;
				hit.fx = hit.x ?? null;
				hit.fy = hit.y ?? null;
			}
		});

		const release = () => {
			if (this.dragging) {
				this.dragging.fx = null;
				this.dragging.fy = null;
				this.dragging = null;
			}
		};
		c.addEventListener("mouseup", release);
		c.addEventListener("mouseleave", release);

		c.addEventListener("click", (e) => {
			const rect = c.getBoundingClientRect();
			const hit = pickNode(e.clientX - rect.left, e.clientY - rect.top);
			if (!hit) return;
			const newPane = e.metaKey || e.ctrlKey;
			const file = this.app.vault.getAbstractFileByPath(hit.id);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf(newPane).openFile(file);
			} else {
				this.app.workspace.openLinkText(hit.label, "", newPane);
			}
		});

		c.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const rect = c.getBoundingClientRect();
				const px = e.clientX - rect.left;
				const py = e.clientY - rect.top;
				const factor = Math.exp(-e.deltaY * 0.001);
				const newK = Math.max(0.2, Math.min(4, this.transform.k * factor));
				const wx = (px - this.transform.x) / this.transform.k;
				const wy = (py - this.transform.y) / this.transform.k;
				this.transform.x = px - wx * newK;
				this.transform.y = py - wy * newK;
				this.transform.k = newK;
				this.draw();
			},
			{ passive: false }
		);

		// Pan with middle-mouse OR right-mouse drag.
		let panOrigin: { x: number; y: number } | null = null;
		let panStart: { x: number; y: number } | null = null;
		c.addEventListener("contextmenu", (e) => e.preventDefault());
		c.addEventListener("mousedown", (e) => {
			if (e.button !== 1 && e.button !== 2) return;
			e.preventDefault();
			panOrigin = { x: e.clientX, y: e.clientY };
			panStart = { x: this.transform.x, y: this.transform.y };
			c.style.cursor = "grabbing";
		});
		window.addEventListener("mousemove", (e) => {
			if (!panOrigin || !panStart) return;
			this.transform.x = panStart.x + (e.clientX - panOrigin.x);
			this.transform.y = panStart.y + (e.clientY - panOrigin.y);
			this.draw();
		});
		window.addEventListener("mouseup", () => {
			if (panOrigin) c.style.cursor = "default";
			panOrigin = null;
			panStart = null;
		});

		// Middle-button auxclick fires on browsers; consume it so it doesn't
		// trigger the default "scroll wheel" behavior in some embeds.
		c.addEventListener("auxclick", (e) => {
			if (e.button === 1) e.preventDefault();
		});
	}

	private setStatus(text: string) {
		if (this.statusEl) this.statusEl.setText(text);
	}
}

function sameEdge(l: GraphLink, a: string, b: string): boolean {
	const sId = typeof l.source === "string" ? l.source : l.source.id;
	const tId = typeof l.target === "string" ? l.target : l.target.id;
	return (sId === a && tId === b) || (sId === b && tId === a);
}

// Union of two QueryResult lists by vault path, preferring entries from
// the first list (which carry semantic snippets/scores).
function mergeBy(primary: QueryResult[], extra: QueryResult[]): QueryResult[] {
	const seen = new Set<string>();
	const out: QueryResult[] = [];
	for (const r of primary) {
		const key = r.vaultPath ?? r.rawSource;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	for (const r of extra) {
		const key = r.vaultPath ?? r.rawSource;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}
