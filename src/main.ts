import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import {
	CordycepSettings,
	DEFAULT_SETTINGS,
	CordycepSettingTab,
} from "./settings";
import { CordycepClient } from "./client";
import { RelatedNotesView, RELATED_VIEW_TYPE } from "./view-related";
import { NeighborhoodGraphView, GRAPH_VIEW_TYPE } from "./view-graph";
import { SemanticSearchModal } from "./palette";
import { NoteSourcePickerModal } from "./note-picker";

export default class CordycepSemanticPlugin extends Plugin {
	settings!: CordycepSettings;
	client!: CordycepClient;

	async onload() {
		await this.loadSettings();
		this.client = new CordycepClient(this.settings);

		this.registerView(
			RELATED_VIEW_TYPE,
			(leaf) => new RelatedNotesView(leaf, this)
		);
		this.registerView(
			GRAPH_VIEW_TYPE,
			(leaf) => new NeighborhoodGraphView(leaf, this)
		);

		this.addRibbonIcon("sparkles", "Cordycep: related notes", () => {
			void this.activateView(RELATED_VIEW_TYPE, "right");
		});

		this.addCommand({
			id: "open-related-notes",
			name: "Open related notes sidebar",
			callback: () => void this.activateView(RELATED_VIEW_TYPE, "right"),
		});

		this.addCommand({
			id: "open-neighborhood-graph",
			name: "Open neighborhood graph",
			callback: () => void this.activateView(GRAPH_VIEW_TYPE, "tab"),
		});

		this.addCommand({
			id: "semantic-search",
			name: "Semantic search…",
			callback: () => new SemanticSearchModal(this.app, this).open(),
		});

		this.addCommand({
			id: "find-similar-to-note",
			name: "Find notes similar to…",
			callback: () => new NoteSourcePickerModal(this.app, this).open(),
		});

		this.addSettingTab(new CordycepSettingTab(this.app, this));

		// Probe the backend once on load so the user sees obvious failures
		// (bad URL, missing key, KB not found) without opening a view.
		this.app.workspace.onLayoutReady(() => {
			void this.client.resolveKbId().catch((err) => {
				new Notice(`Cordycep Semantic: ${err.message}`);
			});
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.client.updateSettings(this.settings);
	}

	invalidateKbId() {
		this.client.invalidateKbId();
	}

	private async activateView(type: string, where: "right" | "tab") {
		const existing = this.app.workspace.getLeavesOfType(type);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf: WorkspaceLeaf | null =
			where === "right"
				? this.app.workspace.getRightLeaf(false)
				: this.app.workspace.getLeaf("tab");
		if (leaf) {
			await leaf.setViewState({ type, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(RELATED_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(GRAPH_VIEW_TYPE);
	}
}
