import { App, FuzzySuggestModal, Modal, TFile, setIcon } from "obsidian";
import type CordycepSemanticPlugin from "./main";
import { buildLinkGraph, shortestPath, PathStep, resolveFile } from "./graph";
import { NoteSourcePickerModal } from "./note-picker";

// Step 1: pick the destination note. Step 2 (PathResultModal) computes and
// renders the shortest wikilink path from the active note to it.
export class PathTargetPickerModal extends FuzzySuggestModal<TFile> {
	private plugin: CordycepSemanticPlugin;
	private origin: TFile;

	constructor(app: App, plugin: CordycepSemanticPlugin, origin: TFile) {
		super(app);
		this.plugin = plugin;
		this.origin = origin;
		this.setPlaceholder(`Connect “${origin.basename}” to which note?`);
	}

	getItems(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path !== this.origin.path)
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(target: TFile): void {
		const graph = buildLinkGraph(this.app);
		const steps = shortestPath(graph, this.origin.path, target.path);
		new PathResultModal(this.app, this.plugin, this.origin, target, steps).open();
	}
}

export class PathResultModal extends Modal {
	private plugin: CordycepSemanticPlugin;
	private origin: TFile;
	private target: TFile;
	private steps: PathStep[] | null;

	constructor(
		app: App,
		plugin: CordycepSemanticPlugin,
		origin: TFile,
		target: TFile,
		steps: PathStep[] | null
	) {
		super(app);
		this.plugin = plugin;
		this.origin = origin;
		this.target = target;
		this.steps = steps;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cordycep-path-modal");

		contentEl.createEl("h3", {
			text: `${this.origin.basename} → ${this.target.basename}`,
		});

		if (!this.steps) {
			this.renderNoPath(contentEl);
			return;
		}

		const hops = this.steps.length - 1;
		contentEl.createDiv({
			cls: "cordycep-path-sub",
			text: `Connected in ${hops} link ${hops === 1 ? "hop" : "hops"}.`,
		});

		const list = contentEl.createDiv({ cls: "cordycep-path-list" });
		this.steps.forEach((step, i) => {
			if (i > 0) this.renderConnector(list, step);
			this.renderStep(list, step, i === 0, i === this.steps!.length - 1);
		});
	}

	private renderStep(
		parent: HTMLElement,
		step: PathStep,
		isFirst: boolean,
		isLast: boolean
	) {
		const row = parent.createDiv({ cls: "cordycep-path-step" });
		const dot = row.createSpan({ cls: "cordycep-path-dot" });
		if (isFirst) dot.addClass("is-origin");
		if (isLast) dot.addClass("is-target");

		const name = step.path.split("/").pop()!.replace(/\.md$/, "");
		const link = row.createEl("a", {
			cls: "cordycep-path-name",
			text: name,
			href: "#",
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			const file = resolveFile(this.app, step.path);
			if (file) {
				this.app.workspace.getLeaf(e.metaKey || e.ctrlKey).openFile(file);
			} else {
				this.app.workspace.openLinkText(name, "", e.metaKey || e.ctrlKey);
			}
		});
		row.createSpan({ cls: "cordycep-path-folder", text: step.path });
	}

	// The arrow between two steps, showing which way the wikilink actually
	// points. forward = previous note links to this one; back = this one links
	// to the previous; both = mutual link.
	private renderConnector(parent: HTMLElement, step: PathStep) {
		const conn = parent.createDiv({ cls: "cordycep-path-connector" });
		const icon = conn.createSpan({ cls: "cordycep-path-arrow" });
		let iconName: string;
		let label: string;
		switch (step.direction) {
			case "forward":
				iconName = "arrow-down";
				label = "links to";
				break;
			case "back":
				iconName = "arrow-up";
				label = "linked from";
				break;
			case "both":
			default:
				iconName = "arrow-up-down";
				label = "mutual link";
				break;
		}
		setIcon(icon, iconName);
		conn.createSpan({ cls: "cordycep-path-arrow-label", text: label });
	}

	private renderNoPath(parent: HTMLElement) {
		const box = parent.createDiv({ cls: "cordycep-path-empty" });
		box.createDiv({
			cls: "cordycep-path-sub",
			text: "No wikilink path connects these notes — they're in different link clusters of your vault.",
		});
		const hint = box.createDiv({ cls: "cordycep-path-hint" });
		hint.setText(
			"Semantic search can still surface a bridge between them. Run “Find notes similar to…” on either note to look for a conceptual link the wikilinks don't capture."
		);
		const btn = box.createEl("button", {
			cls: "mod-cta",
			text: "Find a semantic bridge instead",
		});
		btn.addEventListener("click", () => {
			this.close();
			new NoteSourcePickerModal(this.app, this.plugin).open();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
