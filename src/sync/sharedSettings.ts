import { RemoteRepo, SYNC_DIR } from "./remote";

/**
 * Roost Sync's own settings that should be the same on every device. They live in
 * `.sync/settings.json` on the server, not in data.json (which holds the password and
 * device id and is never synced). The most recent change wins.
 */
export const SHARED_KEYS = [
	"syncOnStartup",
	"startupDelaySec",
	"intervalMinutes",
	"syncAfterEditSec",
	"thresholdPercent",
	"thresholdMin",
	"alwaysPreview",
	"detectServerChanges",
	"maxFileSizeMB",
	"ignorePatterns",
	"tombstoneDays",
	"archiveDays",
	"configSync",
] as const;

export type SharedKey = (typeof SHARED_KEYS)[number];

export interface SharedSettingsFile {
	version: 1;
	updatedAt: number;
	updatedBy: string;
	settings: Record<string, unknown>;
}

const PATH = `${SYNC_DIR}/settings.json`;

export function pickShared(settings: Record<string, any>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of SHARED_KEYS) if (k in settings) out[k] = structuredClone(settings[k]);
	return out;
}

export type SharedSyncResult =
	| { action: "none" }
	| { action: "pushed"; updatedAt: number }
	/** Apply `settings` locally and record `updatedAt`. */
	| { action: "pulled"; settings: Record<string, unknown>; updatedAt: number; by: string };

/**
 * Exchanges shared settings with the server.
 * @param localUpdatedAt when this device last changed a shared setting (0 = never; a new device adopts the server's)
 */
export async function syncSharedSettings(
	remote: RemoteRepo,
	local: Record<string, any>,
	localUpdatedAt: number,
	deviceName: string,
): Promise<SharedSyncResult> {
	const got = await remote.dav.get(PATH);
	let server: SharedSettingsFile | null = null;
	if (got.status === 200) {
		try {
			server = JSON.parse(new TextDecoder().decode(got.data!)) as SharedSettingsFile;
		} catch {
			server = null;
		}
	}
	if (server && server.updatedAt > localUpdatedAt) {
		const known = Object.fromEntries(Object.entries(server.settings).filter(([k]) => (SHARED_KEYS as readonly string[]).includes(k)));
		const differs = Object.keys(known).some((k) => JSON.stringify(known[k]) !== JSON.stringify(local[k]));
		return differs ? { action: "pulled", settings: known, updatedAt: server.updatedAt, by: server.updatedBy } : { action: "none" };
	}
	if ((!server && localUpdatedAt >= 0) || (server && localUpdatedAt > server.updatedAt)) {
		const file: SharedSettingsFile = {
			version: 1,
			// 0 = never changed on this device: any real change elsewhere must win over it.
			updatedAt: localUpdatedAt,
			updatedBy: deviceName,
			settings: pickShared(local),
		};
		await remote.dav.ensureDir(SYNC_DIR);
		await remote.dav.put(PATH, JSON.stringify(file, null, 1), { contentType: "application/json" });
		return { action: "pushed", updatedAt: file.updatedAt };
	}
	return { action: "none" };
}
