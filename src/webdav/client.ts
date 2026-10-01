import { XMLParser } from "fast-xml-parser";
import type { HttpResponse, HttpTransport } from "./transport";

export class WebDavError extends Error {
	constructor(
		public method: string,
		public path: string,
		public status: number,
		detail = "",
	) {
		super(`${method} ${path || "/"} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
	}
}

export class PreconditionFailedError extends Error {
	constructor(method: string, path: string) {
		super(`${method} ${path}: changed on the server in the meantime (HTTP 412)`);
	}
}

/** ETags are stored without quotes or the weak prefix: `W/"abc"` → `abc`. */
export function normEtag(e: string | undefined | null): string | undefined {
	if (!e) return undefined;
	return e.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1") || undefined;
}

const quoteEtag = (e: string) => (e === "*" ? e : `"${normEtag(e)}"`);

export interface DavEntry {
	/** Path relative to the client root, decoded, no leading/trailing slash. */
	path: string;
	isDir: boolean;
	size: number;
	mtime: number;
	etag?: string;
}

export interface GetResult {
	status: 200 | 304 | 404;
	data?: ArrayBuffer;
	etag?: string;
	lastModified?: number;
	/** Server clock (Date header), used to space out writes. */
	serverDate?: number;
}

export interface PutOptions {
	ifMatch?: string;
	ifNoneMatch?: string;
	contentType?: string;
}

const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?>' +
	'<d:propfind xmlns:d="DAV:"><d:prop>' +
	"<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>" +
	"</d:prop></d:propfind>";

export function encodePath(path: string): string {
	return path
		.split("/")
		.filter((s) => s.length > 0)
		.map(encodeURIComponent)
		.join("/");
}

function basicAuth(user: string, pass: string): string {
	const bytes = new TextEncoder().encode(`${user}:${pass}`);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return "Basic " + btoa(bin);
}

function parseHttpDate(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const t = Date.parse(s);
	return Number.isNaN(t) ? undefined : t;
}

/**
 * Minimal WebDAV client. All paths are relative to `rootUrl`
 * (server URL + remote folder), '/'-separated and unencoded.
 */
export class WebDavClient {
	readonly rootUrl: string;
	private rootPath: string;
	private serverBase: string;
	private folderSegments: string[];
	private auth?: string;
	private knownDirs = new Set<string>([""]);

	constructor(
		private transport: HttpTransport,
		serverUrl: string,
		remoteFolder: string,
		user?: string,
		pass?: string,
	) {
		let base = serverUrl.trim();
		if (!base.endsWith("/")) base += "/";
		this.serverBase = base;
		this.folderSegments = remoteFolder.split("/").filter(Boolean);
		const folder = encodePath(remoteFolder);
		this.rootUrl = folder ? `${base}${folder}/` : base;
		this.rootPath = decodeURIComponent(new URL(this.rootUrl).pathname);
		if (user) this.auth = basicAuth(user, pass ?? "");
	}

	url(path: string, isDir = false): string {
		const enc = encodePath(path);
		return this.rootUrl + enc + (isDir && enc ? "/" : "");
	}

	private async send(
		method: string,
		path: string,
		opts: { headers?: Record<string, string>; body?: ArrayBuffer | string; isDir?: boolean } = {},
	): Promise<HttpResponse> {
		const headers: Record<string, string> = { ...(opts.headers ?? {}) };
		if (this.auth) headers["Authorization"] = this.auth;
		return this.transport({
			url: this.url(path, opts.isDir),
			method,
			headers,
			body: opts.body,
		});
	}

	private fail(method: string, path: string, res: HttpResponse): never {
		const detail = res.status === 401 ? "authentication failed" : "";
		throw new WebDavError(method, path, res.status, detail);
	}

	/** Lists a directory (depth 1 / infinity, without the directory itself) or stats one entry (depth 0). */
	async propfind(path: string, depth: 0 | 1 | "infinity" = 1): Promise<DavEntry[] | null> {
		const res = await this.send("PROPFIND", path, {
			isDir: depth !== 0,
			headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
			body: PROPFIND_BODY,
		});
		if (res.status === 404) return null;
		if (res.status !== 207) this.fail("PROPFIND", path, res);
		const entries = this.parseMultistatus(res.text);
		const self = path.replace(/^\/+|\/+$/g, "");
		return depth !== 0 ? entries.filter((e) => e.path !== self) : entries;
	}

	parseMultistatus(xml: string): DavEntry[] {
		const parser = new XMLParser({
			removeNSPrefix: true,
			ignoreAttributes: true,
			parseTagValue: false,
			isArray: (name) => name === "response" || name === "propstat",
		});
		const doc = parser.parse(xml);
		const responses: any[] = doc?.multistatus?.response ?? [];
		const out: DavEntry[] = [];
		for (const r of responses) {
			let href = String(r.href ?? "");
			try {
				if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
				href = decodeURIComponent(href);
			} catch {
				continue;
			}
			if (!href.startsWith(this.rootPath)) {
				// Some servers return hrefs without the trailing slash of the root.
				if (href + "/" === this.rootPath) href = this.rootPath;
				else continue;
			}
			const rel = href.slice(this.rootPath.length).replace(/^\/+|\/+$/g, "");
			const ok = (r.propstat as any[]).find((p) => String(p.status ?? "").includes(" 200"));
			const prop = ok?.prop ?? {};
			const isDir = prop.resourcetype != null && typeof prop.resourcetype === "object" && "collection" in prop.resourcetype;
			out.push({
				path: rel.normalize("NFC"),
				isDir,
				size: Number(prop.getcontentlength ?? 0) || 0,
				mtime: parseHttpDate(prop.getlastmodified) ?? 0,
				etag: normEtag(prop.getetag != null ? String(prop.getetag) : undefined),
			});
		}
		return out;
	}

	/** Recursively lists all files below `path` (Depth: 1 walk; Depth: infinity is often disabled). */
	async walk(path: string, skipDir: (p: string) => boolean = () => false): Promise<DavEntry[]> {
		const files: DavEntry[] = [];
		const queue = [path];
		while (queue.length) {
			const dir = queue.shift()!;
			const entries = await this.propfind(dir, 1);
			if (!entries) continue;
			for (const e of entries) {
				if (e.isDir) {
					this.knownDirs.add(e.path);
					if (!skipDir(e.path)) queue.push(e.path);
				} else files.push(e);
			}
		}
		return files;
	}

	/**
	 * Every file below `path` in one `PROPFIND Depth: infinity` request, falling back to a
	 * Depth: 1 walk when the server refuses infinite depth. Null if `path` does not exist.
	 */
	async listTree(path: string, skipDir: (p: string) => boolean = () => false): Promise<DavEntry[] | null> {
		let all: DavEntry[] | null;
		try {
			all = await this.propfind(path, "infinity");
		} catch (e) {
			if (e instanceof WebDavError && (e.status === 403 || e.status === 400 || e.status === 501)) {
				if ((await this.propfind(path, 0)) === null) return null;
				return this.walk(path, skipDir);
			}
			throw e;
		}
		if (all === null) return null;
		const skipped = all.filter((e) => e.isDir && skipDir(e.path)).map((e) => e.path + "/");
		for (const e of all) if (e.isDir) this.knownDirs.add(e.path);
		return all.filter((e) => !e.isDir && !skipped.some((d) => e.path.startsWith(d)));
	}

	async get(path: string, ifNoneMatch?: string): Promise<GetResult> {
		const headers: Record<string, string> = { "Cache-Control": "no-cache" };
		if (ifNoneMatch) headers["If-None-Match"] = quoteEtag(ifNoneMatch);
		const res = await this.send("GET", path, { headers });
		const meta = {
			etag: normEtag(res.headers["etag"]),
			lastModified: parseHttpDate(res.headers["last-modified"]),
			serverDate: parseHttpDate(res.headers["date"]),
		};
		if (res.status === 404) return { status: 404, ...meta };
		if (res.status === 304) return { status: 304, ...meta };
		if (res.status !== 200) this.fail("GET", path, res);
		return { status: 200, data: res.arrayBuffer, ...meta };
	}

	async getText(path: string): Promise<string | null> {
		const r = await this.get(path);
		return r.status === 200 ? new TextDecoder().decode(r.data!) : null;
	}

	/** Returns "ok", or "precondition-failed" (HTTP 412) when a condition header fails. */
	async put(path: string, body: ArrayBuffer | string, opts: PutOptions = {}): Promise<"ok" | "precondition-failed"> {
		return (await this.putEx(path, body, opts)).status;
	}

	/** Like put(), also returning the new ETag when the server sends one. */
	async putEx(
		path: string,
		body: ArrayBuffer | string,
		opts: PutOptions = {},
	): Promise<{ status: "ok" | "precondition-failed"; etag?: string }> {
		const headers: Record<string, string> = {
			"Content-Type": opts.contentType ?? "application/octet-stream",
		};
		if (opts.ifMatch) headers["If-Match"] = quoteEtag(opts.ifMatch);
		if (opts.ifNoneMatch) headers["If-None-Match"] = quoteEtag(opts.ifNoneMatch);
		let res = await this.send("PUT", path, { headers, body });
		if (res.status === 409) {
			// Parent missing: create it and retry once.
			await this.ensureDir(parentOf(path), true);
			res = await this.send("PUT", path, { headers, body });
		}
		if (res.status === 412) return { status: "precondition-failed" };
		if (res.status >= 200 && res.status < 300) return { status: "ok", etag: normEtag(res.headers["etag"]) };
		this.fail("PUT", path, res);
	}

	private pendingDirs = new Map<string, Promise<void>>();

	/** Creates one directory. Concurrent calls for the same path share one request. */
	async mkcol(path: string): Promise<void> {
		const inflight = this.pendingDirs.get(path);
		if (inflight) return inflight;
		const p = (async () => {
			const res = await this.send("MKCOL", path, { isDir: true });
			// 201 created, 405 already exists. WsgiDAV answers 500 when two MKCOLs race; check.
			if (res.status !== 201 && res.status !== 405) {
				const st = await this.propfind(path, 0).catch(() => null);
				if (!st?.[0]?.isDir) this.fail("MKCOL", path, res);
			}
			this.knownDirs.add(path);
		})();
		this.pendingDirs.set(path, p);
		try {
			await p;
		} finally {
			this.pendingDirs.delete(path);
		}
	}

	/** Creates the remote folder itself (and its parents) if missing. */
	async ensureRoot(): Promise<void> {
		let url = this.serverBase;
		for (const seg of this.folderSegments) {
			url += encodeURIComponent(seg) + "/";
			const headers: Record<string, string> = {};
			if (this.auth) headers["Authorization"] = this.auth;
			const res = await this.transport({ url, method: "MKCOL", headers });
			if (res.status !== 201 && res.status !== 405) throw new WebDavError("MKCOL", seg, res.status);
		}
	}

	/** Creates `path` and all missing ancestors. */
	async ensureDir(path: string, force = false): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!force && this.knownDirs.has(cur)) continue;
			await this.mkcol(cur);
		}
	}

	/** Deletes a file or directory. Missing targets are not an error. */
	async delete(path: string, isDir = false): Promise<void> {
		const res = await this.send("DELETE", path, { isDir });
		if (res.status === 404 || (res.status >= 200 && res.status < 300)) {
			if (isDir) {
				for (const d of [...this.knownDirs]) if (d === path || d.startsWith(path + "/")) this.knownDirs.delete(d);
			}
			return;
		}
		this.fail("DELETE", path, res);
	}

	/**
	 * Moves a file. Returns false if the source does not exist. Creates the destination's parent.
	 * With `ifMatch`, throws PreconditionFailedError if the source changed.
	 */
	async move(from: string, to: string, overwrite = true, ifMatch?: string): Promise<boolean> {
		await this.ensureDir(parentOf(to));
		const headers: Record<string, string> = { Destination: this.url(to), Overwrite: overwrite ? "T" : "F" };
		if (ifMatch) headers["If-Match"] = quoteEtag(ifMatch);
		let res = await this.send("MOVE", from, { headers });
		if (res.status === 409) {
			await this.ensureDir(parentOf(to), true);
			res = await this.send("MOVE", from, { headers });
		}
		if (res.status === 404) return false;
		if (res.status === 412) throw new PreconditionFailedError("MOVE", from);
		if (res.status >= 200 && res.status < 300) return true;
		this.fail("MOVE", from, res);
	}
}

export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}
