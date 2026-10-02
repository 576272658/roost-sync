import { L } from "../i18n";
import { configDirMayContain, configFileAllowed, isConfigPath, type ConfigSyncOptions } from "../sync/config";
export const DEFAULT_IGNORES = [
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	"*.sync-conflict-*",
	"~$*",
	"_remotely-save-metadata-on-remote.*",
	// Being replaced by Roost Sync; its settings hold its own server credentials.
	".obsidian/plugins/remotely-save/",
];

export function normalizePath(p: string): string {
	return p.normalize("NFC");
}

function globToRegex(glob: string): string {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return re;
}

/**
 * Gitignore-like rules, one per line:
 *  - `name` or `*.ext` (no slash): matches any path segment (file or folder)
 *  - `dir/sub/` or `dir/*.md` (with slash): anchored at the vault root
 *  - `/regex/`: a JavaScript regex tested against the full path
 *  - `#` starts a comment
 */
export class IgnoreRules {
	private matchers: ((path: string) => boolean)[] = [];

	/**
	 * @param config which files under `.obsidian/` to sync; other dot-paths are always ignored.
	 */
	constructor(patterns: string[], private config: ConfigSyncOptions | null = null) {
		for (const raw of patterns) {
			const p = raw.trim();
			if (!p || p.startsWith("#")) continue;
			if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
				try {
					const re = new RegExp(p.slice(1, -1));
					this.matchers.push((path) => re.test(path));
				} catch {
					/* invalid regex: ignore the rule */
				}
				continue;
			}
			const dirOnly = p.endsWith("/");
			const body = dirOnly ? p.slice(0, -1) : p;
			if (!body.includes("/")) {
				const re = new RegExp("^" + globToRegex(body) + "$");
				this.matchers.push((path) => {
					const segs = path.split("/");
					const candidates = dirOnly ? segs.slice(0, -1) : segs;
					return candidates.some((s) => re.test(s));
				});
			} else {
				const re = new RegExp("^" + globToRegex(body.replace(/^\/+/, "")) + "(/.*)?$");
				this.matchers.push((path) => re.test(path));
			}
		}
	}

	isIgnored(path: string): boolean {
		if (isConfigPath(path)) {
			if (!this.config || !configFileAllowed(path, this.config)) return true;
			return this.matchers.some((m) => m(path));
		}
		if (path.split("/").some((s) => s.startsWith("."))) return true;
		return this.matchers.some((m) => m(path));
	}

	/** For directory listings: false if nothing below `dir` can be synced. */
	isIgnoredDir(dir: string): boolean {
		if (isConfigPath(dir)) {
			if (!this.config || !configDirMayContain(dir, this.config)) return true;
			return this.matchers.some((m) => m(dir + "/"));
		}
		return this.isIgnored(dir);
	}
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** Returns a reason if `path` cannot be stored on Windows, else null. */
export function windowsNameProblem(path: string): string | null {
	for (const seg of path.split("/")) {
		if (WIN_BAD_CHARS.test(seg)) return L(`"${seg}" contains a character Windows does not allow (\\ : * ? " < > |)`, `「${seg}」含有 Windows 不允许的字符（\\ : * ? " < > |）`);
		if (/[. ]$/.test(seg)) return L(`"${seg}" ends with a dot or space`, `「${seg}」以点或空格结尾`);
		if (WIN_RESERVED.test(seg)) return L(`"${seg}" is a reserved name on Windows`, `「${seg}」是 Windows 的保留名`);
	}
	return null;
}

/** Groups of paths that differ only by letter case. */
export function caseCollisions(paths: Iterable<string>): string[][] {
	const groups = new Map<string, string[]>();
	for (const p of paths) {
		const k = p.toLowerCase();
		const g = groups.get(k);
		if (g) g.push(p);
		else groups.set(k, [p]);
	}
	return [...groups.values()].filter((g) => g.length > 1);
}
