import { PreconditionFailedError, parentOf, type DavEntry } from "../webdav/client";
import { sha256, randomId } from "../util/hash";
import { IgnoreRules, caseCollisions, normalizePath, windowsNameProblem } from "../util/paths";
import { runPool } from "../util/pool";
import { needsPreview, planSync, summarize, type PlanSummary } from "./plan";
import { RemoteRepo, stampNow } from "./remote";
import type {
	Action,
	AskChoice,
	AskDecision,
	BaseEntry,
	ConflictInfo,
	ConflictResolution,
	DeviceRecord,
	FileMeta,
	Manifest,
} from "./types";
import { SERVER_DIRECT } from "./types";

// ---------- ports ----------

export interface LocalStat {
	mtime: number;
	size: number;
}

export interface LocalFs {
	/** Every candidate file in the vault (actual on-disk path). */
	list(): Promise<({ path: string } & LocalStat)[]>;
	read(path: string): Promise<ArrayBuffer>;
	/** Writes the file (creating folders) and returns its new stat. */
	write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalStat>;
	stat(path: string): Promise<LocalStat | null>;
	/** Moves to system trash, falling back to the vault's .trash/. */
	trash(path: string): Promise<void>;
	/** Removes `dir` if it exists and is empty. */
	removeEmptyDir(dir: string): Promise<boolean>;
}

export interface HashCacheEntry extends LocalStat {
	hash: string;
}

export interface LocalState {
	version: 1;
	serverId: string | null;
	joined: boolean;
	lastSyncedRev: number;
	lastSyncAt: number;
	lastPruneAt: number;
	lastDeviceWriteAt: number;
	base: Record<string, BaseEntry>;
	hashCache: Record<string, HashCacheEntry>;
	manifestCache: { etag: string; manifest: Manifest } | null;
	conflicts: Record<string, ConflictInfo>;
	resolutions: Record<string, ConflictResolution>;
}

export interface StateStore {
	load(): Promise<LocalState | null>;
	save(state: LocalState): Promise<void>;
}

export interface PlanReview {
	actions: Action[];
	summary: PlanSummary;
	joinMode: boolean;
	totalFiles: number;
	dryRun: boolean;
}

export interface InitReview {
	upload: string[];
	identical: string[];
	remoteOnly: string[];
}

export interface SyncUI {
	/** Show the plan; resolve with choices for "ask" items, or null to cancel. */
	reviewPlan(review: PlanReview): Promise<Record<string, AskChoice> | null>;
	/** Initialization: what to do with files that are only on the server. */
	reviewInit(review: InitReview): Promise<"trash" | "download" | null>;
	progress(message: string): void;
}

export interface SyncSettings {
	device: { id: string; name: string; platform: string };
	pluginVersion: string;
	ignore: IgnoreRules;
	maxFileSize: number;
	thresholdPercent: number;
	thresholdMin: number;
	tombstoneDays: number;
	archiveDays: number;
	isWindows: boolean;
	concurrency: number;
	/** Always show the preview, even under the threshold. */
	alwaysPreview: boolean;
	/**
	 * Reconcile: before each sync, compare the server folder with the manifest so that
	 * files changed directly on the server (AI agent, Finder, scripts) are picked up.
	 */
	detectServerChanges: boolean;
}

export interface ServerChanges {
	created: string[];
	modified: string[];
	deleted: string[];
}

interface Reconciled {
	manifest: Manifest;
	dirty: boolean;
	changes: ServerChanges;
}

export type SyncStatus = "synced" | "nothing-to-do" | "cancelled" | "dry-run";

export interface SyncResult {
	status: SyncStatus;
	summary: PlanSummary;
	actions: Action[];
	errors: string[];
	warnings: string[];
	conflicts: ConflictInfo[];
	joinMode: boolean;
	rev: number;
	/** Changes found directly in the server folder (reconciliation). */
	serverChanges: ServerChanges;
}

export class NotInitializedError extends Error {
	constructor() {
		super("The server has no Roost Sync data yet. Run “Initialize server from this device” on your most complete device first.");
	}
}

export function emptyState(): LocalState {
	return {
		version: 1,
		serverId: null,
		joined: false,
		lastSyncedRev: 0,
		lastSyncAt: 0,
		lastPruneAt: 0,
		lastDeviceWriteAt: 0,
		base: {},
		hashCache: {},
		manifestCache: null,
		conflicts: {},
		resolutions: {},
	};
}

const DAY = 86_400_000;

