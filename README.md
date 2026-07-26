# Cordycep Semantic — Obsidian plugin

Self-hosted semantic search, related-notes sidebar, and neighborhood graph for an Obsidian vault, backed by the cordycep.dev stack (Open WebUI knowledge base + Gemini embeddings).

## Install via BRAT

1. In Obsidian, install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. BRAT → "Add beta plugin" → enter `CordycepDev/cordycep-semantic`.
3. BRAT pulls the latest release, installs it under `.obsidian/plugins/cordycep-semantic/`, and watches for new versions.
4. In Obsidian → Settings → Community plugins → enable `Cordycep Semantic`.
5. In Settings → Cordycep Semantic → paste your OWUI API key.

Updates: bump `manifest.json` version, push, BRAT picks it up on its next "Check for updates".

## What it does

- **Related notes sidebar** — opens in the right pane, updates whenever the active note changes, lists semantically similar notes pulled from the `Obsidian Vault` OWUI knowledge base. Shows a `LINKED` badge for notes already wikilinked from the active note, `NEW` for purely-semantic neighbors. Counts header summarises N results / M linked / K new.
- **Semantic search palette** — command `Cordycep: Semantic search…`. Free-text query, ranked results, same `LINKED`/`NEW` badges.
- **Find notes similar to…** — command picks any note via fuzzy file picker; results modal shows that note's semantic neighbors.
- **Neighborhood graph** — command `Cordycep: Open neighborhood graph`. d3-force canvas centered on the active note. First ring = nearest N neighbors, second ring = nearest M of each first-ring node. Solid warm edges = explicit Obsidian links; dashed cool edges = semantic-only. Edge midpoints render the similarity score; node labels include their best score inline. Linked-to-center nodes get a warm halo.
- **Connection path (multi-hop)** — command `Cordycep: Find connection path to…`. Pick any target note; the plugin BFS-searches your `[[wikilink]]` graph for the shortest link chain from the active note to it and renders each hop with the actual link direction (`links to` / `linked from` / `mutual`). This is the graph-native, relational query semantic similarity can't answer — "how are these two notes connected?" If no wikilink path exists, it offers a semantic-bridge fallback. Traversal is pure local computation over `metadataCache.resolvedLinks` — no backend round-trip.
- **Link-hop expansion in the sidebar** — optional (`Link-hop expansion` setting, default off). When set to N≥1, the related-notes sidebar adds a separate "Link neighborhood" section listing notes within N wikilink hops of the active note *and its top semantic hits* — the multi-hop context that's link-connected to your strong matches but not directly similar to the active note. Each entry shows its hop distance (`1h`, `2h`). Keeps the semantic ranking above it untouched.

## Backend assumptions

- `https://chat.cordycep.dev/api/v1/retrieval/query/collection` returns Chroma-shaped results.
- A KB named `Obsidian Vault` exists in OWUI and is kept in sync by `ai-agent-obsidian-ingester`.
- Ingester writes upload filenames as `Obsidian‖<vault path with ‖>.txt` so the plugin can recover real vault paths from query metadata. Older docs with the legacy `Obsidian::<mangled>` format still resolve via best-effort parsing.

The plugin's settings tab covers the OWUI base URL, API key, KB name, top-K values, debounce, score floor, and ring sizes.

## Build from source

```bash
npm install
npm run build
```

This produces `main.js` at the repo root next to `manifest.json` and `styles.css` — exactly the layout BRAT expects.

## Releasing

1. Edit source under `src/`.
2. `npm run build`.
3. Bump `version` in both `manifest.json` and `package.json`.
4. `git commit -am "vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags`.
5. (Optional) create a GitHub release with `main.js`, `manifest.json`, `styles.css` attached so BRAT users can pin to a specific release.
