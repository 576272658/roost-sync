/**
 * Which files under the Obsidian config folder are synced (design doc §4).
 *
 * Paths are canonical: the config folder is always called ".obsidian" in the
 * manifest and on the server, whatever `vault.configDir` is on a device.
 */
// Canonical name in the manifest and on the server; VaultFs maps it to this device's vault.configDir.
export const CONFIG_DIR = ".obsidian";
export const SELF_ID = "roost-sync";

export interface ConfigSyncOptions {
	enabled: boolean;
	/** plugins/<id>/** (code and settings) */
	plugins: boolean;
	/** community-plugins.json, core-plugins.json (which plugins are enabled) */
	pluginList: boolean;
	/** appearance.json, themes/, snippets/ */
	appearance: boolean;
	hotkeys: boolean;
	/** app.json and core plugin settings (daily-notes.json, templates.json, bookmarks.json, …) */
	app: boolean;
	graph: boolean;
}

export const DEFAULT_CONFIG_SYNC: ConfigSyncOptions = {
	enabled: true,
	plugins: true,
	pluginList: true,
	appearance: true,
	hotkeys: true,
	app: true,
	graph: false,
};

/** Rewritten on every launch or layout change; syncing them only produces conflicts. */
const NEVER_TOP = new Set(["workspace.json", "workspace-mobile.json"]);

const PLUGIN_LIST = new Set(["community-plugins.json", "core-plugins.json", "core-plugins-migration.json"]);

export function isConfigPath(path: string): boolean {
	return path === CONFIG_DIR || path.startsWith(CONFIG_DIR + "/");
}

export function configFileAllowed(path: string, o: ConfigSyncOptions): boolean {
	if (!o.enabled || !path.startsWith(CONFIG_DIR + "/")) return false;
	const parts = path.slice(CONFIG_DIR.length + 1).split("/");
	if (parts.length === 1) {
		const f = parts[0];
		if (!f.endsWith(".json") || NEVER_TOP.has(f)) return false;
		if (PLUGIN_LIST.has(f)) return o.pluginList;
		if (f === "appearance.json") return o.appearance;
		if (f === "hotkeys.json") return o.hotkeys;
		if (f === "graph.json") return o.graph;
		return o.app;
	}
	// Never this plugin's own folder: data.json holds the password and device id, state/ is per device.
	if (parts[0] === "plugins") return o.plugins && parts.length >= 3 && parts[1] !== SELF_ID;
	if (parts[0] === "themes" || parts[0] === "snippets") return o.appearance;
	return false;
}

/** Whether a folder under the config dir can contain synced files (used to prune listings). */
export function configDirMayContain(dir: string, o: ConfigSyncOptions): boolean {
	if (!o.enabled) return false;
	if (dir === CONFIG_DIR) return true;
	const parts = dir.slice(CONFIG_DIR.length + 1).split("/");
	if (parts[0] === "plugins") return o.plugins && (parts.length === 1 || parts[1] !== SELF_ID);
	if (parts[0] === "themes" || parts[0] === "snippets") return o.appearance;
	return false;
}

/** Changes to these need an Obsidian restart to take effect. */
export function needsRestart(path: string): boolean {
	if (!isConfigPath(path)) return false;
	const rel = path.slice(CONFIG_DIR.length + 1);
	return rel.startsWith("plugins/") || PLUGIN_LIST.has(rel) || rel === "app.json" || rel === "appearance.json" || rel === "hotkeys.json" || rel.startsWith("themes/");
}