interface Scan {
	local: Record<string, FileMeta>;
	/** NFC key → actual path on disk. */
	actual: Record<string, string>;
	skipped: Set<string>;
	errors: string[];
	warnings: string[];
}

// ---------- engine ----------

export class SyncEngine {
	constructor(
		private fs: LocalFs,
		private store: StateStore,
		private remote: RemoteRepo,
		private ui: SyncUI,
		private settings: SyncSettings,
	) {}

	private get dav() {
		return this.remote.dav;
	}

	private async loadState(): Promise<LocalState> {
		try {
			return (await this.store.load()) ?? emptyState();
		} catch {
			return emptyState();
		}
	}

	/** Lists and hashes local files, reusing cached hashes when mtime and size are unchanged. */
	async scan(state: LocalState): Promise<Scan> {
		const { ignore, maxFileSize } = this.settings;
		const out: Scan = { local: {}, actual: {}, skipped: new Set(), errors: [], warnings: [] };
		const listed = await this.fs.list();
		const newCache: Record<string, HashCacheEntry> = {};
		for (const f of listed) {
			const key = normalizePath(f.path);
			if (ignore.isIgnored(key)) continue;
			if (out.actual[key] !== undefined) {
				out.skipped.add(key);
				out.errors.push(`${key}: two files with the same name in different Unicode forms; skipped`);
				continue;
			}
			out.actual[key] = f.path;
			if (f.size > maxFileSize) {
				out.skipped.add(key);
				out.errors.push(`${key}: ${(f.size / 1048576).toFixed(1)} MB exceeds the size limit; skipped`);
				continue;
			}
			const c = state.hashCache[key];
			let hash: string;
			if (c && c.mtime === f.mtime && c.size === f.size) hash = c.hash;
			else {
				try {
					hash = await sha256(await this.fs.read(f.path));
				} catch {
					// Deleted or replaced on disk after Obsidian listed it (e.g. by an external tool).
					out.skipped.add(key);
					out.warnings.push(`${key}: changed on disk while scanning; will sync next time`);
					continue;
				}
			}
			newCache[key] = { mtime: f.mtime, size: f.size, hash };
			out.local[key] = { hash, size: f.size, mtime: f.mtime };
		}
		state.hashCache = newCache;
		return out;
	}

	/** Adds remote-side and cross-platform skips (§5.10) to the scan. */
	private applyRemoteChecks(scan: Scan, manifest: Manifest, base: Record<string, BaseEntry>) {
		const { maxFileSize, isWindows, ignore } = this.settings;
		for (const [p, f] of Object.entries(manifest.files)) {
			if (ignore.isIgnored(p) || scan.skipped.has(p)) continue;
			if (f.size > maxFileSize && !scan.local[p]) {
				scan.skipped.add(p);
				scan.errors.push(`${p}: ${(f.size / 1048576).toFixed(1)} MB on server exceeds the size limit; not downloaded`);
			}
			if (isWindows && !scan.local[p]) {
				const why = windowsNameProblem(p);
				if (why) {
					scan.skipped.add(p);
					scan.errors.push(`${p}: ${why}; cannot be saved on Windows, skipped`);
				}
			}
		}
		if (!isWindows) {
			for (const p of Object.keys(scan.local)) {
				if (!manifest.files[p] && !base[p]) {
					const why = windowsNameProblem(p);
					if (why) scan.warnings.push(`${p}: ${why}; your Windows device will not be able to sync it`);
				}
			}
		}
		const keys = new Set([...Object.keys(scan.local), ...Object.keys(manifest.files)]);
		for (const group of caseCollisions(keys)) {
			const localKeys = group.filter((k) => scan.local[k]);
			const remoteKeys = group.filter((k) => manifest.files[k]);
			const newLocal = localKeys.filter((k) => !base[k]);
			const newRemote = remoteKeys.filter((k) => !base[k]);
			const clash =
				localKeys.length > 1 ||
				remoteKeys.length > 1 ||
				newLocal.some((a) => newRemote.some((b) => a !== b));
			if (!clash) continue; // a case-only rename on one side; handled as delete + add
			for (const k of group) scan.skipped.add(k);
			scan.errors.push(`${group.join(" / ")}: names differ only in letter case; skipped until one is renamed`);
		}
	}

	private isJoinMode(state: LocalState, manifest: Manifest): boolean {
		if (!state.joined || state.serverId !== manifest.id) return true;
		return state.lastSyncAt > 0 && Date.now() - state.lastSyncAt > this.settings.tombstoneDays * DAY;
	}

