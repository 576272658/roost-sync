export interface HttpRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: ArrayBuffer | string;
}

export interface HttpResponse {
	status: number;
	/** Header names are lower-cased. */
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text: string;
}

/**
 * The plugin uses Obsidian's requestUrl (no CORS, works on mobile);
 * tests use fetch. Both are adapted to this shape.
 */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export function lowerCaseHeaders(h: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
	return out;
}

export const fetchTransport: HttpTransport = async (req) => {
	const res = await fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body,
	});
	const buf = await res.arrayBuffer();
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
	return {
		status: res.status,
		headers,
		arrayBuffer: buf,
		text: new TextDecoder().decode(buf),
	};
};
