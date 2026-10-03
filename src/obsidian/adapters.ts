import { Platform, TFile, TFolder, normalizePath as obsNormalize, requestUrl, type App } from "obsidian";
import type { LocalFs, LocalState, LocalStat, ServerChanges, StateStore } from "../sync/engine";
import type { PlanSummary } from "../sync/plan";

export interface SyncLogEntry {
	at: number;
	trigger: string;
	status: string;
	summary?: PlanSummary;
	errors?: string[];
	warnings?: string[];
	serverChanges?: ServerChanges;
	changes?: string[];
}
import { lowerCaseHeaders, type HttpTransport } from "../webdav/transport";
import { parentOf } from "../webdav/client";
import { CONFIG_DIR, isConfigPath } from "../sync/config";

export const obsidianTransport: HttpTransport = async (req) => {
	const headers = { ...(req.headers ?? {}) };
	const contentType = headers["Content-Type"];
	delete headers["Content-Type"];
	const r = await requestUrl({
		url: req.url,
		method: req.method,
		headers,
		body: req.body,
		contentType,
		throw: false,
	});
	const buf = r.arrayBuffer;
	return {
		status: r.status,
		headers: lowerCaseHeaders(r.headers ?? {}),
		arrayBuffer: buf,
		get text() {
			return new TextDecoder().decode(buf);
		},
	};
};

/**
 * Vault files via the Vault API, so Obsidian's caches stay consistent on every platform.
 * Config files (hidden from the Vault API) go through the adapter. Paths given to and
 * returned by this class are canonical: the config folder is always ".obsidian", mapped
 * to this device's `vault.configDir`.
 */
export class VaultFs implements LocalFs {
	constructor(
		private app: App,
		/** Which canonical config paths to list; null = config sync off. */
		private configFilter: { file: (p: string) => boolean; dir: (p: string) => boolean } | null,
	) {}

	private get configDir() {
		return this.app.vault.configDir;
	}

	private actual(p: string): string {
		return isConfigPath(p) ? this.configDir + p.slice(CONFIG_DIR.length) : p;
	}

	private canonical(p: string): string {
		const cd = this.configDir;
		return p === cd || p.startsWith(cd + "/") ? CONFIG_DIR + p.slice(cd.length) : p;
	}

	async list() {
		const out = this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
		if (this.configFilter) out.push(...(await this.listConfig(CONFIG_DIR)));
		return out;
	}

	private async listConfig(dir: string): Promise<{ path: string; mtime: number; size: number }[]> {
		const f = this.configFilter!;
		const a = this.app.vault.adapter;
		const out: { path: string; mtime: number; size: number }[] = [];
		let listed;
		try {
			listed = await a.list(this.actual(dir));
		} catch {
			return out;
		}
		for (const file of listed.files) {
			const p = this.canonical(file);
			if (!f.file(p)) continue;
			const st = await a.stat(file);
			if (st?.type === "file") out.push({ path: p, mtime: st.mtime, size: st.size });
		}
		for (const sub of listed.folders) {
			const p = this.canonical(sub);
			if (f.dir(p)) out.push(...(await this.listConfig(p)));
		}
		return out;
	}

	async read(path: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(this.actual(path));
	}