	private makePlan(state: LocalState, scan: Scan, manifest: Manifest, joinMode: boolean, decisions: Record<string, AskDecision>) {
		const base = state.serverId === manifest.id ? state.base : {};
		return planSync({
			local: scan.local,
			base,
			manifest,
			joinMode,
			skip: (p) => scan.skipped.has(p) || this.settings.ignore.isIgnored(p),
			decisions,
			resolutions: state.resolutions,
		});
	}

	private needsReview(actions: Action[], scan: Scan, manifest: Manifest): boolean {
		const total = Math.max(Object.keys(scan.local).length, Object.keys(manifest.files).length);
		const hasWork = actions.some((a) => a.kind !== "markSynced" && a.kind !== "dropBase" && a.kind !== "conflict");
		if (this.settings.alwaysPreview && hasWork) return true;
		return needsPreview(actions, total, this.settings.thresholdPercent, this.settings.thresholdMin);
	}

	async sync(opts: { dryRun?: boolean } = {}): Promise<SyncResult> {
		const ui = this.ui;
		const state = await this.loadState();
		ui.progress("Checking server…");
		let fetched = await this.remote.fetchManifest(state.manifestCache ?? undefined);
		if (!fetched.manifest) throw new NotInitializedError();
		let manifest = fetched.manifest;
		if (state.serverId && state.serverId !== manifest.id) {
			// The server was re-initialized: our history refers to another dataset.
			state.base = {};
			state.conflicts = {};
			state.resolutions = {};
			state.joined = false;
		}
		const joinMode = this.isJoinMode(state, manifest);

		const recErrors: string[] = [];
		let rec = await this.reconcile(manifest, recErrors);

		ui.progress("Scanning vault…");
		const scan = await this.scan(state);
		this.applyRemoteChecks(scan, rec.manifest, state.base);

		let decisions: Record<string, AskDecision> = {};
		let actions = this.makePlan(state, scan, rec.manifest, joinMode, decisions);
		const result = (status: SyncStatus, errors: string[] = []): SyncResult => ({
			status,
			summary: summarize(actions),
			actions,
			errors: [...scan.errors, ...recErrors, ...errors],
			warnings: scan.warnings,
			conflicts: Object.values(state.conflicts),
			joinMode,
			rev: manifest.rev,
			serverChanges: rec.changes,
		});

		if (opts.dryRun) {
			await ui.reviewPlan({ actions, summary: summarize(actions), joinMode, totalFiles: Object.keys(scan.local).length, dryRun: true });
			return result("dry-run");
		}

		const needsServer = rec.dirty || actions.some((a) => a.kind !== "markSynced" && a.kind !== "dropBase" && a.kind !== "conflict");
		if (!needsServer) {
			// Nothing to transfer: update local bookkeeping without taking the lock.
			this.applyBookkeeping(state, actions, manifest);
			if (fetched.etag) state.manifestCache = { etag: fetched.etag, manifest };
			state.joined = true;
			state.serverId = manifest.id;
			state.lastSyncedRev = manifest.rev;
			state.lastSyncAt = Date.now();
			if (Date.now() - state.lastDeviceWriteAt > 12 * 3_600_000) {
				await this.remote.writeDevice(this.deviceRecord(state, manifest.rev, await this.remote.readDevice(this.settings.device.id)));
				state.lastDeviceWriteAt = Date.now();
			}
			await this.store.save(state);
			return result("nothing-to-do");
		}

		if (this.needsReview(actions, scan, rec.manifest)) {
			const choices = await ui.reviewPlan({ actions, summary: summarize(actions), joinMode, totalFiles: Object.keys(scan.local).length, dryRun: false });
			if (!choices) return result("cancelled");
			decisions = this.toDecisions(actions, choices);
		}
		const approvedRisky = summarize(this.makePlan(state, scan, rec.manifest, joinMode, decisions)).risky;

		ui.progress("Waiting for sync lock…");
		await this.remote.acquireLock();
		try {
			// Re-read under the lock: another device may have synced since we planned.
			fetched = await this.remote.fetchManifest(fetched.etag ? { etag: fetched.etag, manifest } : undefined);
			if (!fetched.manifest) throw new NotInitializedError();
			manifest = fetched.manifest;
			recErrors.length = 0;
			rec = await this.reconcile(manifest, recErrors);
			this.applyRemoteChecks(scan, rec.manifest, state.base);
			actions = this.makePlan(state, scan, rec.manifest, joinMode, decisions);
			const s = summarize(actions);
			if (s.ask > 0 || (s.risky > approvedRisky && this.needsReview(actions, scan, rec.manifest))) {
				const choices = await ui.reviewPlan({ actions, summary: s, joinMode, totalFiles: Object.keys(scan.local).length, dryRun: false });
				if (!choices) return result("cancelled");
				decisions = { ...decisions, ...this.toDecisions(actions, choices) };
				actions = this.makePlan(state, scan, rec.manifest, joinMode, decisions);
			}
			// Items the user chose to skip keep the device in join mode, so they are asked again next time.
			const unresolved = Object.values(decisions).some((d) => d.choice === "skip");

			const errors = await this.execute(state, scan, rec.manifest, actions, joinMode && unresolved, fetched.etag, rec.dirty);
			manifest = this.lastCommitted ?? manifest;
			return { ...result("synced", errors), rev: manifest.rev };
		} finally {
			await this.remote.releaseLock().catch(() => {});
		}
	}

