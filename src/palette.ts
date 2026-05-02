import { App, SuggestModal, TFile } from "obsidian";
import type CordycepSemanticPlugin from "./main";
import type { QueryResult } from "./client";
import { debounce } from "./util";
import { classifyLink, LinkKind } from "./links";

export interface PaletteOptions {
	prefilledQuery?: string;
	header?: string;
	excludePath?: string;
	forwardPaths?: Set<string>;
	backPaths?: Set<string>;
}

export class SemanticSearchModal extends SuggestModal<QueryResult> {
	private plugin: CordycepSemanticPlugin;
	private debouncedQuery: (q: string) => void;
	private latestQuery = "";
	private resolveSuggestions: ((r: QueryResult[]) => void) | null = null;
	private opts: PaletteOptions;

	constructor(app: App, plugin: CordycepSemanticPlugin, opts: PaletteOptions = {}) {
		super(app);
		this.plugin = plugin;
		this.opts = opts;
		this.setPlaceholder(opts.header ?? "Search vault by meaning…");
		this.debouncedQuery = debounce((q: string) => {
			void this.runQuery(q);
		}, this.plugin.settings.paletteDebounceMs);
	}

	onOpen() {
		super.onOpen();
		if (this.opts.header) {
			const head = this.modalEl.createDiv({ cls: "cordycep-modal-header" });
			head.setText(this.opts.header);
			this.modalEl.prepend(head);
		}
		if (this.opts.prefilledQuery) {
			// Run the prefilled query immediately rather than waiting for input.
			this.latestQuery = "__prefilled__";
			void this.runQuery(this.opts.prefilledQuery);
			// Hide the input — searching is fixed to the prefilled note's content.
			(this.inputEl.parentElement as HTMLElement).style.display = "none";
		}
	}

	getSuggestions(query: string): Promise<QueryResult[]> {
		if (this.opts.prefilledQuery) {
			// In prefilled mode the user can't change the query.
			return Promise.resolve([]);
		}
		this.latestQuery = query.trim();
		if (!this.latestQuery) {
			return Promise.resolve([]);
		}
		this.debouncedQuery(this.latestQuery);
		return new Promise((resolve) => {
			this.resolveSuggestions = resolve;
		});
	}

	private async runQuery(q: string) {
		try {
			const results = await this.plugin.client.query(
				q,
				this.plugin.settings.topKPalette
			);
			const filtered = this.opts.excludePath
				? results.filter((r) => r.vaultPath !== this.opts.excludePath)
				: results;
			if (this.opts.prefilledQuery) {
				// Force the suggestion list to re-render with the prefilled results.
				(this as unknown as { chooser: { setSuggestions: (r: QueryResult[]) => void } }).chooser.setSuggestions(filtered);
				return;
			}
			if (q !== this.latestQuery) return;
			this.resolveSuggestions?.(filtered);
			this.resolveSuggestions = null;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const errorItem: QueryResult = {
				vaultPath: null,
				displayName: `Error: ${msg}`,
				snippet: "",
				score: 0,
				rawSource: "",
			};
			if (this.opts.prefilledQuery) {
				(this as unknown as { chooser: { setSuggestions: (r: QueryResult[]) => void } }).chooser.setSuggestions([errorItem]);
				return;
			}
			this.resolveSuggestions?.([errorItem]);
			this.resolveSuggestions = null;
		}
	}

	renderSuggestion(value: QueryResult, el: HTMLElement) {
		el.addClass("cordycep-suggestion");
		const ctx = {
			forwardPaths: this.opts.forwardPaths ?? new Set<string>(),
			backPaths: this.opts.backPaths ?? new Set<string>(),
		};
		const kind: LinkKind = classifyLink(value.vaultPath, ctx);
		el.addClass(`is-${kind}`);

		const titleRow = el.createDiv({ cls: "cordycep-title-row" });
		if (value.vaultPath) {
			const badge = titleRow.createSpan({
				cls: `cordycep-badge kind-${kind}`,
			});
			badge.setText(this.labelForKind(kind));
			badge.style.backgroundColor = this.colorForKind(kind);
			badge.style.color = this.contrastInk(this.colorForKind(kind));
		}
		titleRow.createSpan({ cls: "cordycep-title", text: value.displayName });
		if (this.plugin.settings.showScores && value.score) {
			titleRow.createSpan({
				cls: "cordycep-score",
				text: value.score.toFixed(2),
			});
		}
		if (value.snippet) {
			el.createDiv({ cls: "cordycep-snippet", text: value.snippet });
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

	private labelForKind(kind: LinkKind): string {
		switch (kind) {
			case "forward": return "LINK";
			case "back": return "BACK";
			case "mutual": return "BOTH";
			case "none":
			default: return "NEW";
		}
	}

	private contrastInk(hex: string): string {
		const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
		if (!m) return "#000";
		const v = parseInt(m[1], 16);
		const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
		const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		return lum > 0.6 ? "#0a0a10" : "#f5f5fa";
	}

	onChooseSuggestion(item: QueryResult, evt: MouseEvent | KeyboardEvent) {
		const newPane = evt.metaKey || evt.ctrlKey;
		if (item.vaultPath) {
			const file = this.app.vault.getAbstractFileByPath(item.vaultPath);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf(newPane).openFile(file);
				return;
			}
		}
		this.app.workspace.openLinkText(item.displayName, "", newPane);
	}
}
