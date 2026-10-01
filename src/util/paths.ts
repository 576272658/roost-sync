export const DEFAULT_IGNORES = [
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	"*.sync-conflict-*",
	"~$*",
	"_remotely-save-metadata-on-remote.*",
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

	constructor(patterns: string[], private ignoreDotPaths = true) {
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
		if (this.ignoreDotPaths && path.split("/").some((s) => s.startsWith("."))) return true;
		return this.matchers.some((m) => m(path));
	}
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** Returns a reason if `path` cannot be stored on Windows, else null. */
export function windowsNameProblem(path: string): string | null {
	for (const seg of path.split("/")) {
		if (WIN_BAD_CHARS.test(seg)) return `"${seg}" contains a character Windows does not allow (\\ : * ? " < > |)`;
		if (/[. ]$/.test(seg)) return `"${seg}" ends with a dot or space`;
		if (WIN_RESERVED.test(seg)) return `"${seg}" is a reserved name on Windows`;
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
