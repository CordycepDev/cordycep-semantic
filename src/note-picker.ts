import { App, FuzzySuggestModal, TFile, Notice } from "obsidian";
import type CordycepSemanticPlugin from "./main";
import { SemanticSearchModal } from "./palette";
import { stripFrontmatter } from "./util";
import { getLinkContext, buildContextualQuery } from "./links";

// Two-step "find notes similar to a chosen note":
//   1. NoteSourcePickerModal — fuzzy file picker over all markdown notes.
//   2. After pick, run semantic search using that note's body as the query
//      and reuse SemanticSearchModal to display results.
export class NoteSourcePickerModal extends FuzzySuggestModal<TFile> {
	private plugin: CordycepSemanticPlugin;

	constructor(app: App, plugin: CordycepSemanticPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("Pick a note — its content will be the query…");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	async onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent) {
		try {
			const raw = await this.app.vault.read(file);
			const body = stripFrontmatter(raw).trim();
			if (body.length < this.plugin.settings.minNoteChars) {
				new Notice(`Note is too short (${body.length} chars) — see plugin settings.`);
				return;
			}
			const ctx = getLinkContext(this.app, file);
			const query = buildContextualQuery(ctx, body);
			const modal = new SemanticSearchModal(this.app, this.plugin, {
				prefilledQuery: query,
				header: `Notes similar to: ${file.basename}`,
				excludePath: file.path,
				forwardPaths: ctx.forwardPaths,
				backPaths: ctx.backPaths,
			});
			modal.open();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Cordycep Semantic: ${msg}`);
		}
	}
}
