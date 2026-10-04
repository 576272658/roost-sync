/**
 * Optional cleanup of the vault's `.trash` folder, which Obsidian never empties (it is
 * the only trash on mobile). Files keep their old mtime when moved there, so age is
 * counted from when Roost Sync first saw each file in `.trash`, not from the mtime.
 */

export const VAULT_TRASH = ".trash";
const DAY = 86_400_000;

/** first-seen time (ms) per path inside .trash */
export type TrashSeen = Record<string, number>;

export function planTrashCleanup(files: string[], seen: TrashSeen, now: number, days: number): { seen: TrashSeen; expired: string[] } {
	const next: TrashSeen = {};
	const expired: string[] = [];
	for (const f of files) {
		const first = seen[f] ?? now;
		if (now - first >= days * DAY) expired.push(f);
		else next[f] = first;
	}
	return { seen: next, expired };
}

/** The parts of Obsidian's DataAdapter this needs. */
export interface TrashAdapter {
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
}

async function listAll(a: TrashAdapter, dir: string, files: string[], folders: string[]) {
	const l = await a.list(dir);
	files.push(...l.files);
	for (const sub of l.folders) {
		folders.push(sub);
		await listAll(a, sub, files, folders);
	}
}

/**
 * Permanently deletes files that have been in `.trash` for `days` days, then empty folders.
 * @param seenPath JSON file recording when each file was first seen
 * @returns number of files deleted
 */
export async function cleanVaultTrash(a: TrashAdapter, seenPath: string, days: number, now = Date.now()): Promise<number> {
	const files: string[] = [];
	const folders: string[] = [];
	if (await a.exists(VAULT_TRASH)) await listAll(a, VAULT_TRASH, files, folders);

	let seen: TrashSeen = {};
	try {
		if (await a.exists(seenPath)) seen = JSON.parse(await a.read(seenPath)) as TrashSeen;
	} catch {
		seen = {};
	}
	const plan = planTrashCleanup(files, seen, now, days);
	let removed = 0;
	for (const f of plan.expired) {
		try {
			await a.remove(f);
			removed++;
		} catch {
			plan.seen[f] = seen[f] ?? now; // try again next time
		}
	}
	// Deepest first, so parents become empty after their children.
	for (const d of folders.sort((x, y) => y.length - x.length)) {
		try {
			const l = await a.list(d);
			if (!l.files.length && !l.folders.length) await a.rmdir(d, false);
		} catch {
			/* ignore */
		}
	}
	await a.write(seenPath, JSON.stringify(plan.seen));
	return removed;
}
