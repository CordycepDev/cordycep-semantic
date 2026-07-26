import { App, PluginSettingTab, Setting } from "obsidian";
import type CordycepSemanticPlugin from "./main";

export type SortMode = "linked-then-score" | "score" | "linked-then-name" | "recent";

export interface CordycepSettings {
	owuiBaseUrl: string;
	apiBaseUrl: string;
	owuiApiKey: string;
	kbName: string;
	topKSidebar: number;
	topKPalette: number;
	sidebarLinkHops: number;      // 0 = off; N = also show notes within N wikilink hops of the active note + its top semantic hits
	graphFirstRingN: number;
	graphSecondRingM: number;
	graphScoreFloor: number;
	graphDebounceMs: number;
	sidebarDebounceMs: number;
	paletteDebounceMs: number;
	minNoteChars: number;
	showScores: boolean;
	defaultSort: SortMode;
	linkBoost: number;            // additive score boost applied to linked-to-active results
	graphOpensInRightSidebar: boolean;
	colorCenter: string;
	colorLinked: string;          // forward link (this note → result)
	colorBacklink: string;        // back link (result → this note)
	colorMutual: string;          // both directions
	colorSemantic: string;        // semantic-only
	colorBackground: string;
	colorHoverRing: string;       // outline shown around the hovered node
	colorNodeLabel: string;       // node-label ink in graph
	colorFolderFallback: string;  // node color when folder isn't in folderPalette
	folderPalette: string;        // JSON map: { "Walk of Life": "#...", ... } — empty/invalid = defaults
	graphAccumulate: boolean;     // keep nodes/edges from previous active notes pinned in place
}

export const DEFAULT_SETTINGS: CordycepSettings = {
	owuiBaseUrl: "https://chat.cordycep.dev",
	apiBaseUrl: "https://api.cordycep.dev",
	owuiApiKey: "",
	kbName: "Obsidian Vault",
	topKSidebar: 10,
	topKPalette: 15,
	sidebarLinkHops: 0,
	graphFirstRingN: 12,
	graphSecondRingM: 5,
	graphScoreFloor: 0.55,
	graphDebounceMs: 1000,
	sidebarDebounceMs: 600,
	paletteDebounceMs: 250,
	minNoteChars: 200,
	showScores: true,
	defaultSort: "linked-then-score",
	linkBoost: 0.20,
	graphOpensInRightSidebar: true,
	colorCenter: "#ff9e64",
	colorLinked: "#ff9e64",     // orange — forward
	colorBacklink: "#bb9af7",   // purple — back
	colorMutual: "#9ece6a",     // green — mutual
	colorSemantic: "#7dcfff",   // blue — semantic-only
	colorBackground: "#0d0d12",
	colorHoverRing: "#ffffff",
	colorNodeLabel: "#e1e1eb",
	colorFolderFallback: "#7dcfff",
	graphAccumulate: false,
	folderPalette: '{"Walk of Life":"#7aa2f7","Zen":"#9ece6a","Academy":"#e0af68","(root)":"#bb9af7"}',
};

export class CordycepSettingTab extends PluginSettingTab {
	plugin: CordycepSemanticPlugin;