	async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalStat> {
		const vault = this.app.vault;
		const opts = mtime ? { mtime } : undefined;
		if (isConfigPath(path)) {
			await this.ensureAdapterFolder(parentOf(this.actual(path)));
			await vault.adapter.writeBinary(this.actual(path), data, opts);
		} else {
			const existing = vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await vault.modifyBinary(existing, data, opts);
			} else {
				await this.ensureFolder(parentOf(path));
				await vault.createBinary(path, data, opts);
			}
		}
		return (await this.stat(path))!;
	}

	private async ensureFolder(dir: string) {
		if (!dir) return;
		const vault = this.app.vault;
		const f = vault.getAbstractFileByPath(dir);
		if (f instanceof TFolder) return;
		await this.ensureFolder(parentOf(dir));
		try {
			await vault.createFolder(dir);
		} catch {
			/* created concurrently, or exists with different case */
		}
	}

	private async ensureAdapterFolder(dir: string) {
		if (!dir) return;
		const a = this.app.vault.adapter;
		if (await a.exists(dir)) return;
		await this.ensureAdapterFolder(parentOf(dir));
		try {
			await a.mkdir(dir);
		} catch {
			/* created concurrently */
		}
	}

	/** Reads the disk, not Obsidian's cache, which can lag behind external edits. */
	async stat(path: string): Promise<LocalStat | null> {
		const st = await this.app.vault.adapter.stat(this.actual(path));
		return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
	}

	async trash(path: string): Promise<void> {
		const f = isConfigPath(path) ? null : this.app.vault.getAbstractFileByPath(path);
		if (f) {
			// Follows the user's "Deleted files" preference. The server keeps its own copy in .sync/trash/.
			await this.app.fileManager.trashFile(f);
			return;
		}
		const adapter = this.app.vault.adapter;
		if (!(await adapter.trashSystem(this.actual(path)))) await adapter.trashLocal(this.actual(path));
	}

	async rename(from: string, to: string): Promise<void> {
		const vault = this.app.vault;
		const f = isConfigPath(from) ? null : vault.getAbstractFileByPath(from);
		if (f instanceof TFile && !isConfigPath(to)) {
			await this.ensureFolder(parentOf(to));
			// Plain rename: links were already updated on the device that did the rename.
			await vault.rename(f, to);
			return;
		}
		await this.ensureAdapterFolder(parentOf(this.actual(to)));
		await vault.adapter.rename(this.actual(from), this.actual(to));
	}

	async removeEmptyDir(dir: string): Promise<boolean> {
		const a = this.app.vault.adapter;
		if (isConfigPath(dir)) {
			// Keep .obsidian and its top-level folders (plugins/, themes/, snippets/).
			if (dir.split("/").length <= 2) return false;
		} else {
			const f = this.app.vault.getAbstractFileByPath(dir);
			if (!(f instanceof TFolder) || f.children.length > 0) return false;
		}
		const listed = await a.list(this.actual(dir));
		if (listed.files.length > 0 || listed.folders.length > 0) return false; // hidden files
		await a.rmdir(this.actual(dir), false);
		return true;
	}
}

/**
 * Local sync state as plain JSON files in the plugin folder (not IndexedDB, which
 * mobile WebViews may evict). Losing them only puts the device into join mode.
 */
export class FileStateStore implements StateStore {
	constructor(private app: App, private dir: string) {}

	private p(name: string) {
		return obsNormalize(`${this.dir}/${name}`);
	}

	private async readJson<T>(name: string): Promise<T | null> {
		const a = this.app.vault.adapter;
		if (!(await a.exists(this.p(name)))) return null;
		return JSON.parse(await a.read(this.p(name))) as T;
	}

	async load(): Promise<LocalState | null> {
		const core = await this.readJson<Omit<LocalState, "base" | "hashCache" | "manifestCache">>("state.json");
		if (!core) return null;
		const base = await this.readJson<LocalState["base"]>("base.json");
		if (!base) return null;
		const hashCache = (await this.readJson<LocalState["hashCache"]>("hashcache.json").catch(() => null)) ?? {};
		const manifestCache = await this.readJson<LocalState["manifestCache"]>("manifest-cache.json").catch(() => null);
		return { ...core, base, hashCache, manifestCache };
	}

	async save(state: LocalState): Promise<void> {
		const a = this.app.vault.adapter;
		if (!(await a.exists(this.dir))) await a.mkdir(this.dir);
		const { base, hashCache, manifestCache, ...core } = state;
		// Order matters: state.json last, so a crash mid-save leaves an older but consistent marker.
		await a.write(this.p("base.json"), JSON.stringify(base));
		await a.write(this.p("hashcache.json"), JSON.stringify(hashCache));
		await a.write(this.p("manifest-cache.json"), JSON.stringify(manifestCache));
		await a.write(this.p("state.json"), JSON.stringify(core, null, 1));
	}

	async clear(): Promise<void> {
		const a = this.app.vault.adapter;
		for (const n of ["state.json", "base.json", "hashcache.json", "manifest-cache.json"]) {
			if (await a.exists(this.p(n))) await a.remove(this.p(n));
		}
	}

	async appendLog(entry: SyncLogEntry, keep = 50): Promise<void> {
		const a = this.app.vault.adapter;
		const name = this.p("sync-log.json");
		let log: unknown[] = [];
		try {
			if (await a.exists(name)) log = JSON.parse(await a.read(name)) as unknown[];
		} catch {
			log = [];
		}
		log.unshift(entry);
		await a.write(name, JSON.stringify(log.slice(0, keep), null, 1));
	}

	async readLog(): Promise<SyncLogEntry[]> {
		try {
			return (await this.readJson<SyncLogEntry[]>("sync-log.json")) ?? [];
		} catch {
			return [];
		}
	}
}

export function platformName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android";
	if (Platform.isMacOS) return "Mac";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "Unknown";
}
