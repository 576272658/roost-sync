import { diff3Merge } from "node-diff3";

/**
 * Three-way merge of notes (design doc §5.8). Works on whole lines: node-diff3 splits
 * strings on whitespace by default, which merges word by word and mangles prose, so
 * lines are passed as arrays.
 */

/** Notes larger than this are never merged (and their base text is not kept). */
export const MERGE_MAX_BYTES = 2 * 1024 * 1024;

export function isMergeable(path: string): boolean {
	return /\.md$/i.test(path);
}

export type MergeChunk = { ok: string[] } | { conflict: { local: string[]; base: string[]; remote: string[] } };

/** How to resolve one conflicting hunk. */
export type HunkChoice = "local" | "remote" | "localFirst" | "remoteFirst";

/** "a\nb\n" → ["a", "b", ""]; joining with "\n" gives back the exact text. */
const lines = (text: string) => text.split("\n");

export function mergeText(local: string, base: string, remote: string): MergeChunk[] {
	const out: MergeChunk[] = [];
	for (const r of diff3Merge<string>(lines(local), lines(base), lines(remote))) {
		if (r.conflict) out.push({ conflict: { local: r.conflict.a, base: r.conflict.o, remote: r.conflict.b } });
		else if (r.ok) {
			const last = out[out.length - 1];
			if (last && "ok" in last) last.ok.push(...r.ok);
			else out.push({ ok: [...r.ok] });
		}
	}
	return out;
}

export function conflictCount(chunks: MergeChunk[]): number {
	return chunks.filter((c) => "conflict" in c).length;
}

/** Builds the merged text. `choices[i]` resolves the i-th conflicting hunk (default: keep both, this device first). */
export function assemble(chunks: MergeChunk[], choices: HunkChoice[] = []): string {
	const out: string[] = [];
	let i = 0;
	for (const c of chunks) {
		if ("ok" in c) {
			out.push(...c.ok);
			continue;
		}
		const { local, remote } = c.conflict;
		switch (choices[i++] ?? "localFirst") {
			case "local":
				out.push(...local);
				break;
			case "remote":
				out.push(...remote);
				break;
			case "localFirst":
				out.push(...local, ...remote);
				break;
			case "remoteFirst":
				out.push(...remote, ...local);
				break;
		}
	}
	return out.join("\n");
}

/** Decodes UTF-8 strictly, keeping a BOM; null for binary or invalid text. */
export function decodeText(data: ArrayBuffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
	} catch {
		return null;
	}
}

export function encodeText(text: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(text);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}
