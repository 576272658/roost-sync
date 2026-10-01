import { Platform, TFile, TFolder, normalizePath as obsNormalize, requestUrl, type App } from "obsidian";
import type { LocalFs, LocalState, LocalStat, StateStore } from "../sync/engine";
import { lowerCaseHeaders, type HttpTransport } from "../webdav/transport";
import { parentOf } from "../webdav/client";

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

/** Vault files via the Vault API, so Obsidian's caches stay consistent on every platform. */
export class VaultFs implements LocalFs {
	constructor(private app: App) {}

	async list() {
		return this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
	}

	async read(path: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(path);
	}

	async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalStat> {
		const vault = this.app.vault;
		const opts = mtime ? { mtime } : undefined;
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await vault.modifyBinary(existing, data, opts);
		} else {
			await this.ensureFolder(parentOf(path));
			await vault.createBinary(path, data, opts);
		}
		const st = (await this.stat(path))!;
		return st;
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

	/** Reads the disk, not Obsidian's cache, which can lag behind external edits. */
	async stat(path: string): Promise<LocalStat | null> {
		const st = await this.app.vault.adapter.stat(path);
		return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
	}

	async trash(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f) {
			// system=true: OS trash on desktop; Obsidian falls back to the vault's .trash/ (mobile).
			await this.app.vault.trash(f, true);
			return;
		}
		const adapter = this.app.vault.adapter;
		if (!(await adapter.trashSystem(path))) await adapter.trashLocal(path);
	}

	async removeEmptyDir(dir: string): Promise<boolean> {
		const f = this.app.vault.getAbstractFileByPath(dir);
		if (!(f instanceof TFolder) || f.children.length > 0) return false;
		const listed = await this.app.vault.adapter.list(dir);
		if (listed.files.length > 0 || listed.folders.length > 0) return false; // hidden files
		await this.app.vault.adapter.rmdir(dir, false);
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
		return { ...core, base, hashCache, manifestCache } as LocalState;
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

	async appendLog(entry: unknown, keep = 50): Promise<void> {
		const a = this.app.vault.adapter;
		const name = this.p("sync-log.json");
		let log: unknown[] = [];
		try {
			if (await a.exists(name)) log = JSON.parse(await a.read(name));
		} catch {
			log = [];
		}
		log.unshift(entry);
		await a.write(name, JSON.stringify(log.slice(0, keep), null, 1));
	}

	async readLog(): Promise<any[]> {
		try {
			return (await this.readJson<any[]>("sync-log.json")) ?? [];
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