	private lastCommitted: Manifest | null = null;

	private toDecisions(actions: Action[], choices: Record<string, AskChoice>): Record<string, AskDecision> {
		const out: Record<string, AskDecision> = {};
		for (const a of actions) {
			if (a.kind !== "ask" || !a.local) continue;
			out[a.path] = { choice: choices[a.path] ?? a.defaultChoice ?? "skip", hash: a.local.hash };
		}
		return out;
	}

	/** markSynced / dropBase / conflict bookkeeping that needs no server writes. */
	private applyBookkeeping(state: LocalState, actions: Action[], manifest: Manifest) {
		if (state.serverId !== manifest.id) state.base = {};
		const conflicts: Record<string, ConflictInfo> = {};
		for (const a of actions) {
			if (a.kind === "markSynced" && a.remote) state.base[a.path] = { hash: a.remote.hash, rev: a.remote.rev };
			else if (a.kind === "dropBase") delete state.base[a.path];
			else if (a.kind === "conflict" && a.local && a.remote) {
				conflicts[a.path] = state.conflicts[a.path]?.remoteHash === a.remote.hash && state.conflicts[a.path]?.localHash === a.local.hash
					? state.conflicts[a.path]
					: {
							path: a.path,
							localHash: a.local.hash,
							localMtime: a.local.mtime,
							localSize: a.local.size,
							remoteHash: a.remote.hash,
							remoteMtime: a.remote.mtime,
							remoteSize: a.remote.size,
							remoteBy: a.remote.by,
							hasBase: !!a.base,
							detectedAt: Date.now(),
						};
			}
		}
		state.conflicts = conflicts;
		for (const p of Object.keys(state.resolutions)) if (!conflicts[p]) delete state.resolutions[p];
	}

