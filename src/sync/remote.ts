import { WebDavClient } from "../webdav/client";
import { randomId } from "../util/hash";
import { sleep } from "../util/pool";
import type { DeviceRecord, Manifest } from "./types";

export const SYNC_DIR = ".sync";
const MANIFEST = `${SYNC_DIR}/manifest.json`;
const LOCK = `${SYNC_DIR}/lock.json`;
const DEVICES = `${SYNC_DIR}/devices`;
export const TRASH_DIR = `${SYNC_DIR}/trash`;
export const CONFLICTS_DIR = `${SYNC_DIR}/conflicts`;

export class LockBusyError extends Error {
	constructor(public holder: string, public expiresAt: number) {
		super(`"${holder}" is syncing right now (lock expires ${new Date(expiresAt).toLocaleTimeString()})`);
	}
}

export class ConcurrentUpdateError extends Error {
	constructor() {
		super("The manifest was changed by another device during this sync. Nothing was lost; sync again.");
	}
}

interface LockBody {
	owner: string;
	name: string;
	nonce: string;
	acquiredAt: number;
	expiresAt: number;
}

export interface FetchedManifest {
	manifest: Manifest | null;
	etag?: string;
	/** True if the server answered 304 and the cached copy was used. */
	notModified: boolean;
	lastModified?: number;
	serverDate?: number;
}

const enc = (o: unknown) => JSON.stringify(o);
const dec = <T>(b: ArrayBuffer): T => JSON.parse(new TextDecoder().decode(b)) as T;

