import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine, type LocalFs, type LocalState, type LocalStat, type StateStore, type SyncUI, type PlanReview, type InitReview } from "../src/sync/engine";
import { RemoteRepo } from "../src/sync/remote";
import { WebDavClient } from "../src/webdav/client";
import { fetchTransport } from "../src/webdav/transport";
import { DEFAULT_IGNORES, IgnoreRules } from "../src/util/paths";
import { randomId } from "../src/util/hash";
import type { AskChoice } from "../src/sync/types";

// ---------- WsgiDAV 4.3.3 (same version as the production server) ----------

export const hasUvx = spawnSync("uvx", ["--version"]).status === 0;

export async function startWsgiDav(): Promise<{ url: string; root: string; stop: () => void }> {
	const root = mkdtempSync(join(tmpdir(), "roost-dav-"));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proc: ChildProcess = spawn(
		"uvx",
		["--from", "wsgidav==4.3.3", "--with", "cheroot==11.1.2", "--with", "lxml", "wsgidav",
			"--host", "127.0.0.1", "--port", String(port), "--root", root, "--auth", "anonymous", "-q"],
		{ stdio: "ignore" },
	);
	const url = `http://127.0.0.1:${port}/`;
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(url, { method: "PROPFIND", headers: { Depth: "0" } });
			if (r.status === 207) break;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return {
		url,
		root,
		stop: () => {
			proc.kill();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// ---------- in-memory vault ----------

export class MemFs implements LocalFs {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	dirs = new Set<string>();
	trashed: string[] = [];
	private clock = 1_700_000_000_000;

	set(path: string, text: string) {
		this.clock += 1000;
		this.files.set(path, { data: new TextEncoder().encode(text), mtime: this.clock });
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f && new TextDecoder().decode(f.data);
	}
	/** Changes mtime but not content (e.g. another plugin touched the file). */
	touch(path: string) {
		this.clock += 1000;
		this.files.get(path)!.mtime = this.clock;
	}
	remove(path: string) {
		this.files.delete(path);
	}
	async list() {
		return [...this.files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
	}
	async read(path: string) {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data.slice().buffer;
	}
	async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalStat> {
		this.clock += 1000;
		const f = { data: new Uint8Array(data.slice(0)), mtime: mtime ?? this.clock };
		this.files.set(path, f);
		return { mtime: f.mtime, size: f.data.byteLength };
	}
	async stat(path: string) {
		const f = this.files.get(path);
		return f ? { mtime: f.mtime, size: f.data.byteLength } : null;
	}
	async trash(path: string) {
		this.files.delete(path);
		this.trashed.push(path);
	}
	async removeEmptyDir(dir: string) {
		return ![...this.files.keys()].some((p) => p.startsWith(dir + "/"));
	}
}

export class MemStore implements StateStore {
	state: LocalState | null = null;
	async load() {
		return this.state ? structuredClone(this.state) : null;
	}
	async save(s: LocalState) {
		this.state = structuredClone(s);
	}
}

export class AutoUI implements SyncUI {
	reviews: PlanReview[] = [];
	answer: ((r: PlanReview) => Record<string, AskChoice> | null) = () => ({});
	initChoice: "trash" | "download" | null = "trash";
	async reviewPlan(r: PlanReview) {
		this.reviews.push(r);
		return this.answer(r);
	}
	async reviewInit(_r: InitReview) {
		return this.initChoice;
	}
	progress() {}
}

export function device(serverUrl: string, folder: string, name: string) {
	const fs = new MemFs();
	const store = new MemStore();
	const ui = new AutoUI();
	const id = randomId();
	const dav = new WebDavClient(fetchTransport, serverUrl, folder);
	const remote = new RemoteRepo(dav, { id, name }, 60_000);
	const engine = new SyncEngine(fs, store, remote, ui, {
		device: { id, name, platform: "test" },
		pluginVersion: "test",
		ignore: new IgnoreRules(DEFAULT_IGNORES),
		maxFileSize: 1024 * 1024,
		thresholdPercent: 50,
		thresholdMin: 5,
		tombstoneDays: 90,
		archiveDays: 30,
		isWindows: false,
		concurrency: 4,
		alwaysPreview: false,
		detectServerChanges: true,
	});
	return { name, fs, store, ui, engine, dav, remote };
}
