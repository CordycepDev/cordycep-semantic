// Bundle the graph tests with `obsidian` aliased to a local stub, then run.
// esbuild is already a devDependency, so no extra tooling is needed.
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, ".graph.test.cjs");

await esbuild.build({
	entryPoints: [path.join(dir, "graph.test.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: out,
	alias: { obsidian: path.join(dir, "obsidian-stub.ts") },
	logLevel: "warning",
});

await import(out);
