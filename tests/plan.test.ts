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

describe("rename detection (§5.7)", () => {
	const plan = (o: Partial<Parameters<typeof planSync>[0]>) =>
		planSync({ local: {}, base: {}, manifest: manifest(), joinMode: false, skip: () => false, ...o });

	it("renamed here → one server-side move, not risky", () => {
		const a = plan({
			local: { "new/a.md": loc("x") },
			base: { "old/a.md": { hash: H("x"), rev: 1 } },
			manifest: manifest({ "old/a.md": file("x") }),
		});
		expect(a).toHaveLength(1);
		expect(a[0]).toMatchObject({ kind: "moveRemote", from: "old/a.md", path: "new/a.md" });
		expect(summarize(a)).toMatchObject({ move: 1, risky: 0 });
	});

	it("renamed elsewhere → one local move, no download", () => {
		const a = plan({
			local: { "old/a.md": loc("x") },
			base: { "old/a.md": { hash: H("x"), rev: 1 } },
			manifest: manifest({ "new/a.md": file("x", 2) }, { "old/a.md": tomb("x") }),
		});
		expect(a).toHaveLength(1);
		expect(a[0]).toMatchObject({ kind: "moveLocal", from: "old/a.md", path: "new/a.md" });
	});

	it("rename + edit stays delete + add", () => {
		const a = plan({
			local: { "new.md": loc("y") },
			base: { "old.md": { hash: H("x"), rev: 1 } },
			manifest: manifest({ "old.md": file("x") }),
		});
		expect(a.map((x) => x.kind).sort()).toEqual(["deleteRemote", "push"]);
	});

	it("case-only rename is not a move", () => {
		const a = plan({
			local: { "A.md": loc("x") },
			base: { "a.md": { hash: H("x"), rev: 1 } },
			manifest: manifest({ "a.md": file("x") }),
		});
		expect(a.map((x) => x.kind).sort()).toEqual(["deleteRemote", "push"]);
	});

	it("prefers the candidate with the same file name", () => {
		const a = plan({
			local: { "z/two.md": loc("x") },
			base: { "a/one.md": { hash: H("x"), rev: 1 }, "b/two.md": { hash: H("x"), rev: 1 } },
			manifest: manifest({ "a/one.md": file("x"), "b/two.md": file("x") }),
		});
		expect(a.find((x) => x.kind === "moveRemote")?.from).toBe("b/two.md");
	});
});

describe("config files", () => {
	const isConfig = (p: string) => p.startsWith(".obsidian/");
	const P = ".obsidian/app.json";
	const mk = (L: { hash: string; mtime: number }, R: { hash: string; mtime: number }, withBase: boolean) =>
		planSync({
			local: { [P]: { hash: L.hash, size: 1, mtime: L.mtime } },
			base: withBase ? { [P]: { hash: H("base"), rev: 1 } } : {},
			manifest: manifest({ [P]: { hash: R.hash, size: 1, mtime: R.mtime, rev: 2, by: "x" } }),
			joinMode: false,
			skip: () => false,
			isConfig,
		})[0];

	it("conflict: this device newer → keep local, archive server copy", () => {
		expect(mk({ hash: H("l"), mtime: 20 }, { hash: H("r"), mtime: 10 }, true)).toMatchObject({ kind: "push", archive: "remote", autoResolved: true });
	});
	it("conflict: server newer → pull, archive local copy", () => {
		expect(mk({ hash: H("l"), mtime: 10 }, { hash: H("r"), mtime: 20 }, true)).toMatchObject({ kind: "pull", archive: "local", autoResolved: true });
	});
	it("conflict without history → server wins", () => {
		expect(mk({ hash: H("l"), mtime: 99 }, { hash: H("r"), mtime: 1 }, false)).toMatchObject({ kind: "pull", autoResolved: true });
	});
	it("join mode: config file only here defaults to delete", () => {
		const a = planSync({ local: { ".obsidian/plugins/old/main.js": loc("x") }, base: {}, manifest: manifest(), joinMode: true, skip: () => false, isConfig });
		expect(a[0]).toMatchObject({ kind: "ask", defaultChoice: "deleteLocal" });
	});
});

describe("messages follow the language setting", () => {
	it("Chinese and English reasons", async () => {
		const { setLanguage } = await import("../src/i18n");
		const run = () => planSync({ local: { "a.md": loc("a") }, base: {}, manifest: manifest(), joinMode: false, skip: () => false })[0].reason;
		setLanguage("zh");
		expect(run()).toBe("本机新建");
		setLanguage("en");
		expect(run()).toBe("new here");
	});
});

describe("note merging (§5.8)", () => {
	const input = (extra: Partial<Parameters<typeof planSync>[0]> = {}) => ({
		local: { "a.md": loc("l") },
		base: { "a.md": { hash: H("b"), rev: 1 } },
		manifest: manifest({ "a.md": file("r", 2) }),
		joinMode: false,
		skip: () => false,
		...extra,
	});

	it("changed on both sides with a known base → merge", () => {
		const a = planSync(input({ canMerge: () => true }));
		expect(a.map((x) => x.kind)).toEqual(["merge"]);
		expect(summarize(a)).toMatchObject({ merge: 1, conflict: 0, risky: 0 });
	});

	it("without base text → conflict as before", () => {
		expect(planSync(input({ canMerge: () => false }))[0].kind).toBe("conflict");
		expect(planSync(input())[0].kind).toBe("conflict");
	});

	it("config files are never merged", () => {
		const a = planSync({
			...input({ canMerge: () => true }),
			local: { ".obsidian/x.md": loc("l") },
			base: { ".obsidian/x.md": { hash: H("b"), rev: 1 } },
			manifest: manifest({ ".obsidian/x.md": file("r", 2) }),
			isConfig: (p) => p.startsWith(".obsidian/"),
		});
		expect(a[0].kind).toBe("pull");
	});

	it("a merge made in the conflict window is applied while both sides are unchanged", () => {
		const res = { "a.md": { choice: "merged" as const, remoteHash: H("r"), localHash: H("l"), mergedHash: H("m") } };
		const a = planSync(input({ resolutions: res }));
		expect(a[0]).toMatchObject({ kind: "merge", mergedHash: H("m") });
		const stale = planSync(input({ resolutions: { "a.md": { ...res["a.md"], localHash: H("older") } } }));
		expect(stale[0].kind).toBe("conflict");
	});
});
