import { describe, expect, it } from "vitest";
import { needsPreview, planSync, summarize } from "../src/sync/plan";
import type { Manifest } from "../src/sync/types";

const H = (c: string) => `sha256:${c}`;
const file = (c: string, rev = 1) => ({ hash: H(c), size: 1, mtime: 1, rev, by: "x" });
const loc = (c: string) => ({ hash: H(c), size: 1, mtime: 1 });
const tomb = (c: string | null, rev = 2) => ({ hash: c === null ? null : H(c), deletedAt: 1, rev, by: "x" });

function manifest(files: Manifest["files"] = {}, tombstones: Manifest["tombstones"] = {}): Manifest {
	return { version: 1, id: "srv", rev: 5, updatedAt: 0, updatedBy: "x", files, tombstones };
}

function one(opts: {
	L?: string;
	B?: string;
	R?: string;
	T?: string | null;
	join?: boolean;
}) {
	const p = "a.md";
	const actions = planSync({
		local: opts.L ? { [p]: loc(opts.L) } : {},
		base: opts.B ? { [p]: { hash: H(opts.B), rev: 1 } } : {},
		manifest: manifest(opts.R ? { [p]: file(opts.R) } : {}, opts.T !== undefined ? { [p]: tomb(opts.T) } : {}),
		joinMode: !!opts.join,
		skip: () => false,
	});
	return actions.length ? `${actions[0].kind}${actions[0].ask ? ":" + actions[0].ask : ""}` : "none";
}

describe("decision table with base (§5.4)", () => {
	it.each([
		// local, server → action
		[{ L: "a", B: "a", R: "a" }, "none"],
		[{ L: "a", B: "a", R: "b" }, "pull"],
		[{ L: "a", B: "a", T: "a" }, "deleteLocal"],
		[{ L: "a", B: "a" }, "deleteLocal"], // tombstone already collected
		[{ L: "b", B: "a", R: "a" }, "push"],
		[{ L: "b", B: "a", R: "b" }, "markSynced"],
		[{ L: "b", B: "a", R: "c" }, "conflict"],
		[{ L: "b", B: "a", T: "a" }, "ask:resurrect"],
		[{ B: "a", R: "a" }, "deleteRemote"],
		[{ B: "a", R: "b" }, "pull"],
		[{ B: "a", T: "a" }, "dropBase"],
	])("%j → %s", (input, expected) => {
		expect(one(input)).toBe(expected);
	});
});

describe("decision table without base", () => {
	it.each([
		[{ L: "a", R: "a" }, "markSynced"],
		[{ L: "a", R: "b" }, "conflict"],
		[{ L: "a", T: "a" }, "deleteLocal"], // the stale-device fix
		[{ L: "a", T: "b" }, "ask:tombstoneDiffers"],
		[{ L: "a", T: null }, "ask:tombstoneDiffers"],
		[{ L: "a" }, "push"],
		[{ L: "a", join: true }, "ask:joinLocalOnly"],
		[{ R: "a" }, "pull"],
		[{ T: "a" }, "none"],
		[{ L: "a", T: "a", join: true }, "deleteLocal"],
	])("%j → %s", (input, expected) => {
		expect(one(input)).toBe(expected);
	});
});

describe("decisions and resolutions", () => {
	const base = { local: { "a.md": loc("new") }, base: {}, joinMode: true, skip: () => false };

	it("applies a matching decision", () => {
		const a = planSync({ ...base, manifest: manifest(), decisions: { "a.md": { choice: "push", hash: H("new") } } });
		expect(a[0].kind).toBe("push");
		expect(a[0].isNew).toBe(true);
	});

	it("ignores a decision made for different content", () => {
		const a = planSync({ ...base, manifest: manifest(), decisions: { "a.md": { choice: "push", hash: H("old") } } });
		expect(a[0].kind).toBe("ask");
	});

	it("skip leaves the file alone", () => {
		const a = planSync({ ...base, manifest: manifest(), decisions: { "a.md": { choice: "skip", hash: H("new") } } });
		expect(a).toHaveLength(0);
	});

	it("resurrect decision pushes over the tombstone", () => {
		const a = planSync({ ...base, manifest: manifest({}, { "a.md": tomb("old") }), decisions: { "a.md": { choice: "push", hash: H("new") } } });
		expect(a[0]).toMatchObject({ kind: "push", resurrect: true });
	});

	it("conflict resolution keeps local and archives remote", () => {
		const a = planSync({
			local: { "a.md": loc("mine") },
			base: {},
			manifest: manifest({ "a.md": file("theirs") }),
			joinMode: false,
			skip: () => false,
			resolutions: { "a.md": { choice: "local", remoteHash: H("theirs") } },
		});
		expect(a[0]).toMatchObject({ kind: "push", archive: "remote" });
	});

	it("stale resolution (server changed again) is a conflict again", () => {
		const a = planSync({
			local: { "a.md": loc("mine") },
			base: {},
			manifest: manifest({ "a.md": file("newer") }),
			joinMode: false,
			skip: () => false,
			resolutions: { "a.md": { choice: "remote", remoteHash: H("theirs") } },
		});
		expect(a[0].kind).toBe("conflict");
	});

	it("skipped paths are untouched even with base", () => {
		const a = planSync({
			local: {},
			base: { "big.pdf": { hash: H("a"), rev: 1 } },
			manifest: manifest({ "big.pdf": file("a") }),
			joinMode: false,
			skip: (p) => p === "big.pdf",
		});
		expect(a).toHaveLength(0);
	});
});

describe("threshold guard", () => {
	it("counts new pushes, deletions and resurrections", () => {
		const local: Record<string, ReturnType<typeof loc>> = {};
		for (let i = 0; i < 30; i++) local[`n${i}.md`] = loc(String(i));
		const actions = planSync({ local, base: {}, manifest: manifest(), joinMode: false, skip: () => false });
		expect(summarize(actions).risky).toBe(30);
		expect(needsPreview(actions, 100, 20, 10)).toBe(true);
		expect(needsPreview(actions, 1000, 20, 10)).toBe(false);
	});

	it("always previews resurrections", () => {
		const actions = planSync({
			local: { "a.md": loc("b") },
			base: { "a.md": { hash: H("a"), rev: 1 } },
			manifest: manifest({}, { "a.md": tomb("a") }),
			joinMode: false,
			skip: () => false,
		});
		expect(needsPreview(actions, 1000, 50, 100)).toBe(true);
	});
});