	private async execute(
		state: LocalState,
		scan: Scan,
		manifest: Manifest,
		actions: Action[],
		stayInJoinMode: boolean,
		etag: string | undefined,
		reconciled: boolean,
	): Promise<string[]> {
		const { device, concurrency } = this.settings;
		const ui = this.ui;
		const errors: string[] = [];
		const stamp = stampNow();
		const next: Manifest = {
			...manifest,
			files: { ...manifest.files },
			tombstones: { ...manifest.tombstones },
		};
		const newRev = manifest.rev + 1;
		let dirty = reconciled;
		const base = state.serverId === manifest.id ? state.base : {};
		const localPath = (p: string) => scan.actual[p] ?? p;
		const fail = (a: Action, e: unknown) => errors.push(`${a.path}: ${e instanceof Error ? e.message : String(e)}`);

		/** True if the local file still matches what we scanned (the user may be typing). */
		/**
		 * True if the file on disk still has the content we planned with. Compares content
		 * hashes read from disk, not Obsidian's cached stat: files are often edited outside
		 * Obsidian (AI agents, scripts), and the cache can lag behind the disk.
		 */
		const unchangedSinceScan = async (a: Action) => {
			const lp = localPath(a.path);
			const st = await this.fs.stat(lp);
			if (!a.local) return st === null;
			if (!st) return false;
			try {
				return (await sha256(await this.fs.read(lp))) === a.local.hash;
			} catch {
				return false;
			}
		};

		// 1. Deletions first, so a case-only rename never deletes the file it just wrote.
		const localDeletes = actions.filter((a) => a.kind === "deleteLocal");
		const remoteDeletes = actions.filter((a) => a.kind === "deleteRemote");
		const touchedLocalDirs = new Set<string>();
		const touchedRemoteDirs = new Set<string>();
		let done = 0;
		const total = actions.filter((a) => ["push", "pull", "deleteLocal", "deleteRemote"].includes(a.kind)).length;
		const tick = () => ui.progress(`Syncing… ${++done}/${total}`);

		for (const a of localDeletes) {
			try {
				if (!(await unchangedSinceScan(a))) {
					errors.push(`${a.path}: edited during sync; not deleted (will retry next sync)`);
					continue;
				}
				await this.fs.trash(localPath(a.path));
				delete base[a.path];
				delete state.hashCache[a.path];
				touchedLocalDirs.add(parentOf(localPath(a.path)));
			} catch (e) {
				fail(a, e);
			}
			tick();
		}
		await runPool(remoteDeletes, concurrency, async (a) => {
			try {
				await this.remote.trashFile(a.path, stamp, this.guardEtag(a));
				delete next.files[a.path];
				next.tombstones[a.path] = {
					hash: a.remote?.hash ?? a.base?.hash ?? null,
					deletedAt: Date.now(),
					rev: newRev,
					by: device.name,
				};
				delete base[a.path];
				dirty = true;
				touchedRemoteDirs.add(parentOf(a.path));
			} catch (e) {
				if (e instanceof PreconditionFailedError) errors.push(`${a.path}: changed on the server during sync; not deleted (will be picked up next sync)`);
				else fail(a, e);
			}
			tick();
		});

		// 2. Transfers.
		const transfers = actions.filter((a) => a.kind === "push" || a.kind === "pull");
		const dirs = new Set(transfers.filter((a) => a.kind === "push").map((a) => parentOf(a.path)).filter(Boolean));
		for (const d of [...dirs].sort((x, y) => x.split("/").length - y.split("/").length)) {
			try {
				await this.dav.ensureDir(d);
			} catch (e) {
				errors.push(`${d}/: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		await runPool(transfers, concurrency, async (a) => {
			try {
				if (a.kind === "push") await this.doPush(a, localPath(a.path), next, base, state, newRev, stamp);
				else {
					if (!(await unchangedSinceScan(a))) {
						errors.push(`${a.path}: edited during sync; not overwritten (will retry next sync)`);
						return;
					}
					await this.doPull(a, localPath(a.path), next, base, state, newRev, stamp);
				}
				if (a.archive) {
					delete state.conflicts[a.path];
					delete state.resolutions[a.path];
				}
				dirty = dirty || a.kind === "push" || next.files[a.path] !== manifest.files[a.path];
			} catch (e) {
				if (e instanceof PreconditionFailedError) errors.push(`${a.path}: changed on the server during sync; not uploaded (will be picked up next sync)`);
				else fail(a, e);
			} finally {
				tick();
			}
		});

		// 3. Bookkeeping, empty folders, housekeeping.
		state.base = base;
		state.serverId = manifest.id;
		this.applyBookkeeping(state, actions, manifest);
		for (const d of sortDeepestFirst(touchedLocalDirs)) await this.removeEmptyLocalDirs(d);
		for (const d of sortDeepestFirst(touchedRemoteDirs)) await this.removeEmptyRemoteDirs(d).catch(() => {});

		const now = Date.now();
		const devices = await this.remote.listDevices().catch(() => [] as DeviceRecord[]);
		if (now - state.lastPruneAt > DAY) {
			const removed = this.gcTombstones(next, devices, dirty ? newRev : manifest.rev);
			if (removed > 0) dirty = true;
			await this.remote.pruneArchives(this.settings.archiveDays).catch((e) => errors.push(`cleanup: ${e}`));
			state.lastPruneAt = now;
		}

		let committedEtag = etag;
		if (dirty) {
			next.rev = newRev;
			next.updatedAt = now;
			next.updatedBy = device.name;
			await this.remote.assertLock();
			committedEtag = await this.remote.commitManifest(next, manifest.rev);
			this.lastCommitted = next;
		} else {
			this.lastCommitted = manifest;
		}
		const finalManifest = dirty ? next : manifest;
		if (committedEtag) state.manifestCache = { etag: committedEtag, manifest: finalManifest };

		if (!stayInJoinMode && !actions.some((a) => a.kind === "ask")) state.joined = true;
		state.lastSyncedRev = finalManifest.rev;
		state.lastSyncAt = now;
		await this.remote.writeDevice(this.deviceRecord(state, finalManifest.rev, devices.find((d) => d.id === device.id) ?? null));
		state.lastDeviceWriteAt = now;
		await this.store.save(state);
		return errors;
	}

	private async doPush(a: Action, lp: string, next: Manifest, base: Record<string, BaseEntry>, state: LocalState, newRev: number, stamp: string) {
		const data = await this.fs.read(lp);
		const hash = await sha256(data);
		const st = await this.fs.stat(lp);
		const guard = this.guardEtag(a);
		if (a.archive === "remote") await this.remote.archiveRemoteVersion(a.path, stamp, guard);
		// Never overwrite a server file that changed after we looked at it (an agent may be writing).
		const cond = !this.settings.detectServerChanges
			? {}
			: a.remote && a.archive !== "remote"
				? guard
					? { ifMatch: guard }
					: {}
				: { ifNoneMatch: "*" };
		const r = await this.dav.putEx(a.path, data, cond);
		if (r.status !== "ok") throw new PreconditionFailedError("PUT", a.path);
		const mtime = st?.mtime ?? a.local?.mtime ?? Date.now();
		next.files[a.path] = { hash, size: data.byteLength, mtime, rev: newRev, by: this.settings.device.name, etag: r.etag };
		delete next.tombstones[a.path];
		base[a.path] = { hash, rev: newRev };
		if (st) state.hashCache[a.path] = { mtime: st.mtime, size: st.size, hash };
	}

	private async doPull(a: Action, lp: string, next: Manifest, base: Record<string, BaseEntry>, state: LocalState, newRev: number, stamp: string) {
		const R = a.remote!;
		const got = await this.dav.get(a.path);
		if (got.status !== 200) throw new Error("listed in the manifest but missing on the server");
		const data = got.data!;
		const hash = await sha256(data);
		if (a.archive === "local" && a.local) {
			await this.remote.archiveLocalVersion(a.path, stamp, await this.fs.read(lp), this.settings.device.name);
		}
		const st = await this.fs.write(lp, data, R.mtime || undefined);
		state.hashCache[a.path] = { mtime: st.mtime, size: st.size, hash };
		if (hash === R.hash) {
			base[a.path] = { hash, rev: R.rev };
			if (got.etag && got.etag !== R.etag) next.files[a.path] = { ...R, etag: got.etag };
		} else {
			// The file on the server differs from the manifest (edited outside Roost Sync,
			// or a crashed upload). The file is the truth; fix the manifest.
			next.files[a.path] = { hash, size: data.byteLength, mtime: R.mtime, rev: newRev, by: SERVER_DIRECT, etag: got.etag };
			base[a.path] = { hash, rev: newRev };
		}
	}

	private async removeEmptyLocalDirs(dir: string) {
		let d = dir;
		while (d) {
			if (!(await this.fs.removeEmptyDir(d).catch(() => false))) return;
			d = parentOf(d);
		}
	}

	private async removeEmptyRemoteDirs(dir: string) {
		let d = dir;
		while (d) {
			const entries = await this.dav.propfind(d, 1);
			if (!entries || entries.length > 0) return;
			await this.dav.delete(d, true);
			d = parentOf(d);
		}
	}

	/** §5.6: drop tombstones every active device has seen and that are past retention. */
	private gcTombstones(m: Manifest, devices: DeviceRecord[], ownRev: number): number {
		const now = Date.now();
		const days = this.settings.tombstoneDays;
		const active = devices.filter((d) => now - d.lastSyncAt <= days * DAY && d.id !== this.settings.device.id);
		const minRev = Math.min(ownRev, ...active.map((d) => d.lastSyncedRev));
		let removed = 0;
		for (const [p, t] of Object.entries(m.tombstones)) {
			if (now - t.deletedAt > days * DAY && t.rev <= minRev) {
				delete m.tombstones[p];
				removed++;
			}
		}
		return removed;
	}

	private deviceRecord(state: LocalState, rev: number, prev: DeviceRecord | null): DeviceRecord {
		const { id, name, platform } = this.settings.device;
		return {
			id,
			name,
			platform,
			firstSeen: prev?.firstSeen ?? Date.now(),
			lastSyncAt: Date.now(),
			lastSyncedRev: rev,
			pluginVersion: this.settings.pluginVersion,
		};
	}

	/** ETag to use as an If-Match guard for writes over an existing server file, if known. */
	private guardEtag(a: Action): string | undefined {
		return this.settings.detectServerChanges ? a.remote?.etag : undefined;
	}

	// ---------- reconciliation (server folder edited directly) ----------

	/** Hashes of server files by path+ETag, reused between the unlocked and locked pass. */
	private serverHashes = new Map<string, { etag: string; hash: string; size: number }>();

	/**
	 * Compares the real server folder with the manifest and returns a corrected copy:
	 *  - ETag differs → download and hash; new content is recorded as a server-side edit
	 *  - in the manifest but gone from the server → tombstone (with the old hash, so other
	 *    devices drop identical copies)
	 *  - on the server but not in the manifest → recorded as a new file
	 * Pure with respect to the server: nothing is written here.
	 */
	async reconcile(manifest: Manifest, errors: string[]): Promise<Reconciled> {
		const changes: ServerChanges = { created: [], modified: [], deleted: [] };
		if (!this.settings.detectServerChanges) return { manifest, dirty: false, changes };
		const { ignore, maxFileSize, concurrency } = this.settings;
		this.ui.progress("Checking server folder…");
		const listing = await this.dav.listTree("", (p) => ignore.isIgnored(p));
		if (listing === null) throw new Error("The remote folder no longer exists on the server. Check the remote folder setting.");
		const onServer = new Map<string, DavEntry>();
		for (const e of listing) if (!ignore.isIgnored(e.path)) onServer.set(e.path, e);

		const known = Object.keys(manifest.files).filter((p) => !ignore.isIgnored(p));
		if (onServer.size === 0 && known.length >= 5) {
			throw new Error(
				`The server folder looks empty but the manifest lists ${known.length} files. Refusing to treat them all as deleted; check the server.`,
			);
		}

		const next: Manifest = { ...manifest, files: { ...manifest.files }, tombstones: { ...manifest.tombstones } };
		const rev = manifest.rev + 1;
		let dirty = false;
		const toCheck: DavEntry[] = [];
		for (const e of onServer.values()) {
			const m = manifest.files[e.path];
			if (m && m.etag && e.etag && m.etag === e.etag) continue;
			if (!m && e.size > maxFileSize) {
				errors.push(`${e.path}: ${(e.size / 1048576).toFixed(1)} MB on server exceeds the size limit; not added`);
				continue;
			}
			if (m && !e.etag && m.size === e.size) continue; // server without ETags: size is all we have
			toCheck.push(e);
		}

		await runPool(toCheck, concurrency, async (e) => {
			let h = this.serverHashes.get(e.path);
			if (!h || !e.etag || h.etag !== e.etag) {
				const got = await this.dav.get(e.path);
				if (got.status !== 200) return; // vanished meanwhile; next sync
				h = { etag: got.etag ?? e.etag ?? "", hash: await sha256(got.data!), size: got.data!.byteLength };
				this.serverHashes.set(e.path, h);
			}
			const m = manifest.files[e.path];
			if (m && m.hash === h.hash) {
				if (m.etag !== h.etag) {
					next.files[e.path] = { ...m, etag: h.etag || undefined };
					dirty = true;
				}
				return;
			}
			next.files[e.path] = { hash: h.hash, size: h.size, mtime: e.mtime, rev, by: SERVER_DIRECT, etag: h.etag || undefined };
			delete next.tombstones[e.path];
			(m ? changes.modified : changes.created).push(e.path);
			dirty = true;
		});

		for (const p of known) {
			if (onServer.has(p)) continue;
			next.tombstones[p] = { hash: manifest.files[p].hash, deletedAt: Date.now(), rev, by: SERVER_DIRECT };
			delete next.files[p];
			changes.deleted.push(p);
			dirty = true;
		}
		for (const k of Object.values(changes)) k.sort();
		return { manifest: next, dirty, changes };
	}

	// ---------- conflicts ----------

	async loadConflicts(): Promise<ConflictInfo[]> {
		return Object.values((await this.loadState()).conflicts);
	}

	async saveResolutions(res: Record<string, ConflictResolution>): Promise<void> {
		const state = await this.loadState();
		state.resolutions = { ...state.resolutions, ...res };
		await this.store.save(state);
	}

	async readLocal(path: string): Promise<ArrayBuffer> {
		return this.fs.read(path);
	}

	async readRemote(path: string): Promise<ArrayBuffer | null> {
		const r = await this.dav.get(path);
		return r.status === 200 ? r.data! : null;
	}

	// ---------- initialization (§7) ----------

	async initServer(): Promise<SyncResult> {
		const ui = this.ui;
		const { ignore, concurrency, device, maxFileSize } = this.settings;
		const existing = await this.remote.fetchManifest();
		if (existing.manifest) throw new Error("The server is already initialized. Use “Sync now” instead.");

		await this.dav.ensureRoot();
		ui.progress("Waiting for sync lock…");
		await this.remote.acquireLock();
		try {
			ui.progress("Listing server files…");
			const remoteList = (await this.dav.listTree("", (p) => ignore.isIgnored(p))) ?? [];
			const remote = new Map(remoteList.filter((e) => !ignore.isIgnored(e.path)).map((e) => [e.path, e]));
			const state = emptyState();
			ui.progress("Scanning vault…");
			const scan = await this.scan(state);

			ui.progress("Comparing with server…");
			const upload: string[] = [];
			const identical: string[] = [];
			await runPool(Object.keys(scan.local), concurrency, async (p) => {
				const r = remote.get(p);
				if (r && r.size === scan.local[p].size) {
					const got = await this.dav.get(p);
					if (got.status === 200 && (await sha256(got.data!)) === scan.local[p].hash) {
						identical.push(p);
						return;
					}
				}
				upload.push(p);
			});
			const remoteOnly = [...remote.keys()].filter((p) => !scan.local[p] && !scan.skipped.has(p)).sort();
			const choice = await ui.reviewInit({ upload: upload.sort(), identical: identical.sort(), remoteOnly });
			if (!choice) {
				const summary = summarize([]);
				return { status: "cancelled", summary, actions: [], errors: scan.errors, warnings: scan.warnings, conflicts: [], joinMode: false, rev: 0, serverChanges: noChanges() };
			}

			const now = Date.now();
			const m: Manifest = { version: 1, id: randomId(), rev: 1, updatedAt: now, updatedBy: device.name, files: {}, tombstones: {} };
			const errors: string[] = [];
			const stamp = stampNow();
			for (const p of identical) {
				const l = scan.local[p];
				m.files[p] = { ...l, rev: 1, by: device.name, etag: remote.get(p)?.etag };
			}
			let done = 0;
			const total = upload.length + remoteOnly.length;
			await runPool(upload, concurrency, async (p) => {
				try {
					const data = await this.fs.read(scan.actual[p]);
					await this.dav.ensureDir(parentOf(p));
					const put = await this.dav.putEx(p, data);
					if (put.status !== "ok") throw new Error("upload rejected");
					m.files[p] = { hash: await sha256(data), size: data.byteLength, mtime: scan.local[p].mtime, rev: 1, by: device.name, etag: put.etag };
				} catch (e) {
					errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
				}
				ui.progress(`Initializing… ${++done}/${total}`);
			});
			await runPool(remoteOnly, concurrency, async (p) => {
				try {
					const r = remote.get(p)!;
					const got = r.size <= maxFileSize ? await this.dav.get(p) : null;
					const hash = got?.status === 200 ? await sha256(got.data!) : null;
					if (choice === "download" && got?.status === 200) {
						const st = await this.fs.write(p, got.data!, r.mtime || undefined);
						m.files[p] = { hash: hash!, size: got.data!.byteLength, mtime: r.mtime, rev: 1, by: device.name, etag: got.etag };
						state.hashCache[p] = { ...st, hash: hash! };
					} else {
						await this.remote.trashFile(p, stamp);
						m.tombstones[p] = { hash, deletedAt: now, rev: 1, by: device.name };
					}
				} catch (e) {
					errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
				}
				ui.progress(`Initializing… ${++done}/${total}`);
			});

			const etag = await this.remote.commitManifest(m, null);
			state.serverId = m.id;
			state.joined = true;
			state.lastSyncedRev = 1;
			state.lastSyncAt = Date.now();
			state.lastPruneAt = Date.now();
			state.lastDeviceWriteAt = Date.now();
			for (const [p, f] of Object.entries(m.files)) state.base[p] = { hash: f.hash, rev: f.rev };
			if (etag) state.manifestCache = { etag, manifest: m };
			await this.remote.writeDevice(this.deviceRecord(state, 1, null));
			await this.store.save(state);
			return {
				status: "synced",
				summary: summarize([]),
				actions: [],
				errors: [...scan.errors, ...errors],
				warnings: scan.warnings,
				conflicts: [],
				joinMode: false,
				rev: 1,
				serverChanges: noChanges(),
			};
		} finally {
			await this.remote.releaseLock().catch(() => {});
		}
	}
}

const noChanges = (): ServerChanges => ({ created: [], modified: [], deleted: [] });

function sortDeepestFirst(dirs: Set<string>): string[] {
	return [...dirs].filter(Boolean).sort((a, b) => b.split("/").length - a.split("/").length);
}
