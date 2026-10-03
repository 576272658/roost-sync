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