	constructor(app: App, plugin: CordycepSemanticPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Cordycep Semantic" });

		new Setting(containerEl)
			.setName("Open WebUI base URL")
			.setDesc("Base URL of your OWUI instance, e.g. https://chat.cordycep.dev")
			.addText((t) =>
				t
					.setPlaceholder("https://chat.cordycep.dev")
					.setValue(this.plugin.settings.owuiBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.owuiBaseUrl = v.trim().replace(/\/$/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Base URL of ai-agent-api, e.g. https://api.cordycep.dev")
			.addText((t) =>
				t
					.setPlaceholder("https://api.cordycep.dev")
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.apiBaseUrl = v.trim().replace(/\/$/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("OWUI API key")
			.setDesc("Bearer token for Open WebUI. Stored in this vault's plugin data.")
			.addText((t) => {
				t.inputEl.type = "password";
				t
					.setPlaceholder("sk-…")
					.setValue(this.plugin.settings.owuiApiKey)
					.onChange(async (v) => {
						this.plugin.settings.owuiApiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Knowledge base name")
			.setDesc("OWUI KB to query. Resolved to its id at startup and cached.")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.kbName)
					.onChange(async (v) => {
						this.plugin.settings.kbName = v.trim();
						this.plugin.invalidateKbId();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Sidebar & palette" });

		new Setting(containerEl)
			.setName("Top K (sidebar)")
			.addSlider((s) =>
				s
					.setLimits(3, 25, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.topKSidebar)
					.onChange(async (v) => {
						this.plugin.settings.topKSidebar = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Top K (palette)")
			.addSlider((s) =>
				s
					.setLimits(3, 30, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.topKPalette)
					.onChange(async (v) => {
						this.plugin.settings.topKPalette = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Link-hop expansion (sidebar)")
			.setDesc(
				"Also list notes within N wikilink hops of the active note and its top semantic hits, in a separate section below the ranked results. 0 = off. This is the multi-hop / relational layer semantic search alone can't surface."
			)
			.addSlider((s) =>
				s
					.setLimits(0, 3, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.sidebarLinkHops)
					.onChange(async (v) => {
						this.plugin.settings.sidebarLinkHops = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sidebar debounce (ms)")
			.addSlider((s) =>
				s
					.setLimits(150, 2000, 50)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.sidebarDebounceMs)
					.onChange(async (v) => {
						this.plugin.settings.sidebarDebounceMs = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Palette debounce (ms)")
			.addSlider((s) =>
				s
					.setLimits(100, 1000, 25)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.paletteDebounceMs)
					.onChange(async (v) => {
						this.plugin.settings.paletteDebounceMs = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Neighborhood graph" });

		new Setting(containerEl)
			.setName("First-ring N")
			.setDesc("Nearest neighbors of the active note.")
			.addSlider((s) =>
				s
					.setLimits(4, 30, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.graphFirstRingN)
					.onChange(async (v) => {
						this.plugin.settings.graphFirstRingN = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Second-ring M")
			.setDesc("Nearest neighbors of each first-ring note.")
			.addSlider((s) =>
				s
					.setLimits(0, 15, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.graphSecondRingM)
					.onChange(async (v) => {
						this.plugin.settings.graphSecondRingM = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Edge similarity floor")
			.setDesc("Edges with score below this are dropped.")
			.addSlider((s) =>
				s
					.setLimits(0, 0.95, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.graphScoreFloor)
					.onChange(async (v) => {
						this.plugin.settings.graphScoreFloor = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Graph debounce (ms)")
			.addSlider((s) =>
				s
					.setLimits(300, 3000, 100)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.graphDebounceMs)
					.onChange(async (v) => {
						this.plugin.settings.graphDebounceMs = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Misc" });

		new Setting(containerEl)
			.setName("Min note length (chars)")
			.setDesc("Skip notes smaller than this when computing related/graph queries.")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.minNoteChars))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						if (Number.isFinite(n) && n >= 0) {
							this.plugin.settings.minNoteChars = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Show scores in UI")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showScores)
					.onChange(async (v) => {
						this.plugin.settings.showScores = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default sort (sidebar)")
			.addDropdown((d) =>
				d
					.addOption("linked-then-score", "Linked first, then score")
					.addOption("score", "Score (semantic)")
					.addOption("linked-then-name", "Linked first, then alphabetical")
					.addOption("recent", "Recently modified")
					.setValue(this.plugin.settings.defaultSort)
					.onChange(async (v) => {
						this.plugin.settings.defaultSort = v as SortMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Backlink boost")
			.setDesc("Additive bonus on the displayed/sort score for results that have an explicit wikilink to/from the active note.")
			.addSlider((s) =>
				s
					.setLimits(0, 0.5, 0.05)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.linkBoost)
					.onChange(async (v) => {
						this.plugin.settings.linkBoost = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Graph opens in right sidebar")
			.setDesc("Off = open as a new tab.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.graphOpensInRightSidebar)
					.onChange(async (v) => {
						this.plugin.settings.graphOpensInRightSidebar = v;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Colors (graph)" });

		type ColorKey =
			| "colorCenter" | "colorLinked" | "colorBacklink" | "colorMutual"
			| "colorSemantic" | "colorBackground" | "colorHoverRing"
			| "colorNodeLabel" | "colorFolderFallback";
		const colorRow = (label: string, key: ColorKey, desc?: string) =>
			new Setting(containerEl)
				.setName(label)
				.setDesc(desc ?? "")
				.addText((t) => {
					t.inputEl.type = "color";
					t.setValue(this.plugin.settings[key]).onChange(async (v) => {
						this.plugin.settings[key] = v;
						await this.plugin.saveSettings();
					});
				});

		colorRow("Center node", "colorCenter", "The active note in the graph.");
		colorRow("Forward link (LINK)", "colorLinked", "This note → result note.");
		colorRow("Backlink (BACK)", "colorBacklink", "Result note → this note.");
		colorRow("Mutual link (BOTH)", "colorMutual", "Both directions linked.");
		colorRow("Semantic edges", "colorSemantic", "Color for semantic-only edges (NEW results).");
		colorRow("Graph background", "colorBackground");
		colorRow("Hover ring", "colorHoverRing", "Outline drawn around the hovered node.");
		colorRow("Node label", "colorNodeLabel", "Text color for node names + scores.");
		colorRow("Folder fallback", "colorFolderFallback", "Used when a node's top-level folder isn't in the palette below.");

		new Setting(containerEl)
			.setName("Accumulate graph across navigations")
			.setDesc("Keep nodes from previous active notes pinned in place when you navigate. Use the 'Reset graph' command to clear.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.graphAccumulate)
					.onChange(async (v) => {
						this.plugin.settings.graphAccumulate = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Folder palette")
			.setDesc('JSON map from top-level folder name to hex color. Use "(root)" for root-level notes. Invalid JSON falls back to defaults.')
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.inputEl.style.fontFamily = "var(--font-monospace)";
				t.inputEl.style.fontSize = "12px";
				t.inputEl.style.width = "100%";
				t.setValue(this.plugin.settings.folderPalette).onChange(async (v) => {
					this.plugin.settings.folderPalette = v;
					await this.plugin.saveSettings();
				});
			});
	}
}
