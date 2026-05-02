import { ItemView, WorkspaceLeaf, TFile, MarkdownView, setIcon } from "obsidian";
import type CordycepSemanticPlugin from "./main";
import type { QueryResult } from "./client";
import { debounce, stripFrontmatter } from "./util";
import { getLinkContext, buildContextualQuery, linkedPathsAsResults, mergeLinkedAndSemantic } from "./links";

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
		const refresh = header.createEl("button", { cls: "cordycep-icon-btn", attr: { "aria-label": "Refresh" } });
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
			const merged = mergeLinkedAndSemantic(semantic, linkedAsResults, ctx.linkedPaths, k);
			this.renderResults(merged, ctx.linkedPaths);
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

	private renderResults(results: QueryResult[], linkedPaths: Set<string>) {
		this.listEl.empty();
		this.renderStatus();
		if (results.length === 0) {
			this.listEl.createDiv({ cls: "cordycep-empty", text: "No related notes found." });
			return;
		}
		const linkedCount = results.filter((r) => r.vaultPath && linkedPaths.has(r.vaultPath)).length;
		const counts = this.listEl.createDiv({ cls: "cordycep-counts" });
		counts.setText(`${results.length} results · ${linkedCount} linked · ${results.length - linkedCount} new`);

		for (const r of results) {
			const linked = r.vaultPath ? linkedPaths.has(r.vaultPath) : false;
			const item = this.listEl.createDiv({
				cls: `cordycep-result ${linked ? "is-linked" : "is-unlinked"}`,
			});
			const titleRow = item.createDiv({ cls: "cordycep-title-row" });
			const badge = titleRow.createSpan({
				cls: `cordycep-badge ${linked ? "linked" : "unlinked"}`,
				attr: { "aria-label": linked ? "Already linked" : "Not linked" },
			});
			badge.setText(linked ? "LINKED" : "NEW");
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
				titleRow.createSpan({
					cls: "cordycep-score",
					text: r.score.toFixed(2),
				});
			}
			if (r.snippet) {
				item.createDiv({ cls: "cordycep-snippet", text: r.snippet });
			}
		}
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
