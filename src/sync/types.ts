export interface FileMeta {
	hash: string;
	size: number;
	mtime: number;
}

export interface ManifestFile extends FileMeta {
	/** Manifest rev in which this content was written. */
	rev: number;
	/** Device name that wrote it, or SERVER_DIRECT for edits made directly in the server folder. */
	by: string;
	/** Server ETag of the file when this entry was recorded; a different ETag means it was changed outside Roost Sync. */
	etag?: string;
}

/** `by` value for changes found by reconciliation (made directly in the server folder, e.g. by an AI agent). */
export const SERVER_DIRECT = "server (direct edit)";

export interface Tombstone {
	/** Content hash right before deletion; null if unknown. */
	hash: string | null;
	deletedAt: number;
	rev: number;
	by: string;
}

export interface Manifest {
	version: 1;
	/** Random id created on initialization; a different id means the server was reset. */
	id: string;
	rev: number;
	updatedAt: number;
	updatedBy: string;
	files: Record<string, ManifestFile>;
	tombstones: Record<string, Tombstone>;
}

export interface BaseEntry {
	hash: string;
	rev: number;
}

export interface DeviceRecord {
	id: string;
	name: string;
	platform: string;
	firstSeen: number;
	lastSyncAt: number;
	lastSyncedRev: number;
	pluginVersion: string;
}

export type AskKind =
	/** Changed here, deleted on the server (base known). */
	| "resurrect"
	/** No base; the server has a tombstone whose content differs from ours. */
	| "tombstoneDiffers"
	/** Join mode: the file exists only on this device. */
	| "joinLocalOnly";

export type AskChoice = "push" | "deleteLocal" | "skip";

export interface AskDecision {
	choice: AskChoice;
	/** Local hash the decision was made for; a later edit invalidates it. */
	hash: string;
}

export interface ConflictInfo {
	path: string;
	localHash: string;
	localMtime: number;
	localSize: number;
	remoteHash: string;
	remoteMtime: number;
	remoteSize: number;
	remoteBy: string;
	hasBase: boolean;
	detectedAt: number;
}

export interface ConflictResolution {
	choice: "local" | "remote";
	/** Server hash the choice was made against; if the server moved on, ask again. */
	remoteHash: string;
}

export type ActionKind =
	| "push"
	| "pull"
	| "deleteLocal"
	| "deleteRemote"
	| "markSynced"
	| "dropBase"
	| "conflict"
	| "ask";

export interface Action {
	path: string;
	kind: ActionKind;
	reason: string;
	local?: FileMeta;
	remote?: ManifestFile;
	tomb?: Tombstone;
	base?: BaseEntry;
	/** push: the server has never had this path. */
	isNew?: boolean;
	/** push: overwrites a tombstone. */
	resurrect?: boolean;
	/** Conflict resolution: which losing version to archive into .sync/conflicts/. */
	archive?: "remote" | "local";
	ask?: AskKind;
	/** For ask actions: what happens if the user just confirms. */
	defaultChoice?: AskChoice;
}
