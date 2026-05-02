// Map an OWUI document filename back to a vault relative path.
//
// Two formats may appear in the KB:
//   - New (post-2026-05-02): `Obsidian‖Walk of Life‖Foo.md.txt` — clean
//     U+2016 separator that survives OWUI's basename. Reverse by stripping
//     prefix/suffix and replacing ‖ with /.
//   - Legacy: `Obsidian::Walk_of_Life-Foo.md.txt` — slashes were turned
//     into '-' and spaces into '_'. Best-effort reverse: split on '-' for
//     path segments, then '_' → ' ' inside each segment. Real underscores
//     and dashes in filenames will still mis-resolve.

const NEW_PREFIX = "Obsidian\u2016";
const LEGACY_PREFIX = "Obsidian::";
const SEP = "\u2016";

export interface ParsedSource {
	vaultPath: string | null;
	displayName: string;
	format: "new" | "legacy" | "unknown";
}

export function parseSource(rawSource: string | undefined): ParsedSource {
	if (!rawSource) {
		return { vaultPath: null, displayName: "(unknown)", format: "unknown" };
	}

	const stripped = rawSource.replace(/\.txt$/i, "");

	if (stripped.startsWith(NEW_PREFIX)) {
		const path = stripped.slice(NEW_PREFIX.length).split(SEP).join("/");
		return { vaultPath: path, displayName: basename(path), format: "new" };
	}

	if (stripped.startsWith(LEGACY_PREFIX)) {
		const body = stripped.slice(LEGACY_PREFIX.length);
		const segments = body.split("-").map((s) => s.replaceAll("_", " "));
		const path = segments.join("/");
		return { vaultPath: path, displayName: basename(path), format: "legacy" };
	}

	return { vaultPath: null, displayName: stripped, format: "unknown" };
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	const file = i >= 0 ? p.slice(i + 1) : p;
	return file.replace(/\.md$/i, "");
}
