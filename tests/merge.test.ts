import { describe, expect, it } from "vitest";
import { assemble, conflictCount, decodeText, encodeText, mergeText } from "../src/sync/merge";

const base = "# 标题\n\n第一段，原文。\n\n第二段，原文。\n\n第三段，原文。\n";

describe("mergeText", () => {
	it("merges edits to different paragraphs without conflicts", () => {
		const local = base.replace("第一段，原文。", "第一段，本机改过。");
		const remote = base.replace("第三段，原文。", "第三段，服务器改过。") + "\n新增的结尾。\n";
		const chunks = mergeText(local, base, remote);
		expect(conflictCount(chunks)).toBe(0);
		expect(assemble(chunks)).toBe(local.replace("第三段，原文。", "第三段，服务器改过。") + "\n新增的结尾。\n");
	});

	it("keeps lines intact (never splits words onto separate lines)", () => {
		const b = "alpha beta gamma\n\ndelta epsilon\n";
		const l = "alpha beta gamma CHANGED\n\ndelta epsilon\n";
		const r = "alpha beta gamma\n\ndelta epsilon zeta\n";
		expect(assemble(mergeText(l, b, r))).toBe("alpha beta gamma CHANGED\n\ndelta epsilon zeta\n");
	});

	it("treats edits to adjacent lines as a conflict (like git)", () => {
		expect(conflictCount(mergeText("a1\nb\n", "a\nb\n", "a\nb1\n"))).toBe(1);
	});

	it("reports a conflict when both sides change the same line, and resolves it per hunk", () => {
		const local = base.replace("第二段，原文。", "第二段，本机版本。");
		const remote = base.replace("第二段，原文。", "第二段，服务器版本。");
		const chunks = mergeText(local, base, remote);
		expect(conflictCount(chunks)).toBe(1);
		expect(assemble(chunks, ["local"])).toBe(local);
		expect(assemble(chunks, ["remote"])).toBe(remote);
		expect(assemble(chunks, ["localFirst"])).toBe(base.replace("第二段，原文。", "第二段，本机版本。\n第二段，服务器版本。"));
		expect(assemble(chunks, ["remoteFirst"])).toBe(base.replace("第二段，原文。", "第二段，服务器版本。\n第二段，本机版本。"));
	});

	it("treats the same change on both sides as no conflict", () => {
		const both = base.replace("第一段，原文。", "第一段，一样的修改。");
		expect(conflictCount(mergeText(both, base, both))).toBe(0);
		expect(assemble(mergeText(both, base, both))).toBe(both);
	});

	it("handles files without a trailing newline and appends on both sides", () => {
		const b = "a\nb";
		const chunks = mergeText("a\nb\nfrom local", b, "a\nb\nfrom server");
		expect(conflictCount(chunks)).toBe(1);
		expect(assemble(chunks)).toBe("a\nb\nfrom local\nfrom server");
	});

	it("round-trips text including a BOM and rejects invalid UTF-8", () => {
		const t = "﻿中文\r\nline\n";
		expect(decodeText(encodeText(t))).toBe(t);
		expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0xd8]).buffer)).toBeNull();
	});
});