/** Timestamp folder name for trash/conflict archives: 2026-10-02_141003 */
export function stampNow(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class RemoteRepo {
	private lock: LockBody | null = null;
	private renewTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		public dav: WebDavClient,
		private device: { id: string; name: string },
		private lockTtlMs = 5 * 60_000,
	) {}

	// ---------- manifest ----------

	async fetchManifest(cached?: { etag: string; manifest: Manifest }): Promise<FetchedManifest> {
		const r = await this.dav.get(MANIFEST, cached?.etag);
		const meta = { lastModified: r.lastModified, serverDate: r.serverDate };
		if (r.status === 404) return { manifest: null, notModified: false, ...meta };
		if (r.status === 304 && cached) return { manifest: cached.manifest, etag: cached.etag, notModified: true, ...meta };
		if (r.status === 304) return this.fetchManifest();
		const m = dec<Manifest>(r.data!);
		if (m.version !== 1 || typeof m.rev !== "number" || !m.files || !m.tombstones) {
			throw new Error("Server manifest is not in a format this version of Roost Sync understands.");
		}
		return { manifest: m, etag: r.etag, notModified: false, ...meta };
	}

	/**
	 * Writes the manifest. Must hold the lock. Re-reads first and checks that the
	 * rev is still `expectedRev`, then writes with If-Match.
	 *
	 * WsgiDAV ETags are `inode-mtime(seconds)-size` and PUT rewrites in place, so two
	 * writes of the same size within one second share an ETag and other devices would
	 * get a stale 304. We wait until the server clock has left the second of the
	 * previous write.
	 */
	async commitManifest(next: Manifest, expectedRev: number | null): Promise<string | undefined> {
		if (expectedRev === null) {
			const r = await this.dav.put(MANIFEST, enc(next), { ifNoneMatch: "*", contentType: "application/json" });
			if (r !== "ok") throw new ConcurrentUpdateError();
		} else {
			const cur = await this.fetchManifest();
			if (!cur.manifest || cur.manifest.rev !== expectedRev) throw new ConcurrentUpdateError();
			if (cur.lastModified && cur.serverDate) {
				const wait = Math.floor(cur.lastModified / 1000) * 1000 + 1100 - cur.serverDate;
				if (wait > 0) await sleep(Math.min(wait, 2000));
			}
			const r = await this.dav.put(MANIFEST, enc(next), { ifMatch: cur.etag, contentType: "application/json" });
			if (r !== "ok") throw new ConcurrentUpdateError();
		}
		const after = await this.fetchManifest();
		if (after.manifest?.rev !== next.rev || after.manifest?.id !== next.id) throw new ConcurrentUpdateError();
		return after.etag;
	}

	// ---------- lock ----------

	/** Acquires `.sync/lock.json`. Throws LockBusyError if another device holds a live lock. */
	async acquireLock(): Promise<void> {
		await this.dav.ensureDir(SYNC_DIR);
		const now = Date.now();
		const body: LockBody = {
			owner: this.device.id,
			name: this.device.name,
			nonce: randomId(),
			acquiredAt: now,
			expiresAt: now + this.lockTtlMs,
		};
		const created = await this.dav.put(LOCK, enc(body), { ifNoneMatch: "*", contentType: "application/json" });
		if (created === "precondition-failed") {
			const cur = await this.dav.get(LOCK);
			if (cur.status === 200) {
				let held: LockBody | null = null;
				try {
					held = dec<LockBody>(cur.data!);
				} catch {
					/* corrupt lock: take it over */
				}
				// Only take over expired locks, even our own: if data.json was copied between
				// devices they share a device id, and "it's mine" would let two devices in.
				if (held && held.expiresAt > Date.now()) {
					throw new LockBusyError(held.name, held.expiresAt);
				}
				const r = await this.dav.put(LOCK, enc(body), { ifMatch: cur.etag, contentType: "application/json" });
				if (r !== "ok") throw new LockBusyError("another device", Date.now() + this.lockTtlMs);
			} else {
				// Released between our PUT and GET: try once more.
				const r = await this.dav.put(LOCK, enc(body), { ifNoneMatch: "*", contentType: "application/json" });
				if (r !== "ok") throw new LockBusyError("another device", Date.now() + this.lockTtlMs);
			}
		}
		// Conditional PUT is not atomic on WsgiDAV: read back after a short pause.
		await sleep(300);
		if (!(await this.lockStillOurs(body.nonce))) {
			throw new LockBusyError("another device", Date.now() + this.lockTtlMs);
		}
		this.lock = body;
		this.renewTimer = setInterval(() => void this.renewLock().catch(() => {}), this.lockTtlMs / 3);
	}

	private async lockStillOurs(nonce: string): Promise<boolean> {
		const r = await this.dav.get(LOCK);
		if (r.status !== 200) return false;
		try {
			return dec<LockBody>(r.data!).nonce === nonce;
		} catch {
			return false;
		}
	}

	async renewLock(): Promise<void> {
		if (!this.lock) return;
		if (!(await this.lockStillOurs(this.lock.nonce))) throw new Error("Sync lock was lost");
		this.lock = { ...this.lock, expiresAt: Date.now() + this.lockTtlMs };
		await this.dav.put(LOCK, enc(this.lock), { contentType: "application/json" });
	}

	/** Verifies we still hold the lock (call before committing). */
	async assertLock(): Promise<void> {
		if (!this.lock || !(await this.lockStillOurs(this.lock.nonce))) {
			throw new Error("Sync lock was lost (another device took it over). Sync again.");
		}
	}

	async releaseLock(): Promise<void> {
		if (this.renewTimer) clearInterval(this.renewTimer);
		this.renewTimer = null;
		const held = this.lock;
		this.lock = null;
		if (held && (await this.lockStillOurs(held.nonce))) await this.dav.delete(LOCK);
	}

	// ---------- devices ----------

	async writeDevice(rec: DeviceRecord): Promise<void> {
		await this.dav.ensureDir(DEVICES);
		await this.dav.put(`${DEVICES}/${rec.id}.json`, enc(rec), { contentType: "application/json" });
	}

	async readDevice(id: string): Promise<DeviceRecord | null> {
		const r = await this.dav.get(`${DEVICES}/${id}.json`);
		return r.status === 200 ? dec<DeviceRecord>(r.data!) : null;
	}

	async listDevices(): Promise<DeviceRecord[]> {
		const entries = (await this.dav.propfind(DEVICES, 1)) ?? [];
		const out: DeviceRecord[] = [];
		for (const e of entries) {
			if (e.isDir || !e.path.endsWith(".json")) continue;
			const r = await this.dav.get(e.path);
			if (r.status === 200) {
				try {
					out.push(dec<DeviceRecord>(r.data!));
				} catch {
					/* skip unreadable */
				}
			}
		}
		return out;
	}

	// ---------- trash & conflict archives ----------

	/** Moves a vault file into `.sync/trash/<stamp>/`. Missing files are fine. */
	async trashFile(path: string, stamp: string, ifMatch?: string): Promise<void> {
		await this.dav.move(path, `${TRASH_DIR}/${stamp}/${path}`, true, ifMatch);
	}

	async archiveRemoteVersion(path: string, stamp: string, ifMatch?: string): Promise<void> {
		await this.dav.move(path, `${CONFLICTS_DIR}/${stamp}/${path}`, true, ifMatch);
	}

	async archiveLocalVersion(path: string, stamp: string, data: ArrayBuffer, deviceName: string): Promise<void> {
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		const named = dot > slash + 1 ? `${path.slice(0, dot)} (${deviceName})${path.slice(dot)}` : `${path} (${deviceName})`;
		await this.dav.put(`${CONFLICTS_DIR}/${stamp}/${named}`, data);
	}

	/** Deletes archive folders older than `days` under trash/ and conflicts/. */
	async pruneArchives(days: number): Promise<number> {
		const cutoff = Date.now() - days * 86_400_000;
		let removed = 0;
		for (const dir of [TRASH_DIR, CONFLICTS_DIR]) {
			const entries = (await this.dav.propfind(dir, 1)) ?? [];
			for (const e of entries) {
				const name = e.path.slice(dir.length + 1);
				const m = /^(\d{4})-(\d{2})-(\d{2})_/.exec(name);
				if (!e.isDir || !m) continue;
				const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
				if (t < cutoff) {
					await this.dav.delete(e.path, true);
					removed++;
				}
			}
		}
		return removed;
	}
}
