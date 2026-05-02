import { requestUrl, RequestUrlParam } from "obsidian";
import type { CordycepSettings } from "./settings";
import { parseSource } from "./source";

export interface QueryResult {
	vaultPath: string | null;
	displayName: string;
	snippet: string;
	score: number;
	rawSource: string;
}

export interface ClientStatus {
	ok: boolean;
	lastLatencyMs: number | null;
	lastError: string | null;
	kbId: string | null;
}

export class CordycepClient {
	private settings: CordycepSettings;
	private kbIdCache: string | null = null;
	private status: ClientStatus = {
		ok: false,
		lastLatencyMs: null,
		lastError: null,
		kbId: null,
	};
	private listeners = new Set<(s: ClientStatus) => void>();

	constructor(settings: CordycepSettings) {
		this.settings = settings;
	}

	updateSettings(s: CordycepSettings) {
		this.settings = s;
	}

	invalidateKbId() {
		this.kbIdCache = null;
		this.status.kbId = null;
		this.emit();
	}

	getStatus(): ClientStatus {
		return this.status;
	}

	onStatusChange(fn: (s: ClientStatus) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit() {
		for (const fn of this.listeners) fn(this.status);
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.settings.owuiApiKey}`,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(p: RequestUrlParam): Promise<T> {
		const t0 = performance.now();
		try {
			const res = await requestUrl(p);
			this.status = {
				...this.status,
				ok: true,
				lastLatencyMs: Math.round(performance.now() - t0),
				lastError: null,
			};
			this.emit();
			return res.json as T;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			this.status = {
				...this.status,
				ok: false,
				lastLatencyMs: Math.round(performance.now() - t0),
				lastError: msg,
			};
			this.emit();
			throw err;
		}
	}

	async resolveKbId(): Promise<string> {
		if (this.kbIdCache) return this.kbIdCache;
		if (!this.settings.owuiApiKey) {
			throw new Error("OWUI API key is not configured.");
		}
		type KbList = { items?: { id: string; name: string }[] } | { id: string; name: string }[];
		const data = await this.request<KbList>({
			url: `${this.settings.owuiBaseUrl}/api/v1/knowledge/`,
			method: "GET",
			headers: this.headers(),
		});
		const items = Array.isArray(data) ? data : data.items ?? [];
		const match = items.find((k) => k.name === this.settings.kbName);
		if (!match) {
			const names = items.map((k) => k.name).join(", ");
			throw new Error(`KB '${this.settings.kbName}' not found. Available: ${names}`);
		}
		this.kbIdCache = match.id;
		this.status.kbId = match.id;
		this.emit();
		return match.id;
	}

	// Over-fetch + dedupe + exclude self. Use this in views; raw `query`
	// returns whatever chunks the backend hands back, which can all collapse
	// to a single file (or to the active note itself).
	async querySimilarFiles(q: string, k: number, excludePath?: string): Promise<QueryResult[]> {
		const overshoot = Math.max(k * 6 + 10, 30);
		const raw = await this.query(q, overshoot);
		const filtered = excludePath ? raw.filter((r) => r.vaultPath !== excludePath) : raw;
		return filtered.slice(0, k);
	}

	async query(q: string, k: number): Promise<QueryResult[]> {
		if (!q.trim()) return [];
		const kbId = await this.resolveKbId();
		type RetrievalShape = {
			distances?: number[][];
			documents?: string[][];
			metadatas?: { source?: string; name?: string }[][];
		};
		const data = await this.request<RetrievalShape>({
			url: `${this.settings.owuiBaseUrl}/api/v1/retrieval/query/collection`,
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ collection_names: [kbId], query: q, k }),
		});
		const distances = data.distances?.[0] ?? [];
		const documents = data.documents?.[0] ?? [];
		const metadatas = data.metadatas?.[0] ?? [];

		const seen = new Set<string>();
		const out: QueryResult[] = [];
		for (let i = 0; i < documents.length; i++) {
			const meta = metadatas[i] ?? {};
			const raw = meta.source ?? meta.name ?? "";
			const parsed = parseSource(raw);
			const key = parsed.vaultPath ?? raw;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				vaultPath: parsed.vaultPath,
				displayName: parsed.displayName,
				snippet: stripSourceHeader(documents[i] ?? "").slice(0, 240),
				score: distances[i] ?? 0,
				rawSource: raw,
			});
		}
		return out;
	}
}

function stripSourceHeader(content: string): string {
	// Notes are ingested with `Source: <path>\n\n---\n\n<body>`. Strip that
	// header from snippets so the user sees real content.
	const m = content.match(/^Source:\s.*?\n+---\n+/);
	return m ? content.slice(m[0].length) : content;
}
