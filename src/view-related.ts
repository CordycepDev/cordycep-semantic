import { ItemView, WorkspaceLeaf, TFile, MarkdownView, setIcon } from "obsidian";
import type CordycepSemanticPlugin from "./main";
import type { QueryResult } from "./client";
import { debounce, stripFrontmatter } from "./util";
import { getLinkContext, buildContextualQuery, linkedPathsAsResults, mergeLinkedAndSemantic, classifyLink, LinkKind, LinkContext } from "./links";
import type { SortMode } from "./settings";

export const RELATED_VIEW_TYPE = "cordycep-semantic-related";

export class RelatedNotesView extends ItemView {
	private plugin: CordycepSemanticPlugin;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private currentPath: string | null = null;
	private debouncedRun: () => void;
	private detachActiveLeafChange: (() => void) | null = null;
	private detachFileOpen: (() => void) | null = null;
	private detachStatus: (() => void) | null = null;
	private sortMode: SortMode | null = null; // session override; null = use plugin default
	private lastResults: { merged: QueryResult[]; ctx: LinkContext } | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CordycepSemanticPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.debouncedRun = debounce(
			() => void this.run(),
			this.plugin.settings.sidebarDebounceMs
		);
	}

	getViewType(): string {
		return RELATED_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Related notes (semantic)";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen() {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("cordycep-related-root");

		const header = root.createDiv({ cls: "cordycep-related-header" });
		header.createEl("h4", { text: "Related notes" });
		const headerRight = header.createDiv({ cls: "cordycep-header-controls" });
		const sortSelect = headerRight.createEl("select", { cls: "cordycep-sort-select" });
		const opts: [SortMode, string][] = [
			["linked-then-score", "Linked → score"],
			["score", "Score"],
			["linked-then-name", "Linked → A→Z"],
			["recent", "Recent"],
		];
		for (const [val, lbl] of opts) {
			const opt = sortSelect.createEl("option", { value: val, text: lbl });
			if (val === (this.sortMode ?? this.plugin.settings.defaultSort)) opt.selected = true;
		}
		sortSelect.addEventListener("change", () => {
			this.sortMode = sortSelect.value as SortMode;
			void this.run(true);
		});
		const refresh = headerRight.createEl("button", { cls: "cordycep-icon-btn", attr: { "aria-label": "Refresh" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.run(true));

		this.statusEl = root.createDiv({ cls: "cordycep-related-status" });
		this.listEl = root.createDiv({ cls: "cordycep-related-list" });

		const onActive = () => this.handleActiveChange();
		this.app.workspace.on("active-leaf-change", onActive);
		this.detachActiveLeafChange = () => this.app.workspace.off("active-leaf-change", onActive);

		const onFileOpen = () => this.handleActiveChange();
		this.app.workspace.on("file-open", onFileOpen);
		this.detachFileOpen = () => this.app.workspace.off("file-open", onFileOpen);

		this.detachStatus = this.plugin.client.onStatusChange(() => this.renderStatus());

		this.handleActiveChange();
	}

	async onClose() {
		this.detachActiveLeafChange?.();
		this.detachFileOpen?.();
		this.detachStatus?.();
	}

	private handleActiveChange() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.currentPath = null;
			this.renderEmpty("Open a markdown note to see related notes.");
			return;
		}
		if (file.path === this.currentPath) return;
		this.currentPath = file.path;
		this.renderEmpty("Loading…");
		this.debouncedRun();
	}

	private async run(force = false) {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return;
		if (!force && file.path !== this.currentPath) return;

		try {
			const raw = await this.app.vault.read(file);
			const body = stripFrontmatter(raw).trim();
			if (body.length < this.plugin.settings.minNoteChars) {
				this.renderEmpty(
					`Note is shorter than ${this.plugin.settings.minNoteChars} chars — too small for a useful query. Edit minimum in settings.`
				);
				return;
			}
			const ctx = getLinkContext(this.app, file);
			const query = buildContextualQuery(ctx, body);
			const k = this.plugin.settings.topKSidebar;
			const semantic = await this.plugin.client.querySimilarFiles(query, k * 2, file.path);
			const linkedAsResults = linkedPathsAsResults(this.app, ctx.linkedPaths)
				.filter((r) => r.vaultPath !== file.path);
			const merged = mergeLinkedAndSemantic(semantic, linkedAsResults, {
				linkedPaths: ctx.linkedPaths,
				sortMode: this.sortMode ?? this.plugin.settings.defaultSort,
				linkBoost: this.plugin.settings.linkBoost,
				limit: k,
				app: this.app,
			});
			this.lastResults = { merged, ctx };
			this.renderResults(merged, ctx);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.renderEmpty(`Error: ${msg}`);
		}
	}

	private renderEmpty(text: string) {
		this.listEl.empty();
		const el = this.listEl.createDiv({ cls: "cordycep-empty" });
		el.setText(text);
		this.renderStatus();
	}

	private renderStatus() {
		this.statusEl.empty();
		const s = this.plugin.client.getStatus();
		const dot = this.statusEl.createSpan({ cls: `cordycep-dot ${s.ok ? "ok" : "bad"}` });
		dot.setText("●");
		const text = this.statusEl.createSpan({ cls: "cordycep-status-text" });
		if (s.ok && s.lastLatencyMs != null) {
			text.setText(`backend ok · ${s.lastLatencyMs}ms`);
		} else if (s.lastError) {
			text.setText(s.lastError);
		} else {
			text.setText("idle");
		}
	}

	private renderResults(results: QueryResult[], ctx: LinkContext) {
		this.listEl.empty();
		this.renderStatus();
		if (results.length === 0) {
			this.listEl.createDiv({ cls: "cordycep-empty", text: "No related notes found." });
			return;
		}

		const counts = { forward: 0, back: 0, mutual: 0, none: 0 };
		for (const r of results) counts[classifyLink(r.vaultPath, ctx)]++;
		const countsEl = this.listEl.createDiv({ cls: "cordycep-counts" });
		const parts: string[] = [`${results.length} results`];
		if (counts.forward) parts.push(`${counts.forward} link`);
		if (counts.back) parts.push(`${counts.back} back`);
		if (counts.mutual) parts.push(`${counts.mutual} mutual`);
		if (counts.none) parts.push(`${counts.none} new`);
		countsEl.setText(parts.join(" · "));

		for (const r of results) {
			const kind: LinkKind = classifyLink(r.vaultPath, ctx);
			const linked = kind !== "none";
			const item = this.listEl.createDiv({
				cls: `cordycep-result is-${kind}`,
			});
			item.style.borderLeftColor = this.colorForKind(kind);
			const titleRow = item.createDiv({ cls: "cordycep-title-row" });
			const badge = titleRow.createSpan({
				cls: `cordycep-badge kind-${kind}`,
				attr: { "aria-label": this.labelForKind(kind, true) },
			});
			badge.setText(this.labelForKind(kind, false));
			badge.style.backgroundColor = this.colorForKind(kind);
			badge.style.color = this.contrastInk(this.colorForKind(kind));
			const title = titleRow.createEl("a", {
				cls: "cordycep-title",
				text: r.displayName,
				href: "#",
			});
			title.addEventListener("click", (e) => {
				e.preventDefault();
				this.openResult(r, e.metaKey || e.ctrlKey);
			});
			if (this.plugin.settings.showScores && r.score > 0) {
				const boosted = Math.min(1.5, r.score + (linked ? this.plugin.settings.linkBoost : 0));
				titleRow.createSpan({
					cls: "cordycep-score",
					text: boosted.toFixed(2) + (linked && this.plugin.settings.linkBoost > 0 ? "*" : ""),
					attr: { title: linked ? `Semantic ${r.score.toFixed(2)} + boost ${this.plugin.settings.linkBoost.toFixed(2)}` : "" },
				});
			}
			if (r.snippet) {
				item.createDiv({ cls: "cordycep-snippet", text: r.snippet });
			}
		}
	}

	private colorForKind(kind: LinkKind): string {
		const s = this.plugin.settings;
		switch (kind) {
			case "forward": return s.colorLinked;
			case "back": return s.colorBacklink;
			case "mutual": return s.colorMutual;
			case "none":
			default: return s.colorSemantic;
		}
	}

	private labelForKind(kind: LinkKind, long: boolean): string {
		switch (kind) {
			case "forward": return long ? "Forward link (this note → result)" : "LINK";
			case "back": return long ? "Backlink (result → this note)" : "BACK";
			case "mutual": return long ? "Mutual link (both directions)" : "BOTH";
			case "none":
			default: return long ? "Semantic-only neighbor" : "NEW";
		}
	}

	// Pick legible ink (black/white) for a given hex background.
	private contrastInk(hex: string): string {
		const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
		if (!m) return "#000";
		const v = parseInt(m[1], 16);
		const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
		// Relative luminance approximation
		const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		return lum > 0.6 ? "#0a0a10" : "#f5f5fa";
	}

	private openResult(r: QueryResult, newPane: boolean) {
		if (r.vaultPath) {
			const file = this.app.vault.getAbstractFileByPath(r.vaultPath);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf(newPane).openFile(file);
				return;
			}
		}
		// Fall back to fuzzy linkpath resolution.
		this.app.workspace.openLinkText(r.displayName, "", newPane);
	}
}

// Suppress unused-import warning when MarkdownView isn't directly referenced
// elsewhere — it's part of the view contract.
void MarkdownView;
