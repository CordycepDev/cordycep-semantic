// Minimal stand-ins for the Obsidian symbols graph.ts imports at module load.
// The pure traversal functions under test never touch these; they exist only
// so the bundle resolves `import { App, TFile } from "obsidian"`.
export class App {}
export class TFile {}
